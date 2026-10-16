import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type BusinessLeadResultStatus = "processing" | "ready" | "failed";
export type BusinessLeadContactStatus = "not_contacted" | "offer_accepted" | "not_interested";

export class BusinessLeadModel extends Model {
  declare leadId: string;

  declare resultSetId: string;

  declare tenantId: string;

  declare toolId: string;

  declare canonicalEntityId: string;

  declare sourceRowIds: string[];

  declare companyName: string;

  declare nip: string | null;

  declare regon: string | null;

  declare address: string;

  declare postalCode: string;

  declare city: string;

  declare decisionMakerNames: string[];

  declare contactData: { type: "mobile" | "phone" | "email"; value: string; sourceRowId: string }[];

  declare resultStatus: BusinessLeadResultStatus;

  declare contactStatus: BusinessLeadContactStatus;

  declare assignedToUserId: string | null;

  declare assignedByUserId: string | null;

  declare assignedAt: Date | null;

  declare contactStatusVersion: number;

  declare assignmentVersion: number;

  declare contactStatusUpdatedAt: Date | null;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  BusinessLeadModel,
  {
    leadId: { type: DataTypes.UUID, primaryKey: true, field: "lead_id" },

    resultSetId: { type: DataTypes.UUID, allowNull: false, field: "result_set_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },

    canonicalEntityId: { type: DataTypes.UUID, allowNull: false, field: "canonical_entity_id" },

    sourceRowIds: { type: DataTypes.JSONB, allowNull: false, field: "source_row_ids" },

    companyName: { type: DataTypes.TEXT, allowNull: false, field: "company_name" },

    nip: { type: DataTypes.STRING(10), allowNull: true },

    regon: { type: DataTypes.STRING(14), allowNull: true },

    address: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    postalCode: { type: DataTypes.TEXT, allowNull: false, defaultValue: "", field: "postal_code" },

    city: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    decisionMakerNames: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "decision_maker_names" },

    contactData: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "contact_data" },

    resultStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "processing", field: "result_status" },

    contactStatus: {
      type: DataTypes.STRING(24),
      allowNull: false,
      defaultValue: "not_contacted",
      field: "contact_status",
    },

    assignedToUserId: { type: DataTypes.UUID, allowNull: true, field: "assigned_to_user_id" },

    assignedByUserId: { type: DataTypes.UUID, allowNull: true, field: "assigned_by_user_id" },

    assignedAt: { type: DataTypes.DATE, allowNull: true, field: "assigned_at" },

    contactStatusVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      field: "contact_status_version",
    },

    assignmentVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "assignment_version" },

    contactStatusUpdatedAt: { type: DataTypes.DATE, allowNull: true, field: "contact_status_updated_at" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "business_leads", timestamps: false, modelName: "BusinessLead" },
);

export class LeadRunLinkModel extends Model {
  declare linkId: string;

  declare tenantId: string;

  declare leadId: string;

  declare groupId: string;

  declare createdAt: Date;
}

registerModel(
  LeadRunLinkModel,
  {
    linkId: { type: DataTypes.UUID, primaryKey: true, field: "link_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    leadId: { type: DataTypes.UUID, allowNull: false, field: "lead_id" },

    groupId: { type: DataTypes.UUID, allowNull: false, field: "group_id" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "lead_run_links", timestamps: false, modelName: "LeadRunLink" },
);

export class LeadAllocationModel extends Model {
  declare allocationId: string;

  declare tenantId: string;

  declare toolId: string;

  declare actorUserId: string;

  declare recipientUserId: string;

  declare idempotencyKey: string;

  declare requestHash: string;

  declare count: number;

  declare assignedLeadIds: string[];

  declare createdAt: Date;
}

registerModel(
  LeadAllocationModel,
  {
    allocationId: { type: DataTypes.UUID, primaryKey: true, field: "allocation_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    recipientUserId: { type: DataTypes.UUID, allowNull: false, field: "recipient_user_id" },

    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false, field: "idempotency_key" },

    requestHash: { type: DataTypes.STRING(64), allowNull: false, field: "request_hash" },

    count: { type: DataTypes.INTEGER, allowNull: false },

    assignedLeadIds: { type: DataTypes.JSONB, allowNull: false, field: "assigned_lead_ids" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "lead_allocations", timestamps: false, modelName: "LeadAllocation" },
);
