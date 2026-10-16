import { randomUUID } from "node:crypto";
import { QueryTypes, type Transaction } from "sequelize";
import { AuthMailOutbox, sequelize } from "../../infrastructure/database/db";
import { readAuthMailConfig } from "./auth-mail-config";
import { encryptAuthMailContent } from "./auth-mail-crypto";
import type { AuthMailContent } from "./auth-mail-templates";

export type AuthMailPurpose =
  | "password_reset"
  | "email_verify"
  | "password_changed_notice"
  | "recovery_email_changed_notice";

export async function enqueueAuthMail(
  input: Readonly<{
    tenantId: string;
    userId: string;
    tokenId?: string | null;
    purpose: AuthMailPurpose;
    content: AuthMailContent;
    expiresAt?: Date | null;
    transaction: Transaction;
    now?: Date;
  }>,
): Promise<string> {
  if (!readAuthMailConfig().enabled) throw new Error("AUTH_MAIL_RECOVERY_DISABLED");
  if (
    (input.purpose === "password_reset" || input.purpose === "email_verify") !== Boolean(input.tokenId) ||
    ((input.purpose === "password_reset" || input.purpose === "email_verify") && !input.expiresAt)
  ) {
    throw new Error("AUTH_MAIL_OUTBOX_TOKEN_BINDING_INVALID");
  }
  const now = input.now ?? new Date();
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) throw new Error("AUTH_MAIL_OUTBOX_EXPIRY_INVALID");
  const mailId = randomUUID();
  const encrypted = encryptAuthMailContent(mailId, input.content);
  await AuthMailOutbox.create(
    {
      mailId,
      tenantId: input.tenantId,
      userId: input.userId,
      tokenId: input.tokenId ?? null,
      purpose: input.purpose,
      payloadCiphertext: encrypted.ciphertext,
      payloadNonce: encrypted.nonce,
      payloadAuthTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      leaseOwner: null,
      providerMessageId: null,
      lastErrorCode: null,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      submittedAt: null,
    },
    { transaction: input.transaction },
  );
  return mailId;
}

export async function cancelAuthMailForToken(
  tokenId: string,
  transaction: Transaction,
  errorCode = "token_revoked",
): Promise<number> {
  const [count] = await AuthMailOutbox.update(
    {
      status: "cancelled",
      payloadCiphertext: null,
      payloadNonce: null,
      payloadAuthTag: null,
      leaseUntil: null,
      leaseOwner: null,
      lastErrorCode: errorCode,
    },
    { where: { tokenId, status: ["pending", "processing"] }, transaction },
  );
  return count;
}

export async function authMailOutboxCounts(): Promise<Readonly<Record<string, number>>> {
  const rows = await sequelize.query<{ status: string; count: number | string }>(
    `SELECT status, count(*)::int AS count FROM auth_mail_outbox GROUP BY status`,
    { type: QueryTypes.SELECT },
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

export async function authMailOutboxSummary(): Promise<
  Readonly<{
    pendingCount: number;
    oldestPendingAt: Date | null;
    failedCount: number;
    submittedCount: number;
  }>
> {
  const rows = await sequelize.query<{
    pendingCount: number;
    oldestPendingAt: Date | null;
    failedCount: number;
    submittedCount: number;
  }>(
    `SELECT count(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS "pendingCount",
            min(created_at) FILTER (WHERE status IN ('pending', 'processing')) AS "oldestPendingAt",
            count(*) FILTER (WHERE status = 'failed')::int AS "failedCount",
            count(*) FILTER (WHERE status = 'submitted')::int AS "submittedCount"
       FROM auth_mail_outbox`,
    { type: QueryTypes.SELECT },
  );
  return {
    pendingCount: Number(rows[0]?.pendingCount ?? 0),
    oldestPendingAt: rows[0]?.oldestPendingAt ?? null,
    failedCount: Number(rows[0]?.failedCount ?? 0),
    submittedCount: Number(rows[0]?.submittedCount ?? 0),
  };
}
