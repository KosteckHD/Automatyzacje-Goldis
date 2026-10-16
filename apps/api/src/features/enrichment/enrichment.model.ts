import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";
export class RegonCorrectionModel extends Model {
  declare correctionId: string;

  declare sourceRowId: string;

  declare authorRef: string;

  declare reason: string;

  declare previousRegon: string | null;

  declare proposedRegon: string;

  declare status: "pending" | "approved" | "rejected";

  declare reviewerRef: string | null;

  declare reviewedAt: Date | null;

  declare reviewReason: string | null;

  declare createdAt: Date;
}

registerModel(
  RegonCorrectionModel,
  {
    correctionId: { type: DataTypes.UUID, primaryKey: true, field: "correction_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    authorRef: { type: DataTypes.STRING(128), allowNull: false, field: "author_ref" },

    reason: { type: DataTypes.TEXT, allowNull: false },

    previousRegon: { type: DataTypes.STRING(14), allowNull: true, field: "previous_regon" },

    proposedRegon: { type: DataTypes.STRING(14), allowNull: false, field: "proposed_regon" },

    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },

    reviewerRef: { type: DataTypes.STRING(128), allowNull: true, field: "reviewer_ref" },

    reviewedAt: { type: DataTypes.DATE, allowNull: true, field: "reviewed_at" },

    reviewReason: { type: DataTypes.TEXT, allowNull: true, field: "review_reason" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "regon_corrections", timestamps: false, modelName: "RegonCorrection" },
);

export class RegistryLookupCacheModel extends Model {
  declare lookupId: string;

  declare nipNormalized: string;

  declare dataVersion: string;

  declare status: "pending" | "matched" | "not_found" | "ambiguous" | "unavailable" | "manual_review";

  declare resultCount: number;

  declare responseFingerprint: string | null;

  declare attemptCount: number;

  declare errorCode: string | null;

  declare checkedAt: Date;

  declare expiresAt: Date | null;

  declare createdAt: Date;

  declare updatedAt: Date;
}

registerModel(
  RegistryLookupCacheModel,
  {
    lookupId: { type: DataTypes.UUID, primaryKey: true, field: "lookup_id" },

    nipNormalized: { type: DataTypes.STRING(10), allowNull: false, field: "nip_normalized" },

    dataVersion: { type: DataTypes.STRING(64), allowNull: false, field: "data_version" },

    status: { type: DataTypes.STRING(20), allowNull: false },

    resultCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "result_count" },

    responseFingerprint: { type: DataTypes.STRING(64), allowNull: true, field: "response_fingerprint" },

    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "attempt_count" },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    checkedAt: { type: DataTypes.DATE, allowNull: false, field: "checked_at" },

    expiresAt: { type: DataTypes.DATE, allowNull: true, field: "expires_at" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  },
  { tableName: "registry_lookup_cache", timestamps: false, modelName: "RegistryLookupCache" },
);

export class RegistryEnrichmentAuditModel extends Model {
  declare auditId: string;

  declare sourceRowId: string;

  declare nipNormalized: string;

  declare providerName: string;

  declare providerVersion: string;

  declare dataVersionLabel: string | null;

  declare dataVersionHash: string;

  declare responseFingerprint: string;

  declare candidateCount: number;

  declare decisionStatus: "matched" | "not_found" | "ambiguous" | "manual_review";

  declare reasonCode: string | null;

  declare proposedRegon: string | null;

  declare effectiveRegonBefore: string | null;

  declare effectiveRegonAfter: string | null;

  declare applied: boolean;

  declare rowVersionBefore: number;

  declare rowVersionAfter: number;

  declare createdAt: Date;
}

registerModel(
  RegistryEnrichmentAuditModel,
  {
    auditId: { type: DataTypes.UUID, primaryKey: true, field: "audit_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    nipNormalized: { type: DataTypes.STRING(10), allowNull: false, field: "nip_normalized" },

    providerName: { type: DataTypes.STRING(120), allowNull: false, field: "provider_name" },

    providerVersion: { type: DataTypes.STRING(80), allowNull: false, field: "provider_version" },

    dataVersionLabel: { type: DataTypes.STRING(120), allowNull: true, field: "data_version_label" },

    dataVersionHash: { type: DataTypes.STRING(64), allowNull: false, field: "data_version_hash" },

    responseFingerprint: { type: DataTypes.STRING(64), allowNull: false, field: "response_fingerprint" },

    candidateCount: { type: DataTypes.INTEGER, allowNull: false, field: "candidate_count" },

    decisionStatus: { type: DataTypes.STRING(20), allowNull: false, field: "decision_status" },

    reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },

    proposedRegon: { type: DataTypes.STRING(14), allowNull: true, field: "proposed_regon" },

    effectiveRegonBefore: { type: DataTypes.STRING(14), allowNull: true, field: "effective_regon_before" },

    effectiveRegonAfter: { type: DataTypes.STRING(14), allowNull: true, field: "effective_regon_after" },

    applied: { type: DataTypes.BOOLEAN, allowNull: false },

    rowVersionBefore: { type: DataTypes.INTEGER, allowNull: false, field: "row_version_before" },

    rowVersionAfter: { type: DataTypes.INTEGER, allowNull: false, field: "row_version_after" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  },
  { tableName: "regon_enrichment_audits", timestamps: false, modelName: "RegistryEnrichmentAudit" },
);

export type EnrichmentJobStatus = "queued" | "processing" | "completed" | "partial" | "failed" | "cancelled";

export type EnrichmentJobItemStatus =
  | "pending"
  | "processing"
  | "matched"
  | "not_found"
  | "ambiguous"
  | "manual_review"
  | "excluded"
  | "failed"
  | "cancelled";

export class EnrichmentJobModel extends Model {
  declare jobId: string;

  declare tenantId: string;

  declare batchId: string;

  declare actorUserId: string;

  declare idempotencyKey: string;

  declare selectionHash: string;

  declare status: EnrichmentJobStatus;

  declare selectedCount: number;

  declare completedCount: number;

  declare excludedCount: number;

  declare failedCount: number;

  declare cancelledCount: number;

  declare version: number;

  declare cancelRequested: boolean;

  declare leaseOwner: string | null;

  declare leaseExpiresAt: Date | null;

  declare errorCode: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare finishedAt: Date | null;
}

registerModel(
  EnrichmentJobModel,
  {
    jobId: { type: DataTypes.UUID, primaryKey: true, field: "job_id" },

    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },

    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false, field: "idempotency_key" },

    selectionHash: { type: DataTypes.STRING(64), allowNull: false, field: "selection_hash" },

    status: { type: DataTypes.STRING(20), allowNull: false },

    selectedCount: { type: DataTypes.INTEGER, allowNull: false, field: "selected_count" },

    completedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "completed_count" },

    excludedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "excluded_count" },

    failedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "failed_count" },

    cancelledCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "cancelled_count" },

    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    cancelRequested: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "cancel_requested" },

    leaseOwner: { type: DataTypes.UUID, allowNull: true, field: "lease_owner" },

    leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "lease_expires_at" },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
  },
  { tableName: "enrichment_jobs", timestamps: false, modelName: "EnrichmentJob" },
);

export class EnrichmentJobItemModel extends Model {
  declare itemId: string;

  declare jobId: string;

  declare batchId: string;

  declare sourceRowId: string;

  declare rowNumber: number;

  declare expectedRowVersion: number;

  declare status: EnrichmentJobItemStatus;

  declare reasonCode: string | null;

  declare errorCode: string | null;

  declare attemptCount: number;

  declare nextAttemptAt: Date | null;

  declare auditId: string | null;

  declare createdAt: Date;

  declare updatedAt: Date;

  declare finishedAt: Date | null;
}

registerModel(
  EnrichmentJobItemModel,
  {
    itemId: { type: DataTypes.UUID, primaryKey: true, field: "item_id" },

    jobId: { type: DataTypes.UUID, allowNull: false, field: "job_id" },

    batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },

    sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },

    rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "row_number" },

    expectedRowVersion: { type: DataTypes.INTEGER, allowNull: false, field: "expected_row_version" },

    status: { type: DataTypes.STRING(20), allowNull: false },

    reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },

    errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },

    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "attempt_count" },

    nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: "next_attempt_at" },

    auditId: { type: DataTypes.UUID, allowNull: true, field: "audit_id" },

    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },

    updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },

    finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
  },
  { tableName: "enrichment_job_items", timestamps: false, modelName: "EnrichmentJobItem" },
);
