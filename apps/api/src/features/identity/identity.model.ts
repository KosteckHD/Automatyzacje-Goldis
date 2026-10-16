import { DataTypes, Model } from "sequelize";
import { registerAssociation, registerModel } from "../../infrastructure/database/model-registry";

export class TenantModel extends Model {
  declare tenantId: string;

  declare slug: string;

  declare displayName: string;

  declare createdAt: Date;
}

registerModel(
  TenantModel,
  {
    tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },

    slug: { type: DataTypes.STRING(80), allowNull: false },

    displayName: { type: DataTypes.STRING(160), allowNull: false, field: "display_name" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "tenants", timestamps: false, modelName: "Tenant" },
);

export class UserModel extends Model {
  declare userId: string;

  declare username: string;

  declare usernameNormalized: string;

  declare passwordHash: string;

  declare status: "active" | "disabled";

  declare createdAt: Date;

  declare updatedAt: Date;

  declare lastLoginAt: Date | null;

  declare mustChangePassword: boolean;

  declare credentialRevision: number;

  declare recoveryEmail: string | null;

  declare recoveryEmailNormalized: string | null;

  declare recoveryEmailVerifiedAt: Date | null;

  declare recoveryEmailRevision: number;

  declare pendingRecoveryEmail: string | null;

  declare pendingRecoveryEmailNormalized: string | null;

  declare pendingRecoveryEmailRevision: number;
}

registerModel(
  UserModel,
  {
    userId: { type: DataTypes.UUID, primaryKey: true, field: "user_id" },

    username: { type: DataTypes.STRING(128), allowNull: false },

    usernameNormalized: { type: DataTypes.STRING(128), allowNull: false, field: "username_normalized" },

    passwordHash: { type: DataTypes.TEXT, allowNull: false, field: "password_hash" },

    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: "last_login_at" },

    mustChangePassword: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "must_change_password",
    },

    credentialRevision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "credential_revision" },
  },
  { tableName: "users", timestamps: false, modelName: "User" },
);

export class UserSessionModel extends Model {
  declare sessionId: string;

  declare tenantId: string;

  declare userId: string;

  declare credentialRevision: number;

  declare createdAt: Date;

  declare lastSeenAt: Date;

  declare lastActivityAt: Date;

  declare expiresAt: Date;

  declare revokedAt: Date | null;

  declare revokedBy: string | null;

  declare revokeReason: "logout" | "admin" | "password_change" | "account_change" | "expired" | "idle" | null;

  declare ipHash: string | null;

  declare browserLabel: string | null;
}

registerModel(
  UserSessionModel,
  {
    sessionId: { type: DataTypes.UUID, primaryKey: true, field: "session_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    userId: { type: DataTypes.UUID, allowNull: false, field: "user_id" },

    credentialRevision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "credential_revision" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: "last_seen_at" },

    lastActivityAt: { type: DataTypes.DATE, allowNull: false, field: "last_activity_at" },

    expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },

    revokedAt: { type: DataTypes.DATE, allowNull: true, field: "revoked_at" },

    revokedBy: { type: DataTypes.UUID, allowNull: true, field: "revoked_by" },

    revokeReason: { type: DataTypes.STRING(32), allowNull: true, field: "revoke_reason" },

    ipHash: { type: DataTypes.STRING(64), allowNull: true, field: "ip_hash" },

    browserLabel: { type: DataTypes.STRING(80), allowNull: true, field: "browser_label" },
  },
  { tableName: "user_sessions", timestamps: false, modelName: "UserSession" },
);

export class TenantMembershipModel extends Model {
  declare tenantId: string;

  declare userId: string;

  declare role: "admin" | "manager" | "operator" | "reviewer" | "auditor";

  declare status: "active" | "invited" | "disabled";

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  TenantMembershipModel,
  {
    tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },

    userId: { type: DataTypes.UUID, primaryKey: true, field: "user_id" },

    role: { type: DataTypes.STRING(20), allowNull: false },

    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "tenant_memberships", timestamps: false, modelName: "TenantMembership" },
);

registerAssociation(() => TenantModel.hasMany(TenantMembershipModel, { foreignKey: "tenantId" }));
registerAssociation(() => TenantMembershipModel.belongsTo(TenantModel, { foreignKey: "tenantId" }));
registerAssociation(() => UserModel.hasMany(TenantMembershipModel, { foreignKey: "userId" }));
registerAssociation(() => TenantMembershipModel.belongsTo(UserModel, { foreignKey: "userId" }));

export type Tenant = InstanceType<typeof TenantModel>;
export type User = InstanceType<typeof UserModel>;
export type UserSession = InstanceType<typeof UserSessionModel>;
export type TenantMembership = InstanceType<typeof TenantMembershipModel>;
