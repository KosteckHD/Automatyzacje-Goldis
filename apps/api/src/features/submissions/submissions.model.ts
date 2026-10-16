import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type RunSubmissionStatus = "queued" | "running" | "waiting_attention" | "completed" | "cancelled";
export type RunSubmissionAdmissionState =
  | "pending"
  | "leased"
  | "waiting_capacity"
  | "waiting_window"
  | "waiting_paused"
  | "accepted"
  | "blocked"
  | "cancelled";
export type RunSubmissionPreparationState = "ready" | "review" | "excluded";

export class RunSubmissionModel extends Model {
  declare submissionId: string;

  declare importBatchId: string;

  declare tenantId: string;

  declare toolId: string;

  declare actorUserId: string;

  declare idempotencyKey: string;

  declare requestHash: string;

  declare referenceDate: string;

  declare resultSetId: string | null;

  declare status: RunSubmissionStatus;

  declare version: number;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  RunSubmissionModel,
  {
    submissionId: { type: DataTypes.UUID, primaryKey: true, field: "submission_id" },

    importBatchId: { type: DataTypes.UUID, allowNull: false, field: "import_batch_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    idempotencyKey: { type: DataTypes.STRING(128), allowNull: false, field: "idempotency_key" },

    requestHash: { type: DataTypes.STRING(64), allowNull: false, field: "request_hash" },

    referenceDate: { type: DataTypes.DATEONLY, allowNull: false, field: "reference_date" },

    resultSetId: { type: DataTypes.UUID, allowNull: true, field: "result_set_id" },

    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },

    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "run_submissions", timestamps: false, modelName: "RunSubmission" },
);

export class RunSubmissionGroupModel extends Model {
  declare groupId: string;

  declare submissionId: string;

  declare tenantId: string;

  declare canonicalEntityId: string;

  declare leadIdentityKey: string;

  declare runId: string | null;

  declare admissionState: RunSubmissionAdmissionState;

  declare reasonCode: string | null;

  declare nextAttemptAt: Date | null;

  declare leaseOwner: string | null;

  declare leaseExpiresAt: Date | null;

  declare version: number;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  RunSubmissionGroupModel,
  {
    groupId: { type: DataTypes.UUID, primaryKey: true, field: "group_id" },

    submissionId: { type: DataTypes.UUID, allowNull: false, field: "submission_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    canonicalEntityId: { type: DataTypes.UUID, allowNull: false, field: "canonical_entity_id" },

    leadIdentityKey: { type: DataTypes.STRING(64), allowNull: false, field: "lead_identity_key" },

    runId: { type: DataTypes.UUID, allowNull: true, field: "run_id" },

    admissionState: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "pending", field: "admission_state" },

    reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },

    nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: "next_attempt_at" },

    leaseOwner: { type: DataTypes.UUID, allowNull: true, field: "lease_owner" },

    leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "lease_expires_at" },

    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "run_submission_groups", timestamps: false, modelName: "RunSubmissionGroup" },
);

export class RunSubmissionItemModel extends Model {
  declare itemId: string;

  declare submissionId: string;

  declare importBatchId: string;

  declare sourceRowId: string;

  declare groupId: string | null;

  declare expectedRowVersion: number;

  declare preparationState: RunSubmissionPreparationState;

  declare reasonCode: string | null;

  declare createdAt: Date;
}

registerModel(
  RunSubmissionItemModel,
  {
    itemId: { type: DataTypes.UUID, primaryKey: true, field: "item_id" },

    submissionId: { type: DataTypes.UUID, allowNull: false, field: "submission_id" },

    importBatchId: { type: DataTypes.UUID, allowNull: false, field: "import_batch_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    groupId: { type: DataTypes.UUID, allowNull: true, field: "group_id" },

    expectedRowVersion: { type: DataTypes.INTEGER, allowNull: false, field: "expected_row_version" },

    preparationState: { type: DataTypes.STRING(16), allowNull: false, field: "preparation_state" },

    reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "run_submission_items", timestamps: false, modelName: "RunSubmissionItem" },
);
