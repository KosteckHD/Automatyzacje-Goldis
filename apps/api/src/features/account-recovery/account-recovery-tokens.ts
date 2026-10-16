import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { QueryTypes, type Transaction } from "sequelize";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { AccountRecoveryToken, type RecoveryTokenPurpose, sequelize } from "../../infrastructure/database/db";

export const passwordResetLifetimeMs = 15 * 60_000;
export const recoveryEmailVerificationLifetimeMs = 24 * 60 * 60_000;
const rawTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type RecoveryTokenSnapshot = Readonly<{
  tokenId: string;
  tenantId: string;
  userId: string;
  purpose: RecoveryTokenPurpose;
  credentialRevision: number;
  recoveryEmailRevision: number;
  pendingEmailRevision: number | null;
  recipientFingerprint: string;
  emailNormalized: string | null;
  pendingEmailNormalized: string | null;
  userStatus: string;
  membershipStatus: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}>;

function fingerprintKey(): string {
  const value = loadApiSecretConfig().loginRateLimitSecret;
  if (!value || Buffer.byteLength(value, "utf8") < 32) throw new Error("LOGIN_RATE_LIMIT_SECRET_INVALID");
  return value;
}

export function hashRecoveryToken(rawToken: string): string {
  return createHash("sha256").update("goldis:account-recovery:v1\0", "utf8").update(rawToken, "utf8").digest("hex");
}

export function recoveryAddressFingerprint(normalizedEmail: string): string {
  return createHmac("sha256", fingerprintKey())
    .update("goldis:recovery-address:v1\0", "utf8")
    .update(normalizedEmail, "utf8")
    .digest("hex");
}

export async function createRecoveryToken(
  input: Readonly<{
    tenantId: string;
    userId: string;
    purpose: RecoveryTokenPurpose;
    credentialRevision: number;
    recoveryEmailRevision: number;
    pendingEmailRevision?: number | null;
    normalizedEmail: string;
    expiresAt: Date;
    transaction: Transaction;
  }>,
): Promise<Readonly<{ tokenId: string; rawToken: string; recipientFingerprint: string; expiresAt: Date }>> {
  if (input.purpose === "password_reset" && input.pendingEmailRevision != null)
    throw new Error("RECOVERY_TOKEN_PURPOSE_INVALID");
  if (
    input.purpose === "email_verify" &&
    (!Number.isInteger(input.pendingEmailRevision) || Number(input.pendingEmailRevision) < 1)
  ) {
    throw new Error("RECOVERY_TOKEN_PURPOSE_INVALID");
  }
  const now = new Date();
  if (input.expiresAt.getTime() <= now.getTime()) throw new Error("RECOVERY_TOKEN_EXPIRY_INVALID");
  const tokenId = randomUUID();
  const rawToken = randomBytes(32).toString("base64url");
  const recipientFingerprint = recoveryAddressFingerprint(input.normalizedEmail);
  await AccountRecoveryToken.create(
    {
      tokenId,
      tenantId: input.tenantId,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: hashRecoveryToken(rawToken),
      credentialRevision: input.credentialRevision,
      recoveryEmailRevision: input.recoveryEmailRevision,
      pendingEmailRevision: input.pendingEmailRevision ?? null,
      recipientFingerprint,
      createdAt: now,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
    },
    { transaction: input.transaction },
  );
  return { tokenId, rawToken, recipientFingerprint, expiresAt: input.expiresAt };
}

export async function findRecoveryToken(
  rawToken: unknown,
  purpose: RecoveryTokenPurpose,
  transaction?: Transaction,
  lock = false,
): Promise<RecoveryTokenSnapshot | null> {
  if (typeof rawToken !== "string" || !rawTokenPattern.test(rawToken)) return null;
  const rows = await sequelize.query<RecoveryTokenSnapshot>(
    `SELECT t.token_id AS "tokenId", t.tenant_id AS "tenantId", t.user_id AS "userId", t.purpose,
            t.credential_revision AS "credentialRevision", t.recovery_email_revision AS "recoveryEmailRevision",
            t.pending_email_revision AS "pendingEmailRevision", t.recipient_fingerprint AS "recipientFingerprint",
            t.created_at AS "createdAt", t.expires_at AS "expiresAt", t.consumed_at AS "consumedAt", t.revoked_at AS "revokedAt",
            u.status AS "userStatus", u.credential_revision AS "currentCredentialRevision",
            u.recovery_email_revision AS "currentRecoveryEmailRevision", u.recovery_email_normalized AS "emailNormalized",
            u.pending_recovery_email_normalized AS "pendingEmailNormalized", u.pending_recovery_email_revision AS "currentPendingEmailRevision",
            m.status AS "membershipStatus"
       FROM account_recovery_tokens t
       JOIN users u ON u.user_id = t.user_id
       JOIN tenant_memberships m ON m.tenant_id = t.tenant_id AND m.user_id = t.user_id
      WHERE t.token_hash = :tokenHash AND t.purpose = :purpose
      ${lock ? "FOR UPDATE OF t, u, m" : ""}`,
    { replacements: { tokenHash: hashRecoveryToken(rawToken), purpose }, type: QueryTypes.SELECT, transaction },
  );
  const row = rows[0] as
    | (RecoveryTokenSnapshot & {
        currentCredentialRevision?: number;
        currentRecoveryEmailRevision?: number;
        currentPendingEmailRevision?: number;
      })
    | undefined;
  if (
    !row ||
    row.userStatus !== "active" ||
    row.membershipStatus !== "active" ||
    row.credentialRevision !== row.currentCredentialRevision ||
    row.recoveryEmailRevision !== row.currentRecoveryEmailRevision
  )
    return null;
  const now = Date.now();
  if (row.consumedAt || row.revokedAt || new Date(row.expiresAt).getTime() <= now) return null;
  if (purpose === "password_reset") {
    if (!row.emailNormalized || !awaitedFingerprintMatches(row.recipientFingerprint, row.emailNormalized)) return null;
  } else if (
    !row.pendingEmailNormalized ||
    row.pendingEmailRevision !== row.currentPendingEmailRevision ||
    !awaitedFingerprintMatches(row.recipientFingerprint, row.pendingEmailNormalized)
  )
    return null;
  return row;
}

function awaitedFingerprintMatches(expected: string, normalizedEmail: string): boolean {
  try {
    const actual = Buffer.from(recoveryAddressFingerprint(normalizedEmail), "hex");
    const stored = Buffer.from(expected, "hex");
    return actual.length === stored.length && timingSafeEqual(actual, stored);
  } catch {
    return false;
  }
}

export async function consumeRecoveryToken(
  tokenId: string,
  transaction: Transaction,
  now = new Date(),
): Promise<boolean> {
  const rows = await sequelize.query<{ tokenId: string }>(
    `UPDATE account_recovery_tokens SET consumed_at = :now
      WHERE token_id = :tokenId AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > :now
      RETURNING token_id AS "tokenId"`,
    { replacements: { tokenId, now }, type: QueryTypes.SELECT, transaction },
  );
  return rows.length === 1;
}

export async function revokeUserRecoveryTokens(
  userId: string,
  transaction: Transaction,
  now = new Date(),
): Promise<void> {
  await sequelize.query(
    `UPDATE auth_mail_outbox SET status = 'cancelled', payload_ciphertext = NULL, payload_nonce = NULL,
         payload_auth_tag = NULL, lease_until = NULL, lease_owner = NULL, last_error_code = 'credential_changed'
      WHERE user_id = :userId AND token_id IN (
        SELECT token_id FROM account_recovery_tokens WHERE user_id = :userId
      ) AND status IN ('pending', 'processing')`,
    { replacements: { userId, now }, transaction },
  );
  await sequelize.query(
    `UPDATE account_recovery_tokens SET revoked_at = :now
      WHERE user_id = :userId AND consumed_at IS NULL AND revoked_at IS NULL`,
    { replacements: { userId, now }, transaction },
  );
}
