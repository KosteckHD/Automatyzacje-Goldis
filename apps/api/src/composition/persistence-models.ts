import type { Sequelize } from "sequelize";
import { registerAssociation, registerPersistenceModels } from "../infrastructure/database/model-registry";
import { ImportBatchModel, ImportPreparationModel, ImportPreparedRowModel, SourceRowModel } from "../features/imports/imports.model";
import { TenantModel, UserModel } from "../features/identity/identity.model";
import { AuditEventModel } from "../features/audit/audit.model";
import { RegonCorrectionModel } from "../features/enrichment/enrichment.model";
import { CanonicalEntityModel, EntityGroupingConflictModel, SourceEntityLinkModel } from "../features/grouping/grouping.model";
import { AutomationRunModel, RunIdentityModel, RunSourceRowModel } from "../features/runs/runs.model";
import { ExportArtifactModel, OcPolicyRecordModel, OcSnapshotModel } from "../features/results/results.model";
import { AuthChallengeModel, ManualInterventionModel } from "../features/interventions/interventions.model";

registerAssociation(() => ImportBatchModel.hasMany(SourceRowModel, { foreignKey: "batchId" }));

registerAssociation(() => SourceRowModel.belongsTo(ImportBatchModel, { foreignKey: "batchId" }));

registerAssociation(() => ImportBatchModel.hasMany(ImportPreparationModel, { foreignKey: "batchId" }));

registerAssociation(() => ImportPreparationModel.belongsTo(ImportBatchModel, { foreignKey: "batchId" }));

registerAssociation(() => ImportPreparationModel.hasMany(ImportPreparedRowModel, { foreignKey: "preparationId" }));

registerAssociation(() => ImportPreparedRowModel.belongsTo(ImportPreparationModel, { foreignKey: "preparationId" }));

registerAssociation(() => TenantModel.hasMany(ImportBatchModel, { foreignKey: "tenantId" }));

registerAssociation(() => ImportBatchModel.belongsTo(TenantModel, { foreignKey: "tenantId" }));

registerAssociation(() => UserModel.hasMany(ImportBatchModel, { foreignKey: "ownerUserId" }));

registerAssociation(() => ImportBatchModel.belongsTo(UserModel, { foreignKey: "ownerUserId" }));

registerAssociation(() => TenantModel.hasMany(AuditEventModel, { foreignKey: "tenantId" }));

registerAssociation(() => AuditEventModel.belongsTo(TenantModel, { foreignKey: "tenantId" }));

registerAssociation(() => UserModel.hasMany(AuditEventModel, { foreignKey: "actorUserId" }));

registerAssociation(() => AuditEventModel.belongsTo(UserModel, { foreignKey: "actorUserId" }));

registerAssociation(() => SourceRowModel.hasMany(RegonCorrectionModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => RegonCorrectionModel.belongsTo(SourceRowModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => SourceRowModel.hasOne(SourceEntityLinkModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => SourceEntityLinkModel.belongsTo(SourceRowModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => CanonicalEntityModel.hasMany(SourceEntityLinkModel, { foreignKey: "canonicalEntityId" }));

registerAssociation(() => SourceEntityLinkModel.belongsTo(CanonicalEntityModel, { foreignKey: "canonicalEntityId" }));

registerAssociation(() => SourceRowModel.hasMany(EntityGroupingConflictModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => EntityGroupingConflictModel.belongsTo(SourceRowModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => CanonicalEntityModel.hasMany(AutomationRunModel, { foreignKey: "canonicalEntityId" }));

registerAssociation(() => AutomationRunModel.belongsTo(CanonicalEntityModel, { foreignKey: "canonicalEntityId" }));

registerAssociation(() => AutomationRunModel.hasMany(RunSourceRowModel, { foreignKey: "runId" }));

registerAssociation(() => RunSourceRowModel.belongsTo(AutomationRunModel, { foreignKey: "runId" }));

registerAssociation(() => SourceRowModel.hasMany(RunSourceRowModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => RunSourceRowModel.belongsTo(SourceRowModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => AutomationRunModel.hasOne(RunIdentityModel, { foreignKey: "runId", onDelete: "CASCADE" }));

registerAssociation(() => RunIdentityModel.belongsTo(AutomationRunModel, { foreignKey: "runId" }));

registerAssociation(() => SourceRowModel.hasMany(RunIdentityModel, { foreignKey: "sourceRowId", onDelete: "CASCADE" }));

registerAssociation(() => RunIdentityModel.belongsTo(SourceRowModel, { foreignKey: "sourceRowId" }));

registerAssociation(() => AutomationRunModel.hasOne(OcSnapshotModel, { foreignKey: "runId", onDelete: "CASCADE" }));

registerAssociation(() => OcSnapshotModel.belongsTo(AutomationRunModel, { foreignKey: "runId" }));

registerAssociation(() => AutomationRunModel.hasMany(OcPolicyRecordModel, { foreignKey: "runId", onDelete: "CASCADE" }));

registerAssociation(() => OcPolicyRecordModel.belongsTo(AutomationRunModel, { foreignKey: "runId" }));

registerAssociation(() => AutomationRunModel.hasMany(ExportArtifactModel, { foreignKey: "runId", onDelete: "CASCADE" }));

registerAssociation(() => ExportArtifactModel.belongsTo(AutomationRunModel, { foreignKey: "runId" }));

registerAssociation(() => AutomationRunModel.hasMany(AuthChallengeModel, { foreignKey: "runId", onDelete: "CASCADE" }));

registerAssociation(() => AuthChallengeModel.belongsTo(AutomationRunModel, { foreignKey: "runId" }));

registerAssociation(() => AutomationRunModel.hasMany(ManualInterventionModel, { foreignKey: "runId", onDelete: "CASCADE" }));

registerAssociation(() => ManualInterventionModel.belongsTo(AutomationRunModel, { foreignKey: "runId" }));

registerAssociation(() => AuthChallengeModel.hasMany(ManualInterventionModel, { foreignKey: "challengeId", onDelete: "SET NULL" }));

registerAssociation(() => ManualInterventionModel.belongsTo(AuthChallengeModel, { foreignKey: "challengeId" }));

/** Binds all feature model definitions and cross-feature relations exactly once. */
export function composePersistenceModels(connection: Sequelize): void {
  registerPersistenceModels(connection);
}
