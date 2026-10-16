import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";
export class ImportBatchModel extends Model {
  declare id: string;

  declare tenantId: string | null;

  declare ownerUserId: string | null;

  declare toolId: string;

  declare fileName: string;

  declare sha256: string;

  declare totalRows: number;

  declare invalidRows: number;

  declare createdAt: Date;
}

registerModel(
  ImportBatchModel,
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },

    tenantId: { type: DataTypes.UUID, allowNull: true, field: "tenant_id" },

    ownerUserId: { type: DataTypes.UUID, allowNull: true, field: "owner_user_id" },

    toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },

    fileName: { type: DataTypes.STRING(255), allowNull: false, field: "file_name" },

    sha256: { type: DataTypes.STRING(64), allowNull: false },

    totalRows: { type: DataTypes.INTEGER, allowNull: false, field: "total_rows" },

    invalidRows: { type: DataTypes.INTEGER, allowNull: false, field: "invalid_rows" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "import_batches", timestamps: false, modelName: "ImportBatch" },
);

export class SourceRowModel extends Model {
  declare id: string;

  declare batchId: string;

  declare rowNumber: number;

  declare companyName: string;

  declare decisionMakerName: string | null;

  declare mobile: string;

  declare phone: string;

  declare email: string;

  declare nipRaw: string;

  declare address: string;

  declare postalCode: string;

  declare city: string;

  declare regonRaw: string;

  declare regon: string | null;

  declare effectiveRegon: string | null;

  declare rowVersion: number;

  declare issues: string[];
}

registerModel(
  SourceRowModel,
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "row_number" },

    companyName: { type: DataTypes.TEXT, allowNull: false, field: "company_name" },

    decisionMakerName: { type: DataTypes.TEXT, allowNull: true, field: "decision_maker_name" },

    mobile: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    phone: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    email: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    nipRaw: { type: DataTypes.TEXT, allowNull: false, field: "nip_raw" },

    address: { type: DataTypes.TEXT, allowNull: false },

    postalCode: { type: DataTypes.TEXT, allowNull: false, field: "postal_code" },

    city: { type: DataTypes.TEXT, allowNull: false },

    regonRaw: { type: DataTypes.TEXT, allowNull: false, field: "regon_raw" },

    regon: { type: DataTypes.STRING(14), allowNull: true },

    effectiveRegon: { type: DataTypes.STRING(14), allowNull: true, field: "effective_regon" },

    rowVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "row_version" },

    issues: { type: DataTypes.JSONB, allowNull: false },
  },
  { tableName: "source_rows", timestamps: false, modelName: "SourceRow" },
);

export type ImportPreparationStatus =
  | "queued"
  | "processing"
  | "waiting_registry"
  | "completed"
  | "completed_with_attention"
  | "cancelled"
  | "failed";

export type ImportPreparationStage =
  | "snapshot"
  | "first_deduplication"
  | "registry_lookup"
  | "second_deduplication"
  | "sealing"
  | "sealed";

export type ImportPreparationWorkflowStatus =
  | "queued"
  | "starting_registry"
  | "waiting_registry"
  | "starting_reanalysis"
  | "waiting_reanalysis"
  | "completed"
  | "completed_with_attention"
  | "cancelled"
  | "failed";

export class ImportPreparationWorkflowModel extends Model {
  declare workflowId: string;

  declare tenantId: string;

  declare batchId: string;

  declare sourcePreparationId: string;

  declare actorUserId: string;

  declare idempotencyKey: string;

  declare status: ImportPreparationWorkflowStatus;

  declare version: number;

  declare leaseOwner: string | null;

  declare leaseExpiresAt: Date | null;

  declare nextAttemptAt: Date | null;

  declare reanalysisPreparationId: string | null;

  declare errorCode: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare finishedAt: Date | null;
}

registerModel(
  ImportPreparationWorkflowModel,
  {
    workflowId: { type: DataTypes.UUID, primaryKey: true, field: "workflow_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    sourcePreparationId: { type: DataTypes.UUID, allowNull: false, field: "source_preparation_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false, field: "idempotency_key" },

    status: { type: DataTypes.STRING(32), allowNull: false },

    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    leaseOwner: { type: DataTypes.UUID, allowNull: true, field: "lease_owner" },

    leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "lease_expires_at" },

    nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: "next_attempt_at" },

    reanalysisPreparationId: { type: DataTypes.UUID, allowNull: true, field: "reanalysis_preparation_id" },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
  },
  { tableName: "import_preparation_workflows", timestamps: false, modelName: "ImportPreparationWorkflow" },
);

export class ImportPreparationWorkflowJobModel extends Model {
  declare workflowId: string;

  declare jobId: string;

  declare batchId: string;

  declare chunkNumber: number;

  declare createdAt: Date;
}

registerModel(
  ImportPreparationWorkflowJobModel,
  {
    workflowId: { type: DataTypes.UUID, primaryKey: true, field: "workflow_id" },

    jobId: { type: DataTypes.UUID, allowNull: false, field: "job_id" },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    chunkNumber: { type: DataTypes.INTEGER, primaryKey: true, field: "chunk_number" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "import_preparation_workflow_jobs", timestamps: false, modelName: "ImportPreparationWorkflowJob" },
);

export class ImportPreparationModel extends Model {
  declare preparationId: string;

  declare tenantId: string;

  declare batchId: string;

  declare actorUserId: string;

  declare revision: number;

  declare rulesVersion: string;

  declare sourceFingerprint: string;

  declare status: ImportPreparationStatus;

  declare stage: ImportPreparationStage;

  declare cursorRowNumber: number;

  declare totalRows: number;

  declare readyCount: number;

  declare reviewCount: number;

  declare skippedCount: number;

  declare duplicateCount: number;

  declare waitingRegistryCount: number;

  declare version: number;

  declare idempotencyKey: string;

  declare leaseOwner: string | null;

  declare leaseExpiresAt: Date | null;

  declare nextAttemptAt: Date | null;

  declare errorCode: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare finishedAt: Date | null;

  declare sealedAt: Date | null;
}

registerModel(
  ImportPreparationModel,
  {
    preparationId: { type: DataTypes.UUID, primaryKey: true, field: "preparation_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    revision: { type: DataTypes.INTEGER, allowNull: false },

    rulesVersion: { type: DataTypes.STRING(40), allowNull: false, field: "rules_version" },

    sourceFingerprint: { type: DataTypes.STRING(64), allowNull: false, field: "source_fingerprint" },

    status: { type: DataTypes.STRING(32), allowNull: false },

    stage: { type: DataTypes.STRING(32), allowNull: false },

    cursorRowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "cursor_row_number" },

    totalRows: { type: DataTypes.INTEGER, allowNull: false, field: "total_rows" },

    readyCount: { type: DataTypes.INTEGER, allowNull: false, field: "ready_count" },

    reviewCount: { type: DataTypes.INTEGER, allowNull: false, field: "review_count" },

    skippedCount: { type: DataTypes.INTEGER, allowNull: false, field: "skipped_count" },

    duplicateCount: { type: DataTypes.INTEGER, allowNull: false, field: "duplicate_count" },

    waitingRegistryCount: { type: DataTypes.INTEGER, allowNull: false, field: "waiting_registry_count" },

    version: { type: DataTypes.INTEGER, allowNull: false },

    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false, field: "idempotency_key" },

    leaseOwner: { type: DataTypes.UUID, allowNull: true, field: "lease_owner" },

    leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "lease_expires_at" },

    nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: "next_attempt_at" },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },

    sealedAt: { type: DataTypes.DATE, allowNull: true, field: "sealed_at" },
  },
  { tableName: "import_preparations", timestamps: false, modelName: "ImportPreparation" },
);

export type PreparedRowStatus =
  | "pending"
  | "ready"
  | "review"
  | "skipped_no_identifiers"
  | "duplicate"
  | "waiting_registry"
  | "excluded";

export class ImportPreparedRowModel extends Model {
  declare preparedRowId: string;

  declare preparationId: string;

  declare batchId: string;

  declare sourceRowId: string;

  declare rowNumber: number;

  declare expectedRowVersion: number;

  declare sourceSnapshot: Record<string, unknown>;

  declare status: PreparedRowStatus;

  declare reasonCode: string | null;

  declare representativeRowNumber: number | null;

  declare normalizedName: string | null;

  declare normalizedNip: string | null;

  declare effectiveRegon: string | null;

  declare regonProvenance: "none" | "import" | "approved_correction" | "registry";

  declare registryFetchedAt: Date | null;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  ImportPreparedRowModel,
  {
    preparedRowId: { type: DataTypes.UUID, primaryKey: true, field: "prepared_row_id" },

    preparationId: { type: DataTypes.UUID, allowNull: false, field: "preparation_id" },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "row_number" },

    expectedRowVersion: { type: DataTypes.INTEGER, allowNull: false, field: "expected_row_version" },

    sourceSnapshot: { type: DataTypes.JSONB, allowNull: false, field: "source_snapshot" },

    status: { type: DataTypes.STRING(32), allowNull: false },

    reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },

    representativeRowNumber: { type: DataTypes.INTEGER, allowNull: true, field: "representative_row_number" },

    normalizedName: { type: DataTypes.TEXT, allowNull: true, field: "normalized_name" },

    normalizedNip: { type: DataTypes.STRING(10), allowNull: true, field: "normalized_nip" },

    effectiveRegon: { type: DataTypes.STRING(14), allowNull: true, field: "effective_regon" },

    regonProvenance: { type: DataTypes.STRING(24), allowNull: false, field: "regon_provenance" },

    registryFetchedAt: { type: DataTypes.DATE, allowNull: true, field: "registry_fetched_at" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "import_prepared_rows", timestamps: false, modelName: "ImportPreparedRow" },
);

export type PreparedSetExecutionStatus =
  | "queued"
  | "running"
  | "waiting_attention"
  | "pause_requested"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export class PreparedSetExecutionModel extends Model {
  declare executionId: string;

  declare tenantId: string;

  declare batchId: string;

  declare preparationId: string;

  declare actorUserId: string;

  declare idempotencyKey: string;

  declare requestHash: string;

  declare snapshotFingerprint: string;

  declare referenceDate: string;

  declare status: PreparedSetExecutionStatus;

  declare cursorRowNumber: number;

  declare chunkCount: number;

  declare version: number;

  declare leaseOwner: string | null;

  declare leaseExpiresAt: Date | null;

  declare nextAttemptAt: Date | null;

  declare errorCode: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare finishedAt: Date | null;
}

registerModel(
  PreparedSetExecutionModel,
  {
    executionId: { type: DataTypes.UUID, primaryKey: true, field: "execution_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    preparationId: { type: DataTypes.UUID, allowNull: false, field: "preparation_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false, field: "idempotency_key" },

    requestHash: { type: DataTypes.STRING(64), allowNull: false, field: "request_hash" },

    snapshotFingerprint: { type: DataTypes.STRING(64), allowNull: false, field: "snapshot_fingerprint" },

    referenceDate: { type: DataTypes.DATEONLY, allowNull: false, field: "reference_date" },

    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },

    cursorRowNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "cursor_row_number" },

    chunkCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "chunk_count" },

    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    leaseOwner: { type: DataTypes.UUID, allowNull: true, field: "lease_owner" },

    leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "lease_expires_at" },

    nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: "next_attempt_at" },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
  },
  { tableName: "prepared_set_executions", timestamps: false, modelName: "PreparedSetExecution" },
);

export type PreparedSetChunkStatus =
  | "queued"
  | "submitting"
  | "running"
  | "waiting_attention"
  | "completed"
  | "cancelled"
  | "failed";

export class PreparedSetChunkModel extends Model {
  declare executionId: string;

  declare ordinal: number;

  declare rowNumbers: number[];

  declare firstRowNumber: number;

  declare lastRowNumber: number;

  declare inputFingerprint: string;

  declare status: PreparedSetChunkStatus;

  declare childSubmissionId: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare finishedAt: Date | null;
}

registerModel(
  PreparedSetChunkModel,
  {
    executionId: { type: DataTypes.UUID, primaryKey: true, field: "execution_id" },

    ordinal: { type: DataTypes.INTEGER, primaryKey: true },

    rowNumbers: { type: DataTypes.JSONB, allowNull: false, field: "row_numbers" },

    firstRowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "first_row_number" },

    lastRowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "last_row_number" },

    inputFingerprint: { type: DataTypes.STRING(64), allowNull: false, field: "input_fingerprint" },

    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },

    childSubmissionId: { type: DataTypes.UUID, allowNull: true, field: "child_submission_id" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
  },
  { tableName: "prepared_set_chunks", timestamps: false, modelName: "PreparedSetChunk" },
);
