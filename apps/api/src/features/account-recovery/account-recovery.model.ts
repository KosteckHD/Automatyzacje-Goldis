import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type RecoveryTokenPurpose = "password_reset" | "email_verify";

export class AccountRecoveryTokenModel extends Model {
  declare tokenId: string;
  declare tenantId: string;
  declare userId: string;
  declare purpose: RecoveryTokenPurpose;
  declare tokenHash: string;
  declare credentialRevision: number;
  declare recoveryEmailRevision: number;
  declare pendingEmailRevision: number | null;
  declare recipientFingerprint: string;
  declare createdAt: Date;
  declare expiresAt: Date;
  declare consumedAt: Date | null;
  declare revokedAt: Date | null;
}

registerModel(
  AccountRecoveryTokenModel,
  {
    tokenId: { type: DataTypes.UUID, primaryKey: true, field: "token_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    userId: { type: DataTypes.UUID, allowNull: false, field: "user_id" },
    purpose: { type: DataTypes.STRING(32), allowNull: false },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: "token_hash" },
    credentialRevision: { type: DataTypes.INTEGER, allowNull: false, field: "credential_revision" },
    recoveryEmailRevision: { type: DataTypes.INTEGER, allowNull: false, field: "recovery_email_revision" },
    pendingEmailRevision: { type: DataTypes.INTEGER, allowNull: true, field: "pending_email_revision" },
    recipientFingerprint: { type: DataTypes.STRING(64), allowNull: false, field: "recipient_fingerprint" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
    consumedAt: { type: DataTypes.DATE, allowNull: true, field: "consumed_at" },
    revokedAt: { type: DataTypes.DATE, allowNull: true, field: "revoked_at" },
  },
  { tableName: "account_recovery_tokens", timestamps: false, modelName: "AccountRecoveryToken" },
);

export type AuthMailOutboxStatus = "pending" | "processing" | "submitted" | "failed" | "cancelled";

export class AuthMailOutboxModel extends Model {
  declare mailId: string;
  declare tenantId: string;
  declare userId: string;
  declare tokenId: string | null;
  declare purpose: string;
  declare payloadCiphertext: Buffer | null;
  declare payloadNonce: Buffer | null;
  declare payloadAuthTag: Buffer | null;
  declare keyVersion: number;
  declare status: AuthMailOutboxStatus;
  declare attemptCount: number;
  declare nextAttemptAt: Date;
  declare leaseUntil: Date | null;
  declare leaseOwner: string | null;
  declare providerMessageId: string | null;
  declare lastErrorCode: string | null;
  declare createdAt: Date;
  declare expiresAt: Date | null;
  declare submittedAt: Date | null;
}

registerModel(
  AuthMailOutboxModel,
  {
    mailId: { type: DataTypes.UUID, primaryKey: true, field: "mail_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    userId: { type: DataTypes.UUID, allowNull: false, field: "user_id" },
    tokenId: { type: DataTypes.UUID, allowNull: true, field: "token_id" },
    purpose: { type: DataTypes.STRING(40), allowNull: false },
    payloadCiphertext: { type: DataTypes.BLOB, allowNull: true, field: "payload_ciphertext" },
    payloadNonce: { type: DataTypes.BLOB, allowNull: true, field: "payload_nonce" },
    payloadAuthTag: { type: DataTypes.BLOB, allowNull: true, field: "payload_auth_tag" },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false, field: "key_version" },
    status: { type: DataTypes.STRING(20), allowNull: false },
    attemptCount: { type: DataTypes.INTEGER, allowNull: false, field: "attempt_count" },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false, field: "next_attempt_at" },
    leaseUntil: { type: DataTypes.DATE, allowNull: true, field: "lease_until" },
    leaseOwner: { type: DataTypes.STRING(80), allowNull: true, field: "lease_owner" },
    providerMessageId: { type: DataTypes.STRING(200), allowNull: true, field: "provider_message_id" },
    lastErrorCode: { type: DataTypes.STRING(64), allowNull: true, field: "last_error_code" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    expiresAt: { type: DataTypes.DATE, allowNull: true, field: "expires_at" },
    submittedAt: { type: DataTypes.DATE, allowNull: true, field: "submitted_at" },
  },
  { tableName: "auth_mail_outbox", timestamps: false, modelName: "AuthMailOutbox" },
);
