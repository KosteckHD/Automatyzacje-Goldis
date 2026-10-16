import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Transaction } from "sequelize";
import { QueryTypes } from "sequelize";
import type { SessionPrincipal } from "../auth/index";

export const deletionStepUpLifetimeMs = 5 * 60_000;
const fingerprintPattern = /^[0-9a-f]{64}$/;

export function normalizeDeletionPreviewFingerprint(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

export function canRequestDeletionStepUp(role: string, canDeleteData: boolean): boolean {
  return role === "admin" || (role === "manager" && canDeleteData);
}

export async function canDeleteTarget(input: {
  role: string;
  canDeleteData: boolean;
  targetType: string;
  targetId: string | null;
  tenantId: string;
  userId: string;
  transaction?: Transaction;
}): Promise<boolean> {
  if (input.role === "admin" || (input.role === "manager" && input.canDeleteData)) return true;
  if (input.role !== "operator" || input.targetType !== "import" || !input.targetId) return false;
  const { sequelize } = await import("../../infrastructure/database/db");
  const rows = await sequelize.query<{ owned: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM import_batches WHERE id = :targetId AND tenant_id = :tenantId
      AND owner_user_id = :userId) AS owned`,
    {
      replacements: { targetId: input.targetId, tenantId: input.tenantId, userId: input.userId },
      type: QueryTypes.SELECT,
      transaction: input.transaction,
    },
  );
  return Boolean(rows[0]?.owned);
}

export function isDeletionStepUpFingerprint(value: string): boolean {
  return fingerprintPattern.test(value);
}

export function hashDeletionStepUpToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Create inside the same transaction as the revalidated session and audit event. */
export async function createDeletionStepUpGrant(input: {
  actor: SessionPrincipal;
  previewId: string;
  credentialRevision: number;
  deletionGrantVersion: number;
  scopeFingerprint: string;
  now?: Date;
  transaction: Transaction;
}): Promise<string> {
  const { sequelize } = await import("../../infrastructure/database/db");
  const scopeFingerprint = normalizeDeletionPreviewFingerprint(input.scopeFingerprint);
  if (
    !input.actor.sessionId ||
    !isUuid(input.previewId) ||
    !scopeFingerprint ||
    !Number.isInteger(input.credentialRevision) ||
    input.credentialRevision < 1 ||
    !Number.isInteger(input.deletionGrantVersion) ||
    input.deletionGrantVersion < 0
  ) {
    throw new Error("INVALID_DELETION_STEP_UP_CONTEXT");
  }
  const grantId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${grantId}.${secret}`;
  const now = input.now ?? new Date();
  await sequelize.query(`DELETE FROM deletion_step_up_grants WHERE expires_at <= :now OR consumed_at IS NOT NULL`, {
    replacements: { now },
    transaction: input.transaction,
  });
  await sequelize.query(
    `INSERT INTO deletion_step_up_grants
       (grant_id, tenant_id, user_id, session_id, preview_id, credential_revision, deletion_grant_version, scope_fingerprint, token_hash, created_at, expires_at, consumed_at)
     VALUES (:grantId, :tenantId, :userId, :sessionId, :previewId, :credentialRevision, :deletionGrantVersion, :scopeFingerprint, :tokenHash, :now, :expiresAt, NULL)`,
    {
      replacements: {
        grantId,
        tenantId: input.actor.tenantId,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
        previewId: input.previewId.toLowerCase(),
        credentialRevision: input.credentialRevision,
        deletionGrantVersion: input.deletionGrantVersion,
        scopeFingerprint,
        tokenHash: hashDeletionStepUpToken(token),
        now,
        expiresAt: new Date(now.getTime() + deletionStepUpLifetimeMs),
      },
      transaction: input.transaction,
    },
  );
  return token;
}

/** Consume atomically in the deletion-job transaction; rollback leaves the grant usable. */
export async function consumeDeletionStepUpGrant(input: {
  token: unknown;
  actor: SessionPrincipal;
  previewId: string;
  credentialRevision: number;
  deletionGrantVersion: number;
  scopeFingerprint: string;
  now?: Date;
  transaction: Transaction;
}): Promise<boolean> {
  const { sequelize } = await import("../../infrastructure/database/db");
  const fingerprint = normalizeDeletionPreviewFingerprint(input.scopeFingerprint);
  if (
    typeof input.token !== "string" ||
    input.token.length > 128 ||
    !fingerprint ||
    !input.actor.sessionId ||
    !isUuid(input.previewId)
  )
    return false;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{40,})$/i.exec(
      input.token,
    );
  if (!match) return false;
  const now = input.now ?? new Date();
  const rows = await sequelize.query<{ grantId: string }>(
    `UPDATE deletion_step_up_grants
        SET consumed_at = :now
      WHERE grant_id = :grantId AND token_hash = :tokenHash AND tenant_id = :tenantId
        AND user_id = :userId AND session_id = :sessionId AND credential_revision = :credentialRevision
        AND preview_id = :previewId AND deletion_grant_version = :deletionGrantVersion
        AND scope_fingerprint = :scopeFingerprint AND consumed_at IS NULL AND expires_at > :now
      RETURNING grant_id AS "grantId"`,
    {
      replacements: {
        now,
        grantId: match[1],
        tokenHash: hashDeletionStepUpToken(input.token),
        tenantId: input.actor.tenantId,
        userId: input.actor.userId,
        sessionId: input.actor.sessionId,
        credentialRevision: input.credentialRevision,
        previewId: input.previewId.toLowerCase(),
        deletionGrantVersion: input.deletionGrantVersion,
        scopeFingerprint: fingerprint,
      },
      type: QueryTypes.SELECT,
      transaction: input.transaction,
    },
  );
  return rows.length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
