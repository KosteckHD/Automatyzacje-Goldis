import { DataTypes, Model, Sequelize } from "sequelize";
import type { RunStatus } from "@goldis/core";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

export const sequelize = new Sequelize(databaseUrl, { logging: false });

export class Tenant extends Model {
  declare tenantId: string;
  declare slug: string;
  declare displayName: string;
  declare createdAt: Date;
}

Tenant.init({
  tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },
  slug: { type: DataTypes.STRING(80), allowNull: false },
  displayName: { type: DataTypes.STRING(160), allowNull: false, field: "display_name" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "tenants", timestamps: false });

export class User extends Model {
  declare userId: string;
  declare username: string;
  declare usernameNormalized: string;
  declare passwordHash: string;
  declare status: "active" | "disabled";
  declare createdAt: Date;
  declare updatedAt: Date;
  declare lastLoginAt: Date | null;
  declare mustChangePassword: boolean;
}

User.init({
  userId: { type: DataTypes.UUID, primaryKey: true, field: "user_id" },
  username: { type: DataTypes.STRING(128), allowNull: false },
  usernameNormalized: { type: DataTypes.STRING(128), allowNull: false, field: "username_normalized" },
  passwordHash: { type: DataTypes.TEXT, allowNull: false, field: "password_hash" },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: "last_login_at" },
  mustChangePassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "must_change_password" },
}, { sequelize, tableName: "users", timestamps: false });

export class Tool extends Model {
  declare toolId: string;
  declare displayName: string;
  declare description: string;
  declare status: "available" | "maintenance" | "disabled";
  declare sortOrder: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Tool.init({
  toolId: { type: DataTypes.STRING(80), primaryKey: true, field: "tool_id" },
  displayName: { type: DataTypes.STRING(160), allowNull: false, field: "display_name" },
  description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  status: { type: DataTypes.STRING(20), allowNull: false },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, field: "sort_order" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
}, { sequelize, tableName: "tools", timestamps: false });

export class ToolGrant extends Model {
  declare tenantId: string;
  declare toolId: string;
  declare userId: string;
  declare canDiscover: boolean;
  declare canExecute: boolean;
  declare canViewResults: boolean;
  declare canDownloadResults: boolean;
  declare grantedBy: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare version: number;
}

ToolGrant.init({
  tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },
  toolId: { type: DataTypes.STRING(80), primaryKey: true, field: "tool_id" },
  userId: { type: DataTypes.UUID, primaryKey: true, field: "user_id" },
  canDiscover: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_discover" },
  canExecute: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_execute" },
  canViewResults: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_view_results" },
  canDownloadResults: { type: DataTypes.BOOLEAN, allowNull: false, field: "can_download_results" },
  grantedBy: { type: DataTypes.UUID, allowNull: true, field: "granted_by" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  version: { type: DataTypes.INTEGER, allowNull: false },
}, { sequelize, tableName: "tool_grants", timestamps: false });

export class ToolSettings extends Model {
  declare tenantId: string;
  declare toolId: string;
  declare enabledForNewRuns: boolean;
  declare maxNewRunsPerHour: number | null;
  declare allowedLocalStart: string | null;
  declare allowedLocalEnd: string | null;
  declare timezone: string;
  declare updatedBy: string | null;
  declare updatedAt: Date;
  declare version: number;
}

ToolSettings.init({
  tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },
  toolId: { type: DataTypes.STRING(80), primaryKey: true, field: "tool_id" },
  enabledForNewRuns: { type: DataTypes.BOOLEAN, allowNull: false, field: "enabled_for_new_runs" },
  maxNewRunsPerHour: { type: DataTypes.INTEGER, allowNull: true, field: "max_new_runs_per_hour" },
  allowedLocalStart: { type: DataTypes.TIME, allowNull: true, field: "allowed_local_start" },
  allowedLocalEnd: { type: DataTypes.TIME, allowNull: true, field: "allowed_local_end" },
  timezone: { type: DataTypes.STRING(80), allowNull: false },
  updatedBy: { type: DataTypes.UUID, allowNull: true, field: "updated_by" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  version: { type: DataTypes.INTEGER, allowNull: false },
}, { sequelize, tableName: "tool_settings", timestamps: false });

export class UserSession extends Model {
  declare sessionId: string;
  declare tenantId: string;
  declare userId: string;
  declare createdAt: Date;
  declare lastSeenAt: Date;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare revokedBy: string | null;
  declare revokeReason: "logout" | "admin" | "password_change" | "account_change" | "expired" | null;
  declare ipHash: string | null;
  declare browserLabel: string | null;
}

UserSession.init({
  sessionId: { type: DataTypes.UUID, primaryKey: true, field: "session_id" },
  tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
  userId: { type: DataTypes.UUID, allowNull: false, field: "user_id" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: "last_seen_at" },
  expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
  revokedAt: { type: DataTypes.DATE, allowNull: true, field: "revoked_at" },
  revokedBy: { type: DataTypes.UUID, allowNull: true, field: "revoked_by" },
  revokeReason: { type: DataTypes.STRING(32), allowNull: true, field: "revoke_reason" },
  ipHash: { type: DataTypes.STRING(64), allowNull: true, field: "ip_hash" },
  browserLabel: { type: DataTypes.STRING(80), allowNull: true, field: "browser_label" },
}, { sequelize, tableName: "user_sessions", timestamps: false });

export class TenantMembership extends Model {
  declare tenantId: string;
  declare userId: string;
  declare role: "admin" | "operator" | "reviewer" | "auditor";
  declare status: "active" | "invited" | "disabled";
  declare createdAt: Date;
  declare updatedAt: Date;
}

TenantMembership.init({
  tenantId: { type: DataTypes.UUID, primaryKey: true, field: "tenant_id" },
  userId: { type: DataTypes.UUID, primaryKey: true, field: "user_id" },
  role: { type: DataTypes.STRING(20), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
}, { sequelize, tableName: "tenant_memberships", timestamps: false });

export class AuditEvent extends Model {
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

AuditEvent.init({
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
}, { sequelize, tableName: "audit_events", timestamps: false });

export class ImportBatch extends Model {
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

ImportBatch.init({
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  tenantId: { type: DataTypes.UUID, allowNull: true, field: "tenant_id" },
  ownerUserId: { type: DataTypes.UUID, allowNull: true, field: "owner_user_id" },
  toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },
  fileName: { type: DataTypes.STRING(255), allowNull: false, field: "file_name" },
  sha256: { type: DataTypes.STRING(64), allowNull: false },
  totalRows: { type: DataTypes.INTEGER, allowNull: false, field: "total_rows" },
  invalidRows: { type: DataTypes.INTEGER, allowNull: false, field: "invalid_rows" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "import_batches", timestamps: false });

export class SourceRow extends Model {
  declare id: string;
  declare batchId: string;
  declare rowNumber: number;
  declare companyName: string;
  declare decisionMakerName: string | null;
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

SourceRow.init({
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  batchId: { type: DataTypes.UUID, allowNull: false, field: "batch_id" },
  rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "row_number" },
  companyName: { type: DataTypes.TEXT, allowNull: false, field: "company_name" },
  decisionMakerName: { type: DataTypes.TEXT, allowNull: true, field: "decision_maker_name" },
  nipRaw: { type: DataTypes.TEXT, allowNull: false, field: "nip_raw" },
  address: { type: DataTypes.TEXT, allowNull: false },
  postalCode: { type: DataTypes.TEXT, allowNull: false, field: "postal_code" },
  city: { type: DataTypes.TEXT, allowNull: false },
  regonRaw: { type: DataTypes.TEXT, allowNull: false, field: "regon_raw" },
  regon: { type: DataTypes.STRING(14), allowNull: true },
  effectiveRegon: { type: DataTypes.STRING(14), allowNull: true, field: "effective_regon" },
  rowVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "row_version" },
  issues: { type: DataTypes.JSONB, allowNull: false },
}, { sequelize, tableName: "source_rows", timestamps: false });

ImportBatch.hasMany(SourceRow, { foreignKey: "batchId" });
SourceRow.belongsTo(ImportBatch, { foreignKey: "batchId" });
Tenant.hasMany(TenantMembership, { foreignKey: "tenantId" });
TenantMembership.belongsTo(Tenant, { foreignKey: "tenantId" });
User.hasMany(TenantMembership, { foreignKey: "userId" });
TenantMembership.belongsTo(User, { foreignKey: "userId" });
Tenant.hasMany(ImportBatch, { foreignKey: "tenantId" });
ImportBatch.belongsTo(Tenant, { foreignKey: "tenantId" });
User.hasMany(ImportBatch, { foreignKey: "ownerUserId" });
ImportBatch.belongsTo(User, { foreignKey: "ownerUserId" });
Tenant.hasMany(AuditEvent, { foreignKey: "tenantId" });
AuditEvent.belongsTo(Tenant, { foreignKey: "tenantId" });
User.hasMany(AuditEvent, { foreignKey: "actorUserId" });
AuditEvent.belongsTo(User, { foreignKey: "actorUserId" });

export class RegonCorrection extends Model {
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

RegonCorrection.init({
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
}, { sequelize, tableName: "regon_corrections", timestamps: false });

export class RegistryLookupCache extends Model {
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

RegistryLookupCache.init({
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
}, { sequelize, tableName: "registry_lookup_cache", timestamps: false });

export class RegistryEnrichmentAudit extends Model {
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

RegistryEnrichmentAudit.init({
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
}, { sequelize, tableName: "regon_enrichment_audits", timestamps: false });

export type EnrichmentJobStatus = "queued" | "processing" | "completed" | "partial" | "failed" | "cancelled";
export type EnrichmentJobItemStatus = "pending" | "processing" | "matched" | "not_found" | "ambiguous"
  | "manual_review" | "excluded" | "failed" | "cancelled";

export class EnrichmentJob extends Model {
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

EnrichmentJob.init({
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
}, { sequelize, tableName: "enrichment_jobs", timestamps: false });

export class EnrichmentJobItem extends Model {
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

EnrichmentJobItem.init({
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
}, { sequelize, tableName: "enrichment_job_items", timestamps: false });

export class CanonicalEntity extends Model {
  declare canonicalEntityId: string;
  declare tenantId: string;
  declare nipNormalized: string | null;
  declare regon: string | null;
  declare businessName: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

CanonicalEntity.init({
  canonicalEntityId: { type: DataTypes.UUID, primaryKey: true, field: "canonical_entity_id" },
  tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
  nipNormalized: { type: DataTypes.STRING(10), allowNull: true, field: "nip_normalized" },
  regon: { type: DataTypes.STRING(14), allowNull: true },
  businessName: { type: DataTypes.TEXT, allowNull: false, field: "business_name" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
}, { sequelize, tableName: "canonical_entities", timestamps: false });

export class SourceEntityLink extends Model {
  declare sourceRowId: string;
  declare tenantId: string;
  declare canonicalEntityId: string;
  declare matchMethod: "nip_regon_exact" | "registry_verified" | "identifier_and_name_exact" | "manual";
  declare linkedAt: Date;
}

SourceEntityLink.init({
  sourceRowId: { type: DataTypes.UUID, primaryKey: true, field: "source_row_id" },
  tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
  canonicalEntityId: { type: DataTypes.UUID, allowNull: false, field: "canonical_entity_id" },
  matchMethod: { type: DataTypes.STRING(32), allowNull: false, field: "match_method" },
  linkedAt: { type: DataTypes.DATE, allowNull: false, field: "linked_at" },
}, { sequelize, tableName: "source_entity_links", timestamps: false });

export class EntityGroupingConflict extends Model {
  declare conflictId: string;
  declare sourceRowId: string;
  declare reasonCode: string;
  declare candidateEntityIds: string[];
  declare status: "open" | "resolved";
  declare resolutionNote: string | null;
  declare resolvedBy: string | null;
  declare resolvedAt: Date | null;
  declare createdAt: Date;
}

EntityGroupingConflict.init({
  conflictId: { type: DataTypes.UUID, primaryKey: true, field: "conflict_id" },
  sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },
  reasonCode: { type: DataTypes.STRING(80), allowNull: false, field: "reason_code" },
  candidateEntityIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "candidate_entity_ids" },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "open" },
  resolutionNote: { type: DataTypes.TEXT, allowNull: true, field: "resolution_note" },
  resolvedBy: { type: DataTypes.STRING(128), allowNull: true, field: "resolved_by" },
  resolvedAt: { type: DataTypes.DATE, allowNull: true, field: "resolved_at" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "entity_grouping_conflicts", timestamps: false });

SourceRow.hasMany(RegonCorrection, { foreignKey: "sourceRowId" });
RegonCorrection.belongsTo(SourceRow, { foreignKey: "sourceRowId" });
SourceRow.hasOne(SourceEntityLink, { foreignKey: "sourceRowId" });
SourceEntityLink.belongsTo(SourceRow, { foreignKey: "sourceRowId" });
CanonicalEntity.hasMany(SourceEntityLink, { foreignKey: "canonicalEntityId" });
SourceEntityLink.belongsTo(CanonicalEntity, { foreignKey: "canonicalEntityId" });
SourceRow.hasMany(EntityGroupingConflict, { foreignKey: "sourceRowId" });
EntityGroupingConflict.belongsTo(SourceRow, { foreignKey: "sourceRowId" });

export class AutomationRun extends Model {
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
  declare executionId: string | null;
  declare workerSessionId: string | null;
  declare leaseExpiresAt: Date | null;
  declare technicalCycleId: string | null;
  declare technicalAttemptCount: number;
  declare stagingFileId: string | null;
  declare stagingSha256: string | null;
  declare stagingKeyVersion: number | null;
  declare stagingFormatVersion: number | null;
  declare manualDataVersion: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

AutomationRun.init({
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
  executionId: { type: DataTypes.UUID, allowNull: true, field: "execution_id" },
  workerSessionId: { type: DataTypes.UUID, allowNull: true, field: "worker_session_id" },
  leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "lease_expires_at" },
  technicalCycleId: { type: DataTypes.UUID, allowNull: true, field: "technical_cycle_id" },
  technicalAttemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "technical_attempt_count" },
  stagingFileId: { type: DataTypes.UUID, allowNull: true, field: "staging_file_id" },
  stagingSha256: { type: DataTypes.STRING(64), allowNull: true, field: "staging_sha256" },
  stagingKeyVersion: { type: DataTypes.INTEGER, allowNull: true, field: "staging_key_version" },
  stagingFormatVersion: { type: DataTypes.INTEGER, allowNull: true, field: "staging_format_version" },
  manualDataVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "manual_data_version" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
}, { sequelize, tableName: "automation_runs", timestamps: true, underscored: true });

export class RunSourceRow extends Model {
  declare runId: string;
  declare sourceRowId: string;
  declare rowNumber: number;
  declare isPrimary: boolean;
  declare createdAt: Date;
}

RunSourceRow.init({
  runId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "run_id" },
  sourceRowId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "source_row_id" },
  rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: "row_number" },
  isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_primary" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "run_source_rows", timestamps: false });

CanonicalEntity.hasMany(AutomationRun, { foreignKey: "canonicalEntityId" });
AutomationRun.belongsTo(CanonicalEntity, { foreignKey: "canonicalEntityId" });
AutomationRun.hasMany(RunSourceRow, { foreignKey: "runId" });
RunSourceRow.belongsTo(AutomationRun, { foreignKey: "runId" });
SourceRow.hasMany(RunSourceRow, { foreignKey: "sourceRowId" });
RunSourceRow.belongsTo(SourceRow, { foreignKey: "sourceRowId" });

export class RunEvent extends Model {
  declare id: string;
  declare runId: string;
  declare status: RunStatus;
  declare step: string;
  declare errorCode: string | null;
  declare actorId: string | null;
  declare metadata: Record<string, unknown>;
  declare createdAt: Date;
}

RunEvent.init({
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },
  status: { type: DataTypes.STRING(40), allowNull: false },
  step: { type: DataTypes.STRING(80), allowNull: false },
  errorCode: { type: DataTypes.STRING(80), allowNull: true, field: "error_code" },
  actorId: { type: DataTypes.UUID, allowNull: true, field: "actor_id" },
  metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "run_events", timestamps: false });

export class RunIdentity extends Model {
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

RunIdentity.init({
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
}, { sequelize, tableName: "run_identities", timestamps: false });

export class OcSnapshot extends Model {
  declare runId: string;
  declare totalCount: number;
  declare capturedAt: Date;
  declare parserVersion: string;
}

OcSnapshot.init({
  runId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "run_id" },
  totalCount: { type: DataTypes.INTEGER, allowNull: false, field: "total_count" },
  capturedAt: { type: DataTypes.DATE, allowNull: false, field: "captured_at" },
  parserVersion: { type: DataTypes.STRING(80), allowNull: false, field: "parser_version" },
}, { sequelize, tableName: "oc_snapshots", timestamps: false });

export class OcPolicyRecord extends Model {
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

OcPolicyRecord.init({
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
}, { sequelize, tableName: "oc_policies", timestamps: false, underscored: true });

export class ExportArtifact extends Model {
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

ExportArtifact.init({
  artifactId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "artifact_id" },
  runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },
  fileName: { type: DataTypes.STRING(255), allowNull: false, field: "file_name" },
  storageKey: { type: DataTypes.TEXT, allowNull: false, field: "storage_key" },
  sha256: { type: DataTypes.STRING(64), allowNull: false },
  policyCount: { type: DataTypes.INTEGER, allowNull: false, field: "policy_count" },
  state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  readyAt: { type: DataTypes.DATE, allowNull: true, field: "ready_at" },
}, { sequelize, tableName: "export_artifacts", timestamps: false });

export type PortalId = "pzu" | "compensa";
export type AuthChallengeStatus = "active" | "claimed" | "submitted" | "consumed" | "invalidated" | "expired";

export class AuthChallenge extends Model {
  declare challengeId: string;
  declare runId: string;
  declare portal: PortalId;
  /** Opaque SHA-256/HMAC account fingerprint; never a username or credential. */
  declare accountKey: string;
  /** Opaque worker-owned browser session identifier, not a portal cookie. */
  declare browserSessionId: string;
  declare returnStep: string;
  declare status: AuthChallengeStatus;
  declare attemptCount: number;
  declare attemptLimit: number;
  declare expiresAt: Date;
  declare claimedAt: Date | null;
  declare consumedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare mfaCycleId: string | null;
}

AuthChallenge.init({
  challengeId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "challenge_id" },
  runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },
  portal: { type: DataTypes.STRING(16), allowNull: false },
  accountKey: { type: DataTypes.STRING(64), allowNull: false, field: "account_key" },
  browserSessionId: { type: DataTypes.STRING(128), allowNull: false, field: "browser_session_id" },
  returnStep: { type: DataTypes.STRING(80), allowNull: false, field: "return_step" },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },
  attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "attempt_count" },
  attemptLimit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5, field: "attempt_limit" },
  expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
  claimedAt: { type: DataTypes.DATE, allowNull: true, field: "claimed_at" },
  consumedAt: { type: DataTypes.DATE, allowNull: true, field: "consumed_at" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
  mfaCycleId: { type: DataTypes.UUID, allowNull: true, field: "mfa_cycle_id" },
}, { sequelize, tableName: "auth_challenges", timestamps: false });

export type ManualInterventionKind = "sms" | "identity_review" | "portal_error";
export type ManualInterventionStatus = "open" | "resolved" | "cancelled" | "expired";

export class ManualIntervention extends Model {
  declare interventionId: string;
  declare runId: string;
  declare challengeId: string | null;
  declare portal: PortalId | null;
  declare kind: ManualInterventionKind;
  declare status: ManualInterventionStatus;
  /** Safe classification only. User-entered SMS values and portal text are never stored. */
  declare reasonCode: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare revision: number;
  declare fieldCode: string | null;
  declare resolvedAt: Date | null;
  declare resolvedBy: string | null;
  declare assigneeUserId: string | null;
  declare priority: "normal" | "high";
  declare dueAt: Date | null;
  declare assignedAt: Date | null;
  declare assignedBy: string | null;
}

ManualIntervention.init({
  interventionId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "intervention_id" },
  runId: { type: DataTypes.UUID, allowNull: false, field: "run_id" },
  challengeId: { type: DataTypes.UUID, allowNull: true, field: "challenge_id" },
  portal: { type: DataTypes.STRING(16), allowNull: true },
  kind: { type: DataTypes.STRING(32), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "open" },
  reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  fieldCode: { type: DataTypes.STRING(48), allowNull: true, field: "field_code" },
  resolvedAt: { type: DataTypes.DATE, allowNull: true, field: "resolved_at" },
  resolvedBy: { type: DataTypes.UUID, allowNull: true, field: "resolved_by" },
  assigneeUserId: { type: DataTypes.UUID, allowNull: true, field: "assignee_user_id" },
  priority: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "normal" },
  dueAt: { type: DataTypes.DATE, allowNull: true, field: "due_at" },
  assignedAt: { type: DataTypes.DATE, allowNull: true, field: "assigned_at" },
  assignedBy: { type: DataTypes.UUID, allowNull: true, field: "assigned_by" },
}, { sequelize, tableName: "manual_interventions", timestamps: false });

export class InterventionActivity extends Model {
  declare activityId: string;
  declare interventionId: string;
  declare actorUserId: string;
  declare eventType: "assigned" | "unassigned" | "priority_changed" | "resolved";
  declare previousAssigneeUserId: string | null;
  declare nextAssigneeUserId: string | null;
  declare priority: "normal" | "high" | null;
  declare createdAt: Date;
}

InterventionActivity.init({
  activityId: { type: DataTypes.UUID, primaryKey: true, field: "activity_id" },
  interventionId: { type: DataTypes.UUID, allowNull: false, field: "intervention_id" },
  actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },
  eventType: { type: DataTypes.STRING(24), allowNull: false, field: "event_type" },
  previousAssigneeUserId: { type: DataTypes.UUID, allowNull: true, field: "previous_assignee_user_id" },
  nextAssigneeUserId: { type: DataTypes.UUID, allowNull: true, field: "next_assignee_user_id" },
  priority: { type: DataTypes.STRING(12), allowNull: true },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "intervention_activity", timestamps: false });

export class InterventionUserRead extends Model {
  declare interventionId: string;
  declare userId: string;
  declare seenRevision: number;
  declare updatedAt: Date;
}

InterventionUserRead.init({
  interventionId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "intervention_id" },
  userId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: "user_id" },
  seenRevision: { type: DataTypes.INTEGER, allowNull: false, field: "seen_revision" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
}, { sequelize, tableName: "intervention_user_reads", timestamps: false });

export class RunManualDataOverride extends Model {
  declare runId: string;
  declare version: number;
  declare source: "admin_correction";
  declare fields: Record<string, string>;
  declare reason: string;
  declare createdBy: string;
  declare createdAt: Date;
}

RunManualDataOverride.init({
  runId: { type: DataTypes.UUID, primaryKey: true, field: "run_id" },
  version: { type: DataTypes.INTEGER, primaryKey: true },
  source: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "admin_correction" },
  fields: { type: DataTypes.JSONB, allowNull: false },
  reason: { type: DataTypes.STRING(300), allowNull: false },
  createdBy: { type: DataTypes.UUID, allowNull: false, field: "created_by" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "run_manual_data_overrides", timestamps: false });

export type RunDispatchIntent = "create" | "resume_auth" | "resume_review" | "recovery" | "result_delivery";
export type RunDispatchStatus = "pending" | "publishing" | "published" | "consumed" | "cancelled" | "blocked";

export class RunDispatchOutbox extends Model {
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

RunDispatchOutbox.init({
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
}, { sequelize, tableName: "run_dispatch_outbox", timestamps: false });

export type RunSubmissionStatus = "queued" | "running" | "waiting_attention" | "completed" | "cancelled";
export class RunSubmission extends Model {
  declare submissionId: string;
  declare importBatchId: string;
  declare tenantId: string;
  declare toolId: string;
  declare actorUserId: string;
  declare idempotencyKey: string;
  declare requestHash: string;
  declare referenceDate: string;
  declare status: RunSubmissionStatus;
  declare version: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

RunSubmission.init({
  submissionId: { type: DataTypes.UUID, primaryKey: true, field: "submission_id" },
  importBatchId: { type: DataTypes.UUID, allowNull: false, field: "import_batch_id" },
  tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
  toolId: { type: DataTypes.STRING(80), allowNull: false, field: "tool_id" },
  actorUserId: { type: DataTypes.UUID, allowNull: false, field: "actor_user_id" },
  idempotencyKey: { type: DataTypes.STRING(128), allowNull: false, field: "idempotency_key" },
  requestHash: { type: DataTypes.STRING(64), allowNull: false, field: "request_hash" },
  referenceDate: { type: DataTypes.DATEONLY, allowNull: false, field: "reference_date" },
  status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },
  version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
}, { sequelize, tableName: "run_submissions", timestamps: false });

export type RunSubmissionAdmissionState = "pending" | "leased" | "waiting_capacity" | "waiting_window" | "waiting_paused" | "accepted" | "blocked" | "cancelled";
export class RunSubmissionGroup extends Model {
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

RunSubmissionGroup.init({
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
}, { sequelize, tableName: "run_submission_groups", timestamps: false });

export type RunSubmissionPreparationState = "ready" | "review" | "excluded";
export class RunSubmissionItem extends Model {
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

RunSubmissionItem.init({
  itemId: { type: DataTypes.UUID, primaryKey: true, field: "item_id" },
  submissionId: { type: DataTypes.UUID, allowNull: false, field: "submission_id" },
  importBatchId: { type: DataTypes.UUID, allowNull: false, field: "import_batch_id" },
  sourceRowId: { type: DataTypes.UUID, allowNull: false, field: "source_row_id" },
  groupId: { type: DataTypes.UUID, allowNull: true, field: "group_id" },
  expectedRowVersion: { type: DataTypes.INTEGER, allowNull: false, field: "expected_row_version" },
  preparationState: { type: DataTypes.STRING(16), allowNull: false, field: "preparation_state" },
  reasonCode: { type: DataTypes.STRING(80), allowNull: true, field: "reason_code" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, { sequelize, tableName: "run_submission_items", timestamps: false });

AutomationRun.hasOne(RunIdentity, { foreignKey: "runId", onDelete: "CASCADE" });
RunIdentity.belongsTo(AutomationRun, { foreignKey: "runId" });
SourceRow.hasMany(RunIdentity, { foreignKey: "sourceRowId", onDelete: "CASCADE" });
RunIdentity.belongsTo(SourceRow, { foreignKey: "sourceRowId" });
AutomationRun.hasOne(OcSnapshot, { foreignKey: "runId", onDelete: "CASCADE" });
OcSnapshot.belongsTo(AutomationRun, { foreignKey: "runId" });
AutomationRun.hasMany(OcPolicyRecord, { foreignKey: "runId", onDelete: "CASCADE" });
OcPolicyRecord.belongsTo(AutomationRun, { foreignKey: "runId" });
AutomationRun.hasMany(ExportArtifact, { foreignKey: "runId", onDelete: "CASCADE" });
ExportArtifact.belongsTo(AutomationRun, { foreignKey: "runId" });
AutomationRun.hasMany(AuthChallenge, { foreignKey: "runId", onDelete: "CASCADE" });
AuthChallenge.belongsTo(AutomationRun, { foreignKey: "runId" });
AutomationRun.hasMany(ManualIntervention, { foreignKey: "runId", onDelete: "CASCADE" });
ManualIntervention.belongsTo(AutomationRun, { foreignKey: "runId" });
AuthChallenge.hasMany(ManualIntervention, { foreignKey: "challengeId", onDelete: "SET NULL" });
ManualIntervention.belongsTo(AuthChallenge, { foreignKey: "challengeId" });
