import { Inject, Injectable } from "@nestjs/common";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { API_DATABASE } from "../../infrastructure/database";
import type { SessionPrincipal } from "../auth/public";
import type {
  PrivilegedActionConsumption,
  PrivilegedActionConsumptionResult,
  PrivilegedActionPersistence,
} from "./privileged-actions.persistence";

type ConfirmationRow = {
  confirmationId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  credentialRevision: number;
  action: string;
  targetId: string | null;
  payloadFingerprint: string;
  idempotencyKey: string;
  expiresAt: Date;
  consumedAt: Date | null;
  response: unknown;
};

type ActiveActionContext = {
  userStatus: string;
  userRevision: number;
  membershipStatus: string;
  role: string;
  sessionRevision: number;
  sessionExpiresAt: Date;
  sessionRevokedAt: Date | null;
};

export type PrivilegedActionReauthenticationContext = Readonly<{
  user: Readonly<{ passwordHash: string; credentialRevision: number; status: string }> | undefined;
  membership: Readonly<{ role: string; status: string }> | undefined;
  session: Readonly<{ credentialRevision: number; expiresAt: Date; revokedAt: Date | null }> | undefined;
}>;

export type PrivilegedActionConfirmationInsert = Readonly<{
  actor: SessionPrincipal;
  confirmationId: string;
  action: string;
  targetId: string | null;
  payloadFingerprint: string;
  tokenHash: string;
  idempotencyKey: string;
  credentialRevision: number;
  now: Date;
  expiresAt: Date;
}>;

@Injectable()
export class PrivilegedActionRepository implements PrivilegedActionPersistence {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  async loadReauthenticationContext(actor: SessionPrincipal): Promise<PrivilegedActionReauthenticationContext> {
    const [users, memberships, sessions] = await Promise.all([
      this.database.query<NonNullable<PrivilegedActionReauthenticationContext["user"]>>(
        `SELECT password_hash AS "passwordHash", credential_revision AS "credentialRevision", status
           FROM users WHERE user_id = :userId`,
        { replacements: { userId: actor.userId }, type: QueryTypes.SELECT },
      ),
      this.database.query<NonNullable<PrivilegedActionReauthenticationContext["membership"]>>(
        `SELECT role, status FROM tenant_memberships
          WHERE user_id = :userId AND tenant_id = :tenantId AND status = 'active'`,
        { replacements: { userId: actor.userId, tenantId: actor.tenantId }, type: QueryTypes.SELECT },
      ),
      this.database.query<NonNullable<PrivilegedActionReauthenticationContext["session"]>>(
        `SELECT credential_revision AS "credentialRevision", expires_at AS "expiresAt", revoked_at AS "revokedAt"
           FROM user_sessions
          WHERE session_id = :sessionId AND user_id = :userId AND tenant_id = :tenantId AND revoked_at IS NULL`,
        {
          replacements: { sessionId: actor.sessionId, userId: actor.userId, tenantId: actor.tenantId },
          type: QueryTypes.SELECT,
        },
      ),
    ]);
    return { user: users[0], membership: memberships[0], session: sessions[0] };
  }

  transaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.database.transaction(operation);
  }

  async lockActorForConfirmation(
    actor: SessionPrincipal,
    transaction: Transaction,
  ): Promise<{
    user: NonNullable<PrivilegedActionReauthenticationContext["user"]> | undefined;
    membership: NonNullable<PrivilegedActionReauthenticationContext["membership"]> | undefined;
    session: NonNullable<PrivilegedActionReauthenticationContext["session"]> | undefined;
  }> {
    await lockUsersInTransaction([actor.userId], transaction);
    const users = await this.database.query<NonNullable<PrivilegedActionReauthenticationContext["user"]>>(
      `SELECT password_hash AS "passwordHash", credential_revision AS "credentialRevision", status
         FROM users WHERE user_id = :userId FOR UPDATE`,
      { replacements: { userId: actor.userId }, type: QueryTypes.SELECT, transaction },
    );
    const memberships = await this.database.query<NonNullable<PrivilegedActionReauthenticationContext["membership"]>>(
      `SELECT role, status FROM tenant_memberships
        WHERE user_id = :userId AND tenant_id = :tenantId AND status = 'active' FOR UPDATE`,
      { replacements: { userId: actor.userId, tenantId: actor.tenantId }, type: QueryTypes.SELECT, transaction },
    );
    const sessions = await this.database.query<NonNullable<PrivilegedActionReauthenticationContext["session"]>>(
      `SELECT credential_revision AS "credentialRevision", expires_at AS "expiresAt", revoked_at AS "revokedAt"
         FROM user_sessions
        WHERE session_id = :sessionId AND user_id = :userId AND tenant_id = :tenantId AND revoked_at IS NULL
        FOR UPDATE`,
      {
        replacements: { sessionId: actor.sessionId, userId: actor.userId, tenantId: actor.tenantId },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return { user: users[0], membership: memberships[0], session: sessions[0] };
  }

  async insertConfirmation(input: PrivilegedActionConfirmationInsert, transaction: Transaction): Promise<void> {
    await this.database.query(
      `DELETE FROM privileged_action_confirmations
        WHERE expires_at <= :now OR (consumed_at IS NOT NULL AND created_at < :retentionCutoff)`,
      {
        replacements: { now: input.now, retentionCutoff: new Date(input.now.getTime() - 24 * 60 * 60_000) },
        transaction,
      },
    );
    await this.database.query(
      `INSERT INTO privileged_action_confirmations
         (confirmation_id, tenant_id, user_id, session_id, credential_revision, action, target_id,
          payload_fingerprint, token_hash, idempotency_key, created_at, expires_at, consumed_at, response)
       VALUES (:confirmationId, :tenantId, :userId, :sessionId, :credentialRevision, :action, :targetId,
          :payloadFingerprint, :tokenHash, :idempotencyKey, :now, :expiresAt, NULL, NULL)`,
      {
        replacements: {
          confirmationId: input.confirmationId,
          tenantId: input.actor.tenantId,
          userId: input.actor.userId,
          sessionId: input.actor.sessionId,
          credentialRevision: input.credentialRevision,
          action: input.action,
          targetId: input.targetId,
          payloadFingerprint: input.payloadFingerprint,
          tokenHash: input.tokenHash,
          idempotencyKey: input.idempotencyKey,
          now: input.now,
          expiresAt: input.expiresAt,
        },
        transaction,
      },
    );
  }

  async consume(input: PrivilegedActionConsumption): Promise<PrivilegedActionConsumptionResult | null> {
    const { actor, transaction } = input;
    const contextRows = await this.database.query<ActiveActionContext>(
      `SELECT u.status AS "userStatus", u.credential_revision AS "userRevision",
              m.status AS "membershipStatus", m.role,
              s.credential_revision AS "sessionRevision", s.expires_at AS "sessionExpiresAt",
              s.revoked_at AS "sessionRevokedAt"
         FROM users u
         JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
         JOIN user_sessions s ON s.user_id = u.user_id AND s.tenant_id = m.tenant_id AND s.session_id = :sessionId
        WHERE u.user_id = :userId`,
      {
        replacements: { tenantId: actor.tenantId, userId: actor.userId, sessionId: actor.sessionId },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    const context = contextRows[0];
    if (
      context?.userStatus !== "active" ||
      context.membershipStatus !== "active" ||
      context.role !== actor.role ||
      context.sessionRevokedAt !== null ||
      new Date(context.sessionExpiresAt).getTime() <= Date.now() ||
      context.userRevision !== context.sessionRevision
    )
      return null;

    const rows = await this.database.query<ConfirmationRow>(
      `SELECT confirmation_id AS "confirmationId", tenant_id AS "tenantId", user_id AS "userId",
              session_id AS "sessionId", credential_revision AS "credentialRevision", action,
              target_id AS "targetId", payload_fingerprint AS "payloadFingerprint",
              idempotency_key AS "idempotencyKey", expires_at AS "expiresAt", consumed_at AS "consumedAt",
              response
         FROM privileged_action_confirmations
        WHERE confirmation_id = :confirmationId AND token_hash = :tokenHash
        FOR UPDATE`,
      {
        replacements: { confirmationId: input.confirmationId, tokenHash: input.tokenHash },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    const row = rows[0];
    if (
      !row ||
      row.tenantId !== actor.tenantId ||
      row.userId !== actor.userId ||
      row.sessionId !== actor.sessionId ||
      row.credentialRevision < 1 ||
      row.credentialRevision !== context.userRevision ||
      row.action !== input.action ||
      row.targetId !== input.targetId ||
      row.payloadFingerprint !== input.payloadFingerprint ||
      row.idempotencyKey !== input.idempotencyKey
    )
      return null;

    const now = new Date();
    if (row.consumedAt) {
      if (new Date(row.expiresAt).getTime() <= now.getTime() || row.response === null || row.response === undefined)
        return null;
      return { kind: "replay", response: row.response };
    }
    if (new Date(row.expiresAt).getTime() <= now.getTime()) return null;
    const changed = await this.database.query<{ confirmationId: string }>(
      `UPDATE privileged_action_confirmations SET consumed_at = :now
        WHERE confirmation_id = :confirmationId AND consumed_at IS NULL AND expires_at > :now
        RETURNING confirmation_id AS "confirmationId"`,
      { replacements: { confirmationId: row.confirmationId, now }, type: QueryTypes.SELECT, transaction },
    );
    if (!changed.length) return null;
    return { kind: "execute", confirmationId: row.confirmationId };
  }

  async complete(
    confirmationId: string,
    idempotencyKey: string,
    response: unknown,
    transaction: Transaction,
  ): Promise<void> {
    const encoded = JSON.stringify(response);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 16_384)
      throw new Error("PRIVILEGED_ACTION_RESPONSE_INVALID");
    const rows = await this.database.query<{ confirmationId: string }>(
      `UPDATE privileged_action_confirmations SET response = CAST(:response AS jsonb)
        WHERE confirmation_id = :confirmationId AND idempotency_key = :idempotencyKey AND consumed_at IS NOT NULL
        RETURNING confirmation_id AS "confirmationId"`,
      { replacements: { confirmationId, idempotencyKey, response: encoded }, type: QueryTypes.SELECT, transaction },
    );
    if (!rows.length) throw new Error("PRIVILEGED_ACTION_CONFIRMATION_COMPLETION_FAILED");
  }
}
