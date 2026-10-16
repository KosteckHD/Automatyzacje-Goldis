import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export class AuditEventModel extends Model {
  declare eventId: string;

  declare tenantId: string;

  declare actorUserId: string | null;

  declare action: string;

  declare resourceType: string;

  declare resourceId: string | null;

  declare outcome: "succeeded" | "denied" | "failed";

  declare requestRef: string | null;

  declare metadata: Record<string, unknown>;

  declare createdAt: Date;
}

registerModel(
  AuditEventModel,
  {
    eventId: { type: DataTypes.UUID, primaryKey: true, field: "event_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: true, field: "actor_user_id" },

    action: { type: DataTypes.STRING(60), allowNull: false },

    resourceType: { type: DataTypes.STRING(40), allowNull: false, field: "resource_type" },

    resourceId: { type: DataTypes.STRING(80), allowNull: true, field: "resource_id" },

    outcome: { type: DataTypes.STRING(20), allowNull: false },

    requestRef: { type: DataTypes.STRING(80), allowNull: true, field: "request_ref" },

    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "audit_events", timestamps: false, modelName: "AuditEvent" },
);

export type AuditEvent = InstanceType<typeof AuditEventModel>;
