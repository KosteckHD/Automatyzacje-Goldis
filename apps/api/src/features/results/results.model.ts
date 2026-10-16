import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type ResultSetStatus = "queued" | "running" | "waiting_attention" | "completed" | "cancelled" | "failed";

export class OcSnapshotModel extends Model {
  declare runId: string;

  declare totalCount: number;

  declare capturedAt: Date;

  declare parserVersion: string;
}

registerModel(
  OcSnapshotModel,
  {
    runId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "run_id" },

    totalCount: { type: DataTypes.INTEGER, allowNull: false, field: "total_count" },

    capturedAt: { type: DataTypes.DATE, allowNull: false, field: "captured_at" },

    parserVersion: { type: DataTypes.STRING(80), allowNull: false, field: "parser_version" },
  },
  { tableName: "oc_snapshots", timestamps: false, modelName: "OcSnapshot" },
);

export class OcPolicyRecordModel extends Model {
  declare id: string;

  declare runId: string;

  declare sourceOrdinal: number;

  declare insuredName: string | null;

  declare policyTypeAndNumber: string;

  declare contractType: string | null;

  declare insuredClaimCount: number | null;

  declare vehicleRegistration: string | null;

  declare vehicleGroup: string | null;

  declare vehicleMake: string | null;

  declare vehicleModel: string | null;

  declare insurer: string | null;

  declare coverageFrom: string | null;

  declare coverageTo: string;
}

registerModel(
  OcPolicyRecordModel,
  {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: DataTypes.UUIDV4 },

    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },

    sourceOrdinal: { type: DataTypes.INTEGER, allowNull: false, field: "source_ordinal" },

    insuredName: { type: DataTypes.TEXT, allowNull: true, field: "insured_name" },

    policyTypeAndNumber: { type: DataTypes.TEXT, allowNull: false, field: "policy_type_and_number" },

    contractType: { type: DataTypes.TEXT, allowNull: true, field: "contract_type" },

    insuredClaimCount: { type: DataTypes.INTEGER, allowNull: true, field: "insured_claim_count" },

    vehicleRegistration: { type: DataTypes.TEXT, allowNull: true, field: "vehicle_registration" },

    vehicleGroup: { type: DataTypes.TEXT, allowNull: true, field: "vehicle_group" },

    vehicleMake: { type: DataTypes.TEXT, allowNull: true, field: "vehicle_make" },

    vehicleModel: { type: DataTypes.TEXT, allowNull: true, field: "vehicle_model" },

    insurer: { type: DataTypes.TEXT, allowNull: true },

    coverageFrom: { type: DataTypes.DATEONLY, allowNull: true, field: "coverage_from" },

    coverageTo: { type: DataTypes.DATEONLY, allowNull: false, field: "coverage_to" },
  },
  { tableName: "oc_policies", timestamps: false, underscored: true, modelName: "OcPolicyRecord" },
);

export class ExportArtifactModel extends Model {
  declare artifactId: string;

  declare runId: string;

  declare fileName: string;

  declare storageKey: string;

  declare sha256: string;

  declare policyCount: number;

  declare state: "pending" | "ready" | "failed";

  declare createdAt: Date;

  declare readyAt: Date | null;
}

registerModel(
  ExportArtifactModel,
  {
    artifactId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "artifact_id" },

    runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },

    fileName: { type: DataTypes.STRING(255), allowNull: false, field: "file_name" },

    storageKey: { type: DataTypes.TEXT, allowNull: false, field: "storage_key" },

    sha256: { type: DataTypes.STRING(64), allowNull: false },

    policyCount: { type: DataTypes.INTEGER, allowNull: false, field: "policy_count" },

    state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    readyAt: { type: DataTypes.DATE, allowNull: true, field: "ready_at" },
  },
  { tableName: "export_artifacts", timestamps: false, modelName: "ExportArtifact" },
);

export class ResultSetModel extends Model {
  declare resultSetId: string;

  declare tenantId: string;

  declare batchId: string | null;

  declare sourceImportDeletedAt: Date | null;

  declare toolId: string;

  declare actorUserId: string;

  declare sourceType: "prepared_set_execution" | "run_submission";

  declare sourceId: string;

  declare referenceDate: string;

  declare status: ResultSetStatus;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare finishedAt: Date | null;
}

registerModel(
  ResultSetModel,
  {
    resultSetId: { type: DataTypes.UUID, primaryKey: true, field: "result_set_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    batchId: { type: DataTypes.UUID, allowNull: true, field: "batch_id" },

    sourceImportDeletedAt: { type: DataTypes.DATE, allowNull: true, field: "source_import_deleted_at" },

    toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    sourceType: { type: DataTypes.STRING(32), allowNull: false, field: "source_type" },

    sourceId: { type: DataTypes.UUID, allowNull: false, field: "source_id" },

    referenceDate: { type: DataTypes.DATEONLY, allowNull: false, field: "reference_date" },

    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
  },
  { tableName: "result_sets", timestamps: false, modelName: "ResultSet" },
);

export class LeadResultSnapshotModel extends Model {
  declare snapshotId: string;

  declare tenantId: string;

  declare leadId: string;

  declare originalRunId: string;

  declare originalSourceRowId: string;

  declare sourceOwnerUserId: string;

  declare referenceDate: string;

  declare companyFields: {
    schemaVersion: 2;
    companyName: string;
    effectiveRegon: string;
    decisionMakerName: string | null;
    mobile: string;
    phone: string;
    email: string;
  };

  declare peselCiphertext: string;

  declare peselKeyVersion: number;

  declare policies: Record<string, unknown>[];

  declare policyCount: number;

  declare checksum: string;

  declare schemaVersion: number;

  declare createdAt: Date;
}

registerModel(
  LeadResultSnapshotModel,
  {
    snapshotId: { type: DataTypes.UUID, primaryKey: true, field: "snapshot_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    leadId: { type: DataTypes.UUID, allowNull: false, field: "lead_id" },

    originalRunId: { type: DataTypes.UUID, allowNull: false, field: "original_run_id" },

    originalSourceRowId: { type: DataTypes.UUID, allowNull: false, field: "original_source_row_id" },

    sourceOwnerUserId: { type: DataTypes.UUID, allowNull: false, field: "source_owner_user_id" },

    referenceDate: { type: DataTypes.DATEONLY, allowNull: false, field: "reference_date" },

    companyFields: { type: DataTypes.JSONB, allowNull: false, field: "company_fields" },

    peselCiphertext: { type: DataTypes.TEXT, allowNull: false, field: "pesel_ciphertext" },

    peselKeyVersion: { type: DataTypes.INTEGER, allowNull: false, field: "pesel_key_version" },

    policies: { type: DataTypes.JSONB, allowNull: false },

    policyCount: { type: DataTypes.INTEGER, allowNull: false, field: "policy_count" },

    checksum: { type: DataTypes.STRING(64), allowNull: false },

    schemaVersion: { type: DataTypes.INTEGER, allowNull: false, field: "schema_version" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "lead_result_snapshots", timestamps: false, modelName: "LeadResultSnapshot" },
);
