import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type CommissionSourceType = "CRM" | "ASF" | "WARTA" | "DICTIONARY";
export type CommissionFileState = "pending" | "ready" | "rejected" | "deleted";
export type CommissionDictionaryStatus = "draft" | "published" | "archived";
export type CommissionRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_findings"
  | "cancel_requested"
  | "cancelled"
  | "failed";

export class CommissionAgentModel extends Model {
  declare tenantId: string;
  declare agentId: string;
  declare agentKey: string;
  declare displayName: string;
  declare aliases: string[];
  declare isActive: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
}

registerModel(
  CommissionAgentModel,
  {
    tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },
    agentId: { type: DataTypes.UUID, primaryKey: true, field: "agent_id" },
    agentKey: { type: DataTypes.STRING(40), allowNull: false, field: "agent_key" },
    displayName: { type: DataTypes.STRING(120), allowNull: false, field: "display_name" },
    aliases: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, field: "is_active" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "commission_agents", timestamps: false, modelName: "CommissionAgent" },
);

export class CommissionFileModel extends Model {
  declare fileId: string;
  declare tenantId: string;
  declare sourceType: CommissionSourceType;
  declare fileName: string;
  declare storageKey: string;
  declare sha256: string;
  declare sizeBytes: number;
  declare validationState: CommissionFileState;
  declare rowCount: number | null;
  declare parserVersion: string | null;
  declare uploadedBy: string;
  declare uploadedAt: Date;
  declare deletedAt: Date | null;
}

registerModel(
  CommissionFileModel,
  {
    fileId: { type: DataTypes.UUID, primaryKey: true, field: "file_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    sourceType: { type: DataTypes.STRING(20), allowNull: false, field: "source_type" },
    fileName: { type: DataTypes.STRING(255), allowNull: false, field: "file_name" },
    storageKey: { type: DataTypes.STRING(120), allowNull: false, field: "storage_key" },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: false, field: "size_bytes" },
    validationState: { type: DataTypes.STRING(20), allowNull: false, field: "validation_state" },
    rowCount: { type: DataTypes.INTEGER, allowNull: true, field: "row_count" },
    parserVersion: { type: DataTypes.STRING(80), allowNull: true, field: "parser_version" },
    uploadedBy: { type: DataTypes.UUID, allowNull: false, field: "uploaded_by" },
    uploadedAt: { type: DataTypes.DATE, allowNull: false, field: "uploaded_at" },
    deletedAt: { type: DataTypes.DATE, allowNull: true, field: "deleted_at" },
  },
  { tableName: "commission_files", timestamps: false, modelName: "CommissionFile" },
);

export class CommissionDictionaryVersionModel extends Model {
  declare dictionaryVersionId: string;
  declare tenantId: string;
  declare versionNumber: number;
  declare status: CommissionDictionaryStatus;
  declare isActive: boolean;
  declare revision: number;
  declare sourceFileId: string | null;
  declare snapshotCiphertext: Buffer;
  declare snapshotSha256: string;
  declare entryCount: number;
  declare previousVersionId: string | null;
  declare createdBy: string;
  declare publishedBy: string | null;
  declare createdAt: Date;
  declare publishedAt: Date | null;
}

registerModel(
  CommissionDictionaryVersionModel,
  {
    dictionaryVersionId: { type: DataTypes.UUID, primaryKey: true, field: "dictionary_version_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    versionNumber: { type: DataTypes.INTEGER, allowNull: false, field: "version_number" },
    status: { type: DataTypes.STRING(16), allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, field: "is_active" },
    revision: { type: DataTypes.INTEGER, allowNull: false },
    sourceFileId: { type: DataTypes.UUID, allowNull: true, field: "source_file_id" },
    snapshotCiphertext: { type: DataTypes.BLOB, allowNull: false, field: "snapshot_ciphertext" },
    snapshotSha256: { type: DataTypes.STRING(64), allowNull: false, field: "snapshot_sha256" },
    entryCount: { type: DataTypes.INTEGER, allowNull: false, field: "entry_count" },
    previousVersionId: { type: DataTypes.UUID, allowNull: true, field: "previous_version_id" },
    createdBy: { type: DataTypes.UUID, allowNull: false, field: "created_by" },
    publishedBy: { type: DataTypes.UUID, allowNull: true, field: "published_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    publishedAt: { type: DataTypes.DATE, allowNull: true, field: "published_at" },
  },
  { tableName: "commission_dictionary_versions", timestamps: false, modelName: "CommissionDictionaryVersion" },
);

export class CommissionDictionaryGrantModel extends Model {
  declare tenantId: string;
  declare userId: string;
  declare grantedBy: string;
  declare createdAt: Date;
}

registerModel(
  CommissionDictionaryGrantModel,
  {
    tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },
    userId: { type: DataTypes.UUID, primaryKey: true, field: "user_id" },
    grantedBy: { type: DataTypes.UUID, allowNull: false, field: "granted_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "commission_dictionary_grants", timestamps: false, modelName: "CommissionDictionaryGrant" },
);

export class CommissionRunModel extends Model {
  declare runId: string;
  declare tenantId: string;
  declare ownerUserId: string;
  declare startDate: string;
  declare endDate: string;
  declare status: CommissionRunStatus;
  declare progressStage: string;
  declare dictionaryVersionId: string;
  declare engineVersion: string;
  declare requestHash: string;
  declare idempotencyKey: string;
  declare resultSha256: string | null;
  declare counters: Record<string, number>;
  declare activeAttemptToken: string | null;
  declare executionLeaseUntil: Date | null;
  declare errorCode: string | null;
  declare createdAt: Date;
  declare startedAt: Date | null;
  declare finishedAt: Date | null;
}

registerModel(
  CommissionRunModel,
  {
    runId: { type: DataTypes.UUID, primaryKey: true, field: "run_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    ownerUserId: { type: DataTypes.UUID, allowNull: false, field: "owner_user_id" },
    startDate: { type: DataTypes.DATEONLY, allowNull: false, field: "start_date" },
    endDate: { type: DataTypes.DATEONLY, allowNull: false, field: "end_date" },
    status: { type: DataTypes.STRING(28), allowNull: false },
    progressStage: { type: DataTypes.STRING(32), allowNull: false, field: "progress_stage" },
    dictionaryVersionId: { type: DataTypes.UUID, allowNull: false, field: "dictionary_version_id" },
    engineVersion: { type: DataTypes.STRING(80), allowNull: false, field: "engine_version" },
    requestHash: { type: DataTypes.STRING(64), allowNull: false, field: "request_hash" },
    idempotencyKey: { type: DataTypes.STRING(128), allowNull: false, field: "idempotency_key" },
    resultSha256: { type: DataTypes.STRING(64), allowNull: true, field: "result_sha256" },
    counters: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: "counters" },
    activeAttemptToken: { type: DataTypes.UUID, allowNull: true, field: "active_attempt_token" },
    executionLeaseUntil: { type: DataTypes.DATE, allowNull: true, field: "execution_lease_until" },
    errorCode: { type: DataTypes.STRING(64), allowNull: true, field: "error_code" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    startedAt: { type: DataTypes.DATE, allowNull: true, field: "started_at" },
    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
  },
  { tableName: "commission_runs", timestamps: false, modelName: "CommissionRun" },
);

export class CommissionRunFileModel extends Model {
  declare tenantId: string;
  declare runId: string;
  declare fileId: string;
  declare createdAt: Date;
}

registerModel(
  CommissionRunFileModel,
  {
    tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },
    runId: { type: DataTypes.UUID, primaryKey: true, field: "run_id" },
    fileId: { type: DataTypes.UUID, primaryKey: true, field: "file_id" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "commission_run_files", timestamps: false, modelName: "CommissionRunFile" },
);

export class CommissionRunSnapshotModel extends Model {
  declare tenantId: string;
  declare runId: string;
  declare snapshotCiphertext: Buffer;
  declare sha256: string;
  declare recordCount: number;
  declare createdAt: Date;
}

registerModel(
  CommissionRunSnapshotModel,
  {
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    runId: { type: DataTypes.UUID, primaryKey: true, field: "run_id" },
    snapshotCiphertext: { type: DataTypes.BLOB, allowNull: false, field: "snapshot_ciphertext" },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    recordCount: { type: DataTypes.INTEGER, allowNull: false, field: "record_count" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "commission_run_snapshots", timestamps: false, modelName: "CommissionRunSnapshot" },
);

export class CommissionDispatchModel extends Model {
  declare dispatchId: string;
  declare tenantId: string;
  declare runId: string;
  declare status: "pending" | "publishing" | "published" | "completed" | "failed" | "cancelled";
  declare attemptCount: number;
  declare claimedAt: Date | null;
  declare claimedBy: string | null;
  declare nextAttemptAt: Date;
  declare lastErrorCode: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

registerModel(
  CommissionDispatchModel,
  {
    dispatchId: { type: DataTypes.UUID, primaryKey: true, field: "dispatch_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },
    status: { type: DataTypes.STRING(16), allowNull: false },
    attemptCount: { type: DataTypes.INTEGER, allowNull: false, field: "attempt_count" },
    claimedAt: { type: DataTypes.DATE, allowNull: true, field: "claimed_at" },
    claimedBy: { type: DataTypes.STRING(80), allowNull: true, field: "claimed_by" },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false, field: "next_attempt_at" },
    lastErrorCode: { type: DataTypes.STRING(64), allowNull: true, field: "last_error_code" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "commission_dispatches", timestamps: false, modelName: "CommissionDispatch" },
);

export class CommissionResolutionModel extends Model {
  declare resolutionId: string;
  declare tenantId: string;
  declare runId: string;
  declare findingKey: string;
  declare decisionCode: string;
  declare noteCiphertext: Buffer | null;
  declare actorUserId: string;
  declare createdAt: Date;
}

registerModel(
  CommissionResolutionModel,
  {
    resolutionId: { type: DataTypes.UUID, primaryKey: true, field: "resolution_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },
    findingKey: { type: DataTypes.STRING(160), allowNull: false, field: "finding_key" },
    decisionCode: { type: DataTypes.STRING(40), allowNull: false, field: "decision_code" },
    noteCiphertext: { type: DataTypes.BLOB, allowNull: true, field: "note_ciphertext" },
    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "commission_resolutions", timestamps: false, modelName: "CommissionResolution" },
);

export class CommissionExportModel extends Model {
  declare exportId: string;
  declare tenantId: string;
  declare runId: string;
  declare fileName: string;
  declare storageKey: string;
  declare sha256: string;
  declare state: "pending" | "ready" | "failed";
  declare createdBy: string;
  declare createdAt: Date;
}

registerModel(
  CommissionExportModel,
  {
    exportId: { type: DataTypes.UUID, primaryKey: true, field: "export_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },
    fileName: { type: DataTypes.STRING(255), allowNull: false, field: "file_name" },
    storageKey: { type: DataTypes.STRING(120), allowNull: false, field: "storage_key" },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    state: { type: DataTypes.STRING(16), allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: false, field: "created_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "commission_exports", timestamps: false, modelName: "CommissionExport" },
);
