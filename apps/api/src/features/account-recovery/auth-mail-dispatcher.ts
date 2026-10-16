import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import { AuthMailOutbox, sequelize } from "../../infrastructure/database/db";
import { LoginRateLimiter } from "../auth";
import { recoveryAddressFingerprint } from "./account-recovery-tokens";
import { readAuthMailConfig } from "./auth-mail-config";
import { decryptAuthMailContent } from "./auth-mail-crypto";
import { AUTH_MAIL_PROVIDER, type AuthMailProvider, type AuthMailSendResult } from "./auth-mail-provider";
import type { AuthMailContent } from "./auth-mail-templates";

type ClaimedMail = Readonly<{
  mailId: string;
  tenantId: string;
  userId: string;
  tokenId: string | null;
  purpose: string;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  authTag: Buffer | null;
  keyVersion: number;
  attemptCount: number;
  expiresAt: Date | null;
}>;

type LiveMailTarget = Readonly<{
  status: string;
  membershipStatus: string;
  tokenPurpose: string | null;
  tokenConsumedAt: Date | null;
  tokenRevokedAt: Date | null;
  tokenExpiresAt: Date | null;
  tokenRevision: number | null;
  currentCredentialRevision: number;
  recoveryEmailRevision: number;
  tokenEmailRevision: number | null;
  pendingEmailRevision: number | null;
  currentPendingEmailRevision: number;
  emailNormalized: string | null;
  pendingEmailNormalized: string | null;
  recipientFingerprint: string | null;
}>;

const dispatcherLeaseMs = 30_000;
const maxAttempts = 8;
const terminalMailRetentionMs = 30 * 24 * 60 * 60_000;
const recoveryTokenRetentionMs = 90 * 24 * 60 * 60_000;

function retryDelay(attempt: number, providerDelay?: number): number {
  if (providerDelay) return Math.min(15 * 60_000, Math.max(1_000, providerDelay * 1000));
  const base = Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

@Injectable()
export class AuthMailDispatcher implements OnModuleInit, OnModuleDestroy {
  private stopped = false;
  private loopPromise?: Promise<void>;
  private wakeWaiter?: () => void;
  private lastCleanupAt = 0;
  private readonly owner = randomUUID();

  constructor(
    @Inject(AUTH_MAIL_PROVIDER) private readonly provider: AuthMailProvider,
    @Inject(LoginRateLimiter) private readonly rateLimiter: LoginRateLimiter,
  ) {}

  onModuleInit(): void {
    if (!readAuthMailConfig().enabled) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.wakeWaiter?.();
    await this.loopPromise;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWaiter = undefined;
        resolve();
      }, ms);
      this.wakeWaiter = () => {
        clearTimeout(timer);
        this.wakeWaiter = undefined;
        resolve();
      };
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!(await this.dispatchOne())) await this.wait(1_000);
      } catch {
        await this.wait(2_000);
      }
    }
  }

  private async claim(): Promise<ClaimedMail | null> {
    const now = new Date();
    return sequelize.transaction(async (transaction: Transaction) => {
      const rows = await sequelize.query<ClaimedMail>(
        `WITH candidate AS (
           SELECT mail_id FROM auth_mail_outbox
            WHERE ((status = 'pending' AND next_attempt_at <= :now)
               OR (status = 'processing' AND lease_until <= :now))
            ORDER BY next_attempt_at, created_at, mail_id
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE auth_mail_outbox o SET status = 'processing', attempt_count = attempt_count + 1,
           lease_until = :leaseUntil, lease_owner = :owner
          FROM candidate c WHERE o.mail_id = c.mail_id
         RETURNING o.mail_id AS "mailId", o.tenant_id AS "tenantId", o.user_id AS "userId",
           o.token_id AS "tokenId", o.purpose, o.payload_ciphertext AS ciphertext,
           o.payload_nonce AS nonce, o.payload_auth_tag AS "authTag", o.key_version AS "keyVersion",
           o.attempt_count AS "attemptCount", o.expires_at AS "expiresAt"`,
        {
          replacements: { now, leaseUntil: new Date(now.getTime() + dispatcherLeaseMs), owner: this.owner },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      return rows[0] ?? null;
    });
  }

  private async cleanupOldRecords(now: Date): Promise<void> {
    if (now.getTime() - this.lastCleanupAt < 60 * 60_000) return;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `DELETE FROM auth_mail_outbox
          WHERE status IN ('submitted', 'failed', 'cancelled')
            AND payload_ciphertext IS NULL AND created_at < :mailCutoff`,
        { replacements: { mailCutoff: new Date(now.getTime() - terminalMailRetentionMs) }, transaction },
      );
      await sequelize.query(
        `DELETE FROM account_recovery_tokens t
          WHERE (t.expires_at < :tokenCutoff OR t.consumed_at < :tokenCutoff OR t.revoked_at < :tokenCutoff)
            AND NOT EXISTS (SELECT 1 FROM auth_mail_outbox o WHERE o.token_id = t.token_id AND o.status IN ('pending', 'processing'))`,
        { replacements: { tokenCutoff: new Date(now.getTime() - recoveryTokenRetentionMs) }, transaction },
      );
    });
    this.lastCleanupAt = now.getTime();
  }

  private async targetIsCurrent(mail: ClaimedMail, now: Date): Promise<boolean> {
    if (mail.expiresAt && mail.expiresAt.getTime() <= now.getTime()) return false;
    if (mail.purpose === "password_reset" || mail.purpose === "email_verify") {
      if (!mail.tokenId || !mail.expiresAt || mail.expiresAt.getTime() - now.getTime() < 2 * 60_000) return false;
    }
    const rows = await sequelize.query<LiveMailTarget>(
      `SELECT u.status, m.status AS "membershipStatus", u.credential_revision AS "currentCredentialRevision",
              u.recovery_email_revision AS "recoveryEmailRevision", u.recovery_email_normalized AS "emailNormalized",
              u.pending_recovery_email_normalized AS "pendingEmailNormalized",
              u.pending_recovery_email_revision AS "currentPendingEmailRevision",
              t.purpose AS "tokenPurpose", t.consumed_at AS "tokenConsumedAt", t.revoked_at AS "tokenRevokedAt",
              t.expires_at AS "tokenExpiresAt", t.credential_revision AS "tokenRevision",
              t.recovery_email_revision AS "tokenEmailRevision", t.pending_email_revision AS "pendingEmailRevision",
              t.recipient_fingerprint AS "recipientFingerprint"
         FROM users u JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
         LEFT JOIN account_recovery_tokens t ON t.token_id = :tokenId
        WHERE u.user_id = :userId`,
      {
        replacements: { tenantId: mail.tenantId, userId: mail.userId, tokenId: mail.tokenId },
        type: QueryTypes.SELECT,
      },
    );
    const row = rows[0];
    if (!row || row.status !== "active" || row.membershipStatus !== "active") return false;
    if (!mail.tokenId) return true;
    if (
      !row.tokenPurpose ||
      row.tokenPurpose !== mail.purpose ||
      row.tokenConsumedAt ||
      row.tokenRevokedAt ||
      !row.tokenExpiresAt ||
      new Date(row.tokenExpiresAt).getTime() <= now.getTime() ||
      row.tokenRevision !== row.currentCredentialRevision
    )
      return false;
    if (mail.purpose === "password_reset") {
      return (
        row.tokenEmailRevision === row.recoveryEmailRevision &&
        Boolean(row.emailNormalized) &&
        row.recipientFingerprint === recoveryAddressFingerprint(row.emailNormalized!)
      );
    }
    return (
      row.tokenEmailRevision === row.recoveryEmailRevision &&
      row.pendingEmailRevision === row.currentPendingEmailRevision &&
      Boolean(row.pendingEmailNormalized) &&
      row.recipientFingerprint === recoveryAddressFingerprint(row.pendingEmailNormalized!)
    );
  }

  private async settle(mail: ClaimedMail, result: AuthMailSendResult, now: Date): Promise<void> {
    const where = { mailId: mail.mailId, status: "processing", leaseOwner: this.owner };
    if (result.kind === "submitted") {
      await AuthMailOutbox.update(
        {
          status: "submitted",
          providerMessageId: result.providerMessageId,
          submittedAt: now,
          payloadCiphertext: null,
          payloadNonce: null,
          payloadAuthTag: null,
          leaseUntil: null,
          leaseOwner: null,
          lastErrorCode: null,
        },
        { where },
      );
      return;
    }
    if (result.kind === "failed" || mail.attemptCount >= maxAttempts) {
      await AuthMailOutbox.update(
        {
          status: "failed",
          payloadCiphertext: null,
          payloadNonce: null,
          payloadAuthTag: null,
          leaseUntil: null,
          leaseOwner: null,
          lastErrorCode: result.errorCode,
        },
        { where },
      );
      return;
    }
    const delay = retryDelay(mail.attemptCount, result.retryAfterSeconds);
    if (mail.expiresAt && mail.expiresAt.getTime() - now.getTime() <= delay + 2 * 60_000) {
      await this.cancel(mail.mailId, "link_too_close_to_expiry");
      return;
    }
    await AuthMailOutbox.update(
      {
        status: "pending",
        nextAttemptAt: new Date(now.getTime() + delay),
        leaseUntil: null,
        leaseOwner: null,
        lastErrorCode: result.errorCode,
      },
      { where },
    );
  }

  private async cancel(mailId: string, code: string): Promise<void> {
    await AuthMailOutbox.update(
      {
        status: "cancelled",
        payloadCiphertext: null,
        payloadNonce: null,
        payloadAuthTag: null,
        leaseUntil: null,
        leaseOwner: null,
        lastErrorCode: code,
      },
      { where: { mailId, status: "processing", leaseOwner: this.owner } },
    );
  }

  private async releaseForBudget(mail: ClaimedMail, retryAfterSeconds: number): Promise<void> {
    await AuthMailOutbox.update(
      {
        status: "pending",
        attemptCount: Math.max(0, mail.attemptCount - 1),
        nextAttemptAt: new Date(Date.now() + Math.max(1, retryAfterSeconds) * 1000),
        leaseUntil: null,
        leaseOwner: null,
        lastErrorCode: "send_budget_limited",
      },
      { where: { mailId: mail.mailId, status: "processing", leaseOwner: this.owner } },
    );
  }

  private async dispatchOne(): Promise<boolean> {
    await this.cleanupOldRecords(new Date());
    const mail = await this.claim();
    if (!mail) return false;
    const now = new Date();
    if (!(await this.targetIsCurrent(mail, now))) {
      await this.cancel(mail.mailId, "target_no_longer_valid");
      return true;
    }
    if (!mail.ciphertext || !mail.nonce || !mail.authTag) {
      await this.cancel(mail.mailId, "encrypted_payload_unavailable");
      return true;
    }
    let content: AuthMailContent;
    try {
      content = decryptAuthMailContent(mail.mailId, mail.ciphertext, mail.nonce, mail.authTag, mail.keyVersion);
    } catch {
      await this.cancel(mail.mailId, "encrypted_payload_invalid");
      return true;
    }
    try {
      const budget = await this.rateLimiter.consumeAuthMailSendBudget();
      if (!budget.allowed) {
        await this.releaseForBudget(mail, Math.max(1, budget.retryAfterSeconds));
        return true;
      }
    } catch {
      await this.releaseForBudget(mail, 15);
      return true;
    }
    const result = await this.provider.send({
      idempotencyKey: `goldis-auth-mail/${mail.mailId}`,
      from: content.from,
      to: content.to,
      ...(content.replyTo ? { replyTo: content.replyTo } : {}),
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    await this.settle(mail, result, now);
    return true;
  }
}
