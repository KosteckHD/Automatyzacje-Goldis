import type { RunDispatchIntentV1, RunStatus } from "@goldis/core";
import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type RunDispatchIntent = RunDispatchIntentV1;
export type RunDispatchStatus = "pending" | "publishing" | "published" | "consumed" | "cancelled" | "blocked";

export class AutomationRunModel extends Model {
  declare id: string;

  declare batchId: string;

  declare sourceRowId: string;

  declare canonicalEntityId: string | null;

  declare leadIdentityKey: string | null;

  declare rowNumber: number;

  declare toolId: string;

  declare status: RunStatus;

  declare currentStep: string;

  declare schemaVersion: number;

  declare adapterVersion: string | null;

  declare lastSafeStep: string | null;

  declare externalCaseRef: string | null;

  declare heartbeatAt: Date | null;

  declare startedAt: Date | null;

  declare finishedAt: Date | null;

  declare referenceDate: string;

  declare errorCode: string | null;

  declare currentAuthChallengeId: string | null;

  declare authCycleId: string | null;

  declare authCyclePortal: "pzu" | "compensa" | null;

  declare authCycleStartedAt: Date | null;

  declare authCycleExpiresAt: Date | null;

  declare pzuSmsRetryCount: number;

  declare compensaSmsRetryCount: number;

  declare startedByUserId: string | null;

  declare executionId: string | null;

  declare workerSessionId: string | null;

  declare leaseExpiresAt: Date | null;

  declare technicalCycleId: string | null;

  declare technicalAttemptCount: number;

  declare stagingFileId: string | null;

  declare stagingSha256: string | null;

  declare stagingKeyVersion: number | null;

  declare stagingFormatVersion: number | null;

  declare controlState: "running" | "pause_requested" | "paused";

  declare controlRevision: string;

  declare controlAckRevision: string;

  declare controlRequestedBy: string | null;

  declare controlRequestedAt: Date | null;

  declare controlAcknowledgedAt: Date | null;

  declare controlCheckpointStatus: string | null;

  declare manualDataVersion: number;

  declare inputSnapshot: Record<string, unknown>;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  AutomationRunModel,
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    canonicalEntityId: { type: DataTypes.UUID, allowNull: true, field: "canonical_entity_id" },

    leadIdentityKey: { type: DataTypes.STRING(64), allowNull: true, field: "lead_identity_key" },

    rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "row_number" },

    toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },

    status: { type: DataTypes.STRING(40), allowNull: false },

    currentStep: { type: DataTypes.STRING(80), allowNull: false, field: "current_step" },

    schemaVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "schema_version" },

    adapterVersion: { type: DataTypes.STRING(80), allowNull: true, field: "adapter_version" },

    lastSafeStep: { type: DataTypes.STRING(80), allowNull: true, field: "last_safe_step" },

    externalCaseRef: { type: DataTypes.TEXT, allowNull: true, field: "external_case_ref" },

    heartbeatAt: { type: DataTypes.DATE, allowNull: true, field: "heartbeat_at" },

    startedAt: { type: DataTypes.DATE, allowNull: true, field: "started_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },

    referenceDate: { type: DataTypes.DATEONLY, allowNull: false, field: "reference_date" },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    currentAuthChallengeId: { type: DataTypes.UUID, allowNull: true, field: "current_auth_challenge_id" },

    authCycleId: { type: DataTypes.UUID, allowNull: true, field: "auth_cycle_id" },

    authCyclePortal: { type: DataTypes.STRING(16), allowNull: true, field: "auth_cycle_portal" },

    authCycleStartedAt: { type: DataTypes.DATE, allowNull: true, field: "auth_cycle_started_at" },

    authCycleExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "auth_cycle_expires_at" },

    pzuSmsRetryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "pzu_sms_retry_count" },

    compensaSmsRetryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "compensa_sms_retry_count",
    },

    startedByUserId: { type: DataTypes.UUID, allowNull: true, field: "started_by_user_id" },

    executionId: { type: DataTypes.UUID, allowNull: true, field: "execution_id" },

    workerSessionId: { type: DataTypes.UUID, allowNull: true, field: "worker_session_id" },

    leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "lease_expires_at" },

    technicalCycleId: { type: DataTypes.UUID, allowNull: true, field: "technical_cycle_id" },

    technicalAttemptCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "technical_attempt_count",
    },

    stagingFileId: { type: DataTypes.UUID, allowNull: true, field: "staging_file_id" },

    stagingSha256: { type: DataTypes.STRING(64), allowNull: true, field: "staging_sha256" },

    stagingKeyVersion: { type: DataTypes.INTEGER, allowNull: true, field: "staging_key_version" },

    stagingFormatVersion: { type: DataTypes.INTEGER, allowNull: true, field: "staging_format_version" },

    controlState: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "running", field: "control_state" },

    controlRevision: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: "control_revision" },

    controlAckRevision: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: "control_ack_revision" },

    controlRequestedBy: { type: DataTypes.UUID, allowNull: true, field: "control_requested_by" },

    controlRequestedAt: { type: DataTypes.DATE, allowNull: true, field: "control_requested_at" },

    controlAcknowledgedAt: { type: DataTypes.DATE, allowNull: true, field: "control_acknowledged_at" },

    controlCheckpointStatus: { type: DataTypes.STRING(40), allowNull: true, field: "control_checkpoint_status" },

    manualDataVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "manual_data_version" },

    inputSnapshot: { type: DataTypes.JSONB, allowNull: false, field: "input_snapshot" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "automation_runs", timestamps: true, underscored: true, modelName: "AutomationRun" },
);

export class RunSourceRowModel extends Model {
  declare runId: string;

  declare sourceRowId: string;

  declare rowNumber: number;

  declare isPrimary: boolean;

  declare createdAt: Date;
}

registerModel(
  RunSourceRowModel,
  {
    runId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "run_id" },

    sourceRowId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "source_row_id" },

    rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "row_number" },

    isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_primary" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "run_source_rows", timestamps: false, modelName: "RunSourceRow" },
);

export class RunEventModel extends Model {
  declare id: string;

  declare runId: string;

  declare status: RunStatus;

  declare step: string;

  declare errorCode: string | null;

  declare actorId: string | null;

  declare metadata: Record<string, unknown>;

  declare createdAt: Date;
}

registerModel(
  RunEventModel,
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },

    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },

    status: { type: DataTypes.STRING(40), allowNull: false },

    step: { type: DataTypes.STRING(80), allowNull: false },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    actorId: { type: DataTypes.UUID, allowNull: true, field: "actor_id" },

    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "run_events", timestamps: false, modelName: "RunEvent" },
);

export class RunIdentityModel extends Model {
  declare runId: string;

  declare sourceRowId: string;

  declare regon: string;

  declare companyName: string;

  declare firstName: string;

  declare lastName: string;

  declare peselCiphertext: string;

  declare peselKeyVersion: number;

  declare matchMethod: string;

  declare adapterVersion: string;

  declare createdAt: Date;
}

registerModel(
  RunIdentityModel,
  {
    runId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "run_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    regon: { type: DataTypes.STRING(14), allowNull: false },

    companyName: { type: DataTypes.TEXT, allowNull: false, field: "company_name" },

    firstName: { type: DataTypes.TEXT, allowNull: false, field: "first_name" },

    lastName: { type: DataTypes.TEXT, allowNull: false, field: "last_name" },

    peselCiphertext: { type: DataTypes.TEXT, allowNull: false, field: "pesel_ciphertext" },

    peselKeyVersion: { type: DataTypes.INTEGER, allowNull: false, field: "pesel_key_version" },

    matchMethod: { type: DataTypes.STRING(80), allowNull: false, field: "match_method" },

    adapterVersion: { type: DataTypes.STRING(80), allowNull: false, field: "adapter_version" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "run_identities", timestamps: false, modelName: "RunIdentity" },
);

export class RunManualDataOverrideModel extends Model {
  declare runId: string;

  declare version: number;

  declare source: "admin_correction";

  declare fields: Record<string, string>;

  declare reason: string;

  declare createdBy: string;

  declare createdAt: Date;
}

registerModel(
  RunManualDataOverrideModel,
  {
    runId: { type: DataTypes.UUID, primaryKey: true, field: "run_id" },

    version: { type: DataTypes.INTEGER, primaryKey: true },

    source: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "admin_correction" },

    fields: { type: DataTypes.JSONB, allowNull: false },

    reason: { type: DataTypes.STRING(300), allowNull: false },

    createdBy: { type: DataTypes.UUID, allowNull: false, field: "created_by" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "run_manual_data_overrides", timestamps: false, modelName: "RunManualDataOverride" },
);

export class RunDispatchOutboxModel extends Model {
  declare dispatchId: string;

  declare runId: string;

  declare intentType: RunDispatchIntent;

  declare status: RunDispatchStatus;

  declare attemptCount: number;

  declare nextAttemptAt: Date;

  declare claimedAt: Date | null;

  declare claimedBy: string | null;

  declare lastErrorCode: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  RunDispatchOutboxModel,
  {
    dispatchId: { type: DataTypes.UUID, primaryKey: true, field: "dispatch_id" },

    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },

    intentType: { type: DataTypes.STRING(32), allowNull: false, field: "intent_type" },

    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },

    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "attempt_count" },

    nextAttemptAt: { type: DataTypes.DATE, allowNull: false, field: "next_attempt_at" },

    claimedAt: { type: DataTypes.DATE, allowNull: true, field: "claimed_at" },

    claimedBy: { type: DataTypes.UUID, allowNull: true, field: "claimed_by" },

    lastErrorCode: { type: DataTypes.STRING(80), allowNull: true, field: "last_error_code" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "run_dispatch_outbox", timestamps: false, modelName: "RunDispatchOutbox" },
);
