import { Model, Sequelize } from "sequelize";
import { composePersistenceModels } from "../../composition/persistence-models";
import type { ModelStatic } from "sequelize";


import { persistenceModelsBoundTo, persistenceModelsAreBound } from "./model-registry";
import { UserNotificationModel } from "../../features/notifications";
import { AccountRecoveryTokenModel, AuthMailOutboxModel } from "../../features/account-recovery/account-recovery.model";
import { TenantModel, UserModel, UserSessionModel, TenantMembershipModel } from "../../features/identity/identity.model";
import { ToolGrantModel, ToolModel, ToolSettingsModel } from "../../features/tools/tool.model";
import { AuditEventModel } from "../../features/audit/audit.model";
import { ImportBatchModel, SourceRowModel, ImportPreparationWorkflowModel, ImportPreparationWorkflowJobModel, ImportPreparationModel, ImportPreparedRowModel, PreparedSetExecutionModel, PreparedSetChunkModel } from "../../features/imports";
import { RegonCorrectionModel, RegistryLookupCacheModel, RegistryEnrichmentAuditModel, EnrichmentJobModel, EnrichmentJobItemModel } from "../../features/enrichment";
import { CanonicalEntityModel, SourceEntityLinkModel, EntityGroupingConflictModel } from "../../features/grouping";
import { AutomationRunModel, RunSourceRowModel, RunEventModel, RunIdentityModel, RunManualDataOverrideModel, RunDispatchOutboxModel } from "../../features/runs";
import { AuthChallengeModel, ManualInterventionModel, InterventionActivityModel, InterventionUserReadModel } from "../../features/interventions";
import { OcSnapshotModel, OcPolicyRecordModel, ExportArtifactModel, ResultSetModel, LeadResultSnapshotModel } from "../../features/results";
import { RunSubmissionModel, RunSubmissionGroupModel, RunSubmissionItemModel } from "../../features/submissions";
import { BusinessLeadModel, LeadRunLinkModel, LeadAllocationModel } from "../../features/leads";
export type { EnrichmentJobStatus, EnrichmentJobItemStatus } from "../../features/enrichment";
export type { ImportPreparationStatus, ImportPreparationStage, ImportPreparationWorkflowStatus, PreparedRowStatus, PreparedSetExecutionStatus, PreparedSetChunkStatus } from "../../features/imports/imports.model";
export type { AuthMailOutboxStatus, RecoveryTokenPurpose } from "../../features/account-recovery/account-recovery.model";
export type { PortalId, AuthChallengeStatus, ManualInterventionKind, ManualInterventionStatus } from "../../features/interventions";
export type { RunDispatchIntent, RunDispatchStatus } from "../../features/runs";
export type { RunSubmissionStatus, RunSubmissionAdmissionState, RunSubmissionPreparationState } from "../../features/submissions";
export type { ResultSetStatus } from "../../features/results";
export type { BusinessLeadResultStatus, BusinessLeadContactStatus } from "../../features/leads";
export { registerPersistenceModels } from "./model-registry";
export type { NotificationEventType } from "../../features/notifications";




let defaultDatabase: Sequelize | null = null;
let defaultDatabaseUrl: string | null = null;
let configuredDatabaseUrl: string | null = null;
let defaultDatabaseClosed = false;
let databaseLeases = 0;

export function createDatabaseConnection(
  connectionString: string,
  composeModels: (connection: Sequelize) => void = composePersistenceModels,
): Sequelize {
  if (!connectionString.trim()) throw new Error("DATABASE_URL is required when the database is used");
  if (defaultDatabase) {
    if (defaultDatabaseClosed) throw new Error("DATABASE_CONNECTION_ALREADY_CLOSED");
    if (defaultDatabaseUrl !== connectionString) throw new Error("DATABASE_CONFIGURATION_CONFLICT");
    return defaultDatabase;
  }

  const connection = new Sequelize(connectionString, { logging: false });
  try {
    composeModels(connection);
    if (!persistenceModelsBoundTo(connection)) throw new Error("PERSISTENCE_MODELS_NOT_REGISTERED");
    defaultDatabase = connection;
    defaultDatabaseUrl = connectionString;
    return connection;
  } catch (error) {
    void connection.close().catch(() => undefined);
    throw error;
  }
}

/** Pins the URL loaded by an executable entrypoint before any lazy model is touched. */
export function configureDefaultDatabaseUrl(connectionString: string): void {
  if (!connectionString.trim()) throw new Error("DATABASE_URL is required when the database is used");
  if (defaultDatabaseUrl && defaultDatabaseUrl !== connectionString) throw new Error("DATABASE_CONFIGURATION_CONFLICT");
  if (configuredDatabaseUrl && configuredDatabaseUrl !== connectionString) throw new Error("DATABASE_CONFIGURATION_CONFLICT");
  configuredDatabaseUrl = connectionString;
}

/** Resolves the explicitly configured URL first, with env access centralized at the infrastructure boundary. */
export function resolveDefaultDatabaseUrl(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const connectionString = configuredDatabaseUrl ?? environment.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required when the database is used");
  return connectionString;
}

export function acquireDatabaseConnection(
  connectionString: string,
  composeModels?: (connection: Sequelize) => void,
): Sequelize {
  const connection = createDatabaseConnection(connectionString, composeModels);
  databaseLeases += 1;
  return connection;
}

export async function releaseDatabaseConnection(connection: Sequelize): Promise<void> {
  if (connection !== defaultDatabase) throw new Error("DATABASE_CONNECTION_MISMATCH");
  if (databaseLeases <= 0) return;
  databaseLeases -= 1;
  if (databaseLeases === 0) await closeDatabaseConnection(connection);
}

export async function closeDatabaseConnection(connection: Sequelize): Promise<void> {
  if (connection !== defaultDatabase || defaultDatabaseClosed) return;
  await connection.close();
  defaultDatabaseClosed = true;
}

function getDefaultDatabase(): Sequelize {
  if (defaultDatabase) {
    if (defaultDatabaseClosed) throw new Error("DATABASE_CONNECTION_ALREADY_CLOSED");
    return defaultDatabase;
  }
  const connectionString = resolveDefaultDatabaseUrl();
  return createDatabaseConnection(connectionString);
}

function ensureModelProxyInitialized(): void {
  // Unit suites may replace model methods after explicitly closing their
  // synthetic pool. Keep metadata/stubbing possible without reopening it.
  if (persistenceModelsAreBound() && defaultDatabaseClosed) return;
  getDefaultDatabase();
}

function lazyModelProxy<ModelClass extends ModelStatic<Model>>(model: ModelClass, modelName: string): ModelClass {
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === "prototype" || property === "length") return Reflect.get(target, property, receiver);
      if (property === "name") return modelName;
      ensureModelProxyInitialized();
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      ensureModelProxyInitialized();
      return Reflect.set(target, property, value, target);
    },
  });
}

export const sequelize = new Proxy({} as Sequelize, {
  get(_target, property) {
    if (property === "close") {
      if (!defaultDatabase) return async () => undefined;
      return () => closeDatabaseConnection(defaultDatabase!);
    }
    if (property === "constructor") return Sequelize;
    const connection = getDefaultDatabase();
    const value = Reflect.get(connection, property, connection);
    return typeof value === "function" ? value.bind(connection) : value;
  },
  set(_target, property, value) {
    const connection = getDefaultDatabase();
    return Reflect.set(connection, property, value, connection);
  },
}) as Sequelize;






























































































































































































































































































export type Tenant = InstanceType<typeof TenantModel>;
export const Tenant = lazyModelProxy(TenantModel, "Tenant");
export type User = InstanceType<typeof UserModel>;
export const User = lazyModelProxy(UserModel, "User");
export type AccountRecoveryToken = InstanceType<typeof AccountRecoveryTokenModel>;
export const AccountRecoveryToken = lazyModelProxy(AccountRecoveryTokenModel, "AccountRecoveryToken");
export type AuthMailOutbox = InstanceType<typeof AuthMailOutboxModel>;
export const AuthMailOutbox = lazyModelProxy(AuthMailOutboxModel, "AuthMailOutbox");
export type Tool = InstanceType<typeof ToolModel>;
export const Tool = lazyModelProxy(ToolModel, "Tool");
export type ToolGrant = InstanceType<typeof ToolGrantModel>;
export const ToolGrant = lazyModelProxy(ToolGrantModel, "ToolGrant");
export type ToolSettings = InstanceType<typeof ToolSettingsModel>;
export const ToolSettings = lazyModelProxy(ToolSettingsModel, "ToolSettings");
export type UserSession = InstanceType<typeof UserSessionModel>;
export const UserSession = lazyModelProxy(UserSessionModel, "UserSession");
export type TenantMembership = InstanceType<typeof TenantMembershipModel>;
export const TenantMembership = lazyModelProxy(TenantMembershipModel, "TenantMembership");
export type AuditEvent = InstanceType<typeof AuditEventModel>;
export const AuditEvent = lazyModelProxy(AuditEventModel, "AuditEvent");
export type ImportBatch = InstanceType<typeof ImportBatchModel>;
export const ImportBatch = lazyModelProxy(ImportBatchModel, "ImportBatch");
export type SourceRow = InstanceType<typeof SourceRowModel>;
export const SourceRow = lazyModelProxy(SourceRowModel, "SourceRow");
export type ImportPreparationWorkflow = InstanceType<typeof ImportPreparationWorkflowModel>;
export const ImportPreparationWorkflow = lazyModelProxy(ImportPreparationWorkflowModel, "ImportPreparationWorkflow");
export type ImportPreparationWorkflowJob = InstanceType<typeof ImportPreparationWorkflowJobModel>;
export const ImportPreparationWorkflowJob = lazyModelProxy(ImportPreparationWorkflowJobModel, "ImportPreparationWorkflowJob");
export type ImportPreparation = InstanceType<typeof ImportPreparationModel>;
export const ImportPreparation = lazyModelProxy(ImportPreparationModel, "ImportPreparation");
export type ImportPreparedRow = InstanceType<typeof ImportPreparedRowModel>;
export const ImportPreparedRow = lazyModelProxy(ImportPreparedRowModel, "ImportPreparedRow");
export type PreparedSetExecution = InstanceType<typeof PreparedSetExecutionModel>;
export const PreparedSetExecution = lazyModelProxy(PreparedSetExecutionModel, "PreparedSetExecution");
export type PreparedSetChunk = InstanceType<typeof PreparedSetChunkModel>;
export const PreparedSetChunk = lazyModelProxy(PreparedSetChunkModel, "PreparedSetChunk");
export type RegonCorrection = InstanceType<typeof RegonCorrectionModel>;
export const RegonCorrection = lazyModelProxy(RegonCorrectionModel, "RegonCorrection");
export type RegistryLookupCache = InstanceType<typeof RegistryLookupCacheModel>;
export const RegistryLookupCache = lazyModelProxy(RegistryLookupCacheModel, "RegistryLookupCache");
export type RegistryEnrichmentAudit = InstanceType<typeof RegistryEnrichmentAuditModel>;
export const RegistryEnrichmentAudit = lazyModelProxy(RegistryEnrichmentAuditModel, "RegistryEnrichmentAudit");
export type EnrichmentJob = InstanceType<typeof EnrichmentJobModel>;
export const EnrichmentJob = lazyModelProxy(EnrichmentJobModel, "EnrichmentJob");
export type EnrichmentJobItem = InstanceType<typeof EnrichmentJobItemModel>;
export const EnrichmentJobItem = lazyModelProxy(EnrichmentJobItemModel, "EnrichmentJobItem");
export type CanonicalEntity = InstanceType<typeof CanonicalEntityModel>;
export const CanonicalEntity = lazyModelProxy(CanonicalEntityModel, "CanonicalEntity");
export type SourceEntityLink = InstanceType<typeof SourceEntityLinkModel>;
export const SourceEntityLink = lazyModelProxy(SourceEntityLinkModel, "SourceEntityLink");
export type EntityGroupingConflict = InstanceType<typeof EntityGroupingConflictModel>;
export const EntityGroupingConflict = lazyModelProxy(EntityGroupingConflictModel, "EntityGroupingConflict");
export type AutomationRun = InstanceType<typeof AutomationRunModel>;
export const AutomationRun = lazyModelProxy(AutomationRunModel, "AutomationRun");
export type RunSourceRow = InstanceType<typeof RunSourceRowModel>;
export const RunSourceRow = lazyModelProxy(RunSourceRowModel, "RunSourceRow");
export type RunEvent = InstanceType<typeof RunEventModel>;
export const RunEvent = lazyModelProxy(RunEventModel, "RunEvent");
export type RunIdentity = InstanceType<typeof RunIdentityModel>;
export const RunIdentity = lazyModelProxy(RunIdentityModel, "RunIdentity");
export type OcSnapshot = InstanceType<typeof OcSnapshotModel>;
export const OcSnapshot = lazyModelProxy(OcSnapshotModel, "OcSnapshot");
export type OcPolicyRecord = InstanceType<typeof OcPolicyRecordModel>;
export const OcPolicyRecord = lazyModelProxy(OcPolicyRecordModel, "OcPolicyRecord");
export type ExportArtifact = InstanceType<typeof ExportArtifactModel>;
export const ExportArtifact = lazyModelProxy(ExportArtifactModel, "ExportArtifact");
export type AuthChallenge = InstanceType<typeof AuthChallengeModel>;
export const AuthChallenge = lazyModelProxy(AuthChallengeModel, "AuthChallenge");
export type ManualIntervention = InstanceType<typeof ManualInterventionModel>;
export const ManualIntervention = lazyModelProxy(ManualInterventionModel, "ManualIntervention");
export type InterventionActivity = InstanceType<typeof InterventionActivityModel>;
export const InterventionActivity = lazyModelProxy(InterventionActivityModel, "InterventionActivity");
export type InterventionUserRead = InstanceType<typeof InterventionUserReadModel>;
export const InterventionUserRead = lazyModelProxy(InterventionUserReadModel, "InterventionUserRead");
export type RunManualDataOverride = InstanceType<typeof RunManualDataOverrideModel>;
export const RunManualDataOverride = lazyModelProxy(RunManualDataOverrideModel, "RunManualDataOverride");
export type RunDispatchOutbox = InstanceType<typeof RunDispatchOutboxModel>;
export const RunDispatchOutbox = lazyModelProxy(RunDispatchOutboxModel, "RunDispatchOutbox");
export type RunSubmission = InstanceType<typeof RunSubmissionModel>;
export const RunSubmission = lazyModelProxy(RunSubmissionModel, "RunSubmission");
export type RunSubmissionGroup = InstanceType<typeof RunSubmissionGroupModel>;
export const RunSubmissionGroup = lazyModelProxy(RunSubmissionGroupModel, "RunSubmissionGroup");
export type RunSubmissionItem = InstanceType<typeof RunSubmissionItemModel>;
export const RunSubmissionItem = lazyModelProxy(RunSubmissionItemModel, "RunSubmissionItem");
export type ResultSet = InstanceType<typeof ResultSetModel>;
export const ResultSet = lazyModelProxy(ResultSetModel, "ResultSet");
export type LeadResultSnapshot = InstanceType<typeof LeadResultSnapshotModel>;
export const LeadResultSnapshot = lazyModelProxy(LeadResultSnapshotModel, "LeadResultSnapshot");
export type UserNotification = InstanceType<typeof UserNotificationModel>;
export const UserNotification = lazyModelProxy(UserNotificationModel, "UserNotification");
export type BusinessLead = InstanceType<typeof BusinessLeadModel>;
export const BusinessLead = lazyModelProxy(BusinessLeadModel, "BusinessLead");
export type LeadRunLink = InstanceType<typeof LeadRunLinkModel>;
export const LeadRunLink = lazyModelProxy(LeadRunLinkModel, "LeadRunLink");
export type LeadAllocation = InstanceType<typeof LeadAllocationModel>;
export const LeadAllocation = lazyModelProxy(LeadAllocationModel, "LeadAllocation");
