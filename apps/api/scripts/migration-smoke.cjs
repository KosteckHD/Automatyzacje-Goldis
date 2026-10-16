const path = require("node:path");
require("reflect-metadata");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const { QueryTypes, Sequelize } = require("sequelize");
const { SequelizeStorage, Umzug } = require("umzug");

const mode = process.argv[2];
const targetDatabase = process.argv[3];
let smokeStage = "startup";
let tenantScopeSeed = null;
let groupingPerfBatchId = null;
const templateUrl = process.env.DATABASE_URL;
if (!templateUrl || !["empty", "from-006", "policies", "pesel", "snapshot", "evaluation", "artifacts", "export", "finalize", "download", "mfa", "registry", "corrections", "enrichment", "groups", "grouping-perf", "users", "users-empty", "tenant-scope", "teams", "admin-users", "registry-jobs", "reports", "deletion", "backup-restore", "run-control"].includes(mode) || !/^goldis_migration_smoke_[a-z0-9_]+$/.test(targetDatabase ?? "")) {
  console.error("MIGRATION_SMOKE_USAGE: mode empty|from-006|policies|pesel|snapshot|evaluation|artifacts|export|finalize|download|mfa|registry|corrections|enrichment|groups|grouping-perf|users|users-empty|tenant-scope|teams|registry-jobs|reports|backup-restore and a disposable goldis_migration_smoke_* database name are required");
  process.exit(2);
}

const parsedUrl = new URL(templateUrl);
parsedUrl.pathname = `/${targetDatabase}`;
const databaseUrl = parsedUrl.toString();
process.env.DATABASE_URL = databaseUrl;
const currentSourceModes = ["snapshot", "evaluation", "export", "finalize", "download", "mfa", "registry", "corrections"];
const tenantScopeModes = ["registry", "corrections", "enrichment", "groups", "grouping-perf", "users", "users-empty", "tenant-scope", "teams", "admin-users", "registry-jobs", "reports", "deletion", "backup-restore", "run-control"];
const latestMigration = tenantScopeModes.includes(mode) ? 62 : currentSourceModes.includes(mode) ? 12 : ["empty", "artifacts"].includes(mode) ? 9 : ["policies", "pesel"].includes(mode) ? 8 : 7;

function createImportService() {
  const { ImportService } = require("../dist/features/imports/import.service");
  const { sequelize: database } = require("../dist/infrastructure/database/db");
  const { AuditRepository } = require("../dist/features/audit/audit.repository");
  const { AuditService } = require("../dist/features/audit/audit.service");
  const { ImportsRepository } = require("../dist/features/imports/imports.repository");
  return new ImportService(database, new ImportsRepository(database), createAuditService());
}

function createAuditService() {
  const { AuditRepository } = require("../dist/features/audit/audit.repository");
  const { AuditService } = require("../dist/features/audit/audit.service");
  return new AuditService(new AuditRepository());
}

const sequelize = new Sequelize(databaseUrl, { logging: false });
const migrationPattern = latestMigration === 62
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],4[0-9],5[0-9],6[0-2]}-*.js"
  : latestMigration === 61
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],4[0-9],5[0-9],6[01]}-*.js"
  : latestMigration === 60
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],4[0-9],5[0-9],60}-*.js"
  : latestMigration === 58
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58}-*.js"
  : latestMigration === 57
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57}-*.js"
  : latestMigration === 56
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56}-*.js"
  : latestMigration === 55
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55}-*.js"
  : latestMigration === 54
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50,51,52,53,54}-*.js"
  : latestMigration === 53
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50,51,52,53}-*.js"
  : latestMigration === 51
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50,51}-*.js"
  : latestMigration === 50
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49,50}-*.js"
  : latestMigration === 49
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48,49}-*.js"
  : latestMigration === 48
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47,48}-*.js"
  : latestMigration === 47
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46,47}-*.js"
  : latestMigration === 46
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45,46}-*.js"
  : latestMigration === 45
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44,45}-*.js"
  : latestMigration === 44
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43,44}-*.js"
  : latestMigration === 43
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42,43}-*.js"
  : latestMigration === 42
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41,42}-*.js"
  : latestMigration === 41
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40,41}-*.js"
  : latestMigration === 40
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9],40}-*.js"
  : latestMigration === 39
  ? "0{0[1-9],1[0-9],2[0-9],3[0-9]}-*.js"
  : latestMigration === 38
  ? "0{0[1-9],1[0-9],2[0-9],3[0-8]}-*.js"
  : latestMigration === 37
  ? "0{0[1-9],1[0-9],2[0-9],3[0-7]}-*.js"
  : latestMigration === 36
  ? "0{0[1-9],1[0-9],2[0-9],3[0-6]}-*.js"
  : latestMigration === 35
  ? "0{0[1-9],1[0-9],2[0-9],3[0-5]}-*.js"
  : latestMigration === 34
  ? "0{0[1-9],1[0-9],2[0-9],3[01234]}-*.js"
  : latestMigration === 33
  ? "0{0[1-9],1[0-9],2[0-9],3[0123]}-*.js"
  : latestMigration === 32
  ? "0{0[1-9],1[0-9],2[0-9],3[012]}-*.js"
  : latestMigration === 31
  ? "0{0[1-9],1[0-9],2[0-9],3[01]}-*.js"
  : latestMigration === 30
  ? "0{0[1-9],1[0-9],2[0-9],3[0]}-*.js"
  : latestMigration === 29
  ? "0{0[1-9],1[0-9],2[0-9]}-*.js"
  : latestMigration === 28
  ? "0{0[1-9],1[0-9],2[0-8]}-*.js"
  : latestMigration === 27
  ? "0{0[1-9],1[0-9],2[0-7]}-*.js"
  : latestMigration === 26
  ? "0{0[1-9],1[0-9],2[0-6]}-*.js"
  : latestMigration === 25
  ? "0{0[1-9],1[0-9],2[0-5]}-*.js"
  : latestMigration === 24
  ? "0{0[1-9],1[0-9],2[0-4]}-*.js"
  : latestMigration === 23
  ? "0{0[1-9],1[0-9],2[0-3]}-*.js"
  : latestMigration === 20
  ? "0{0[1-9],1[0-9],20}-*.js"
  : latestMigration === 19
  ? "0{0[1-9],1[0-9]}-*.js"
  : latestMigration === 18
  ? "0{0[1-9],1[0-8]}-*.js"
  : latestMigration === 17
  ? "0{0[1-9],1[0-7]}-*.js"
  : latestMigration === 16
  ? "0{0[1-9],1[0-6]}-*.js"
  : latestMigration === 15
  ? "0{0[1-9],1[0-5]}-*.js"
  : latestMigration === 14
  ? "0{0[1-9],1[0-4]}-*.js"
  : latestMigration === 13
  ? "0{0[1-9],1[0-3]}-*.js"
  : latestMigration === 12
  ? "0{0[1-9],1[012]}-*.js"
  : latestMigration === 11
    ? "0{0[1-9],1[01]}-*.js"
  : latestMigration === 10
    ? "0{0[1-9],10}-*.js"
  : `00[1-${latestMigration}]-*.js`;
const umzug = new Umzug({
  migrations: { glob: path.join(__dirname, `../dist/infrastructure/database/migrations/${migrationPattern}`).replace(/\\/g, "/") },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: undefined,
});

async function upThrough(targetName) {
  const alreadyApplied = (await umzug.executed()).some((migration) => migration.name === targetName);
  if (!alreadyApplied) await umzug.up({ to: targetName });
}

async function upThroughLatestTenantSchema() {
  for (const migration of [
    "035-import-preparation-revisions.js", "036-import-preparation-audit-actions.js",
    "037-import-preparation-workflows.js", "038-prepared-set-executions.js",
    "039-run-input-snapshots.js", "040-prepared-set-pause-resume.js",
    "041-registry-provider-request-pacing.js", "042-deletion-step-up-prerequisites.js", "043-deletion-previews.js",
    "044-deletion-jobs-and-tombstones.js", "045-deletion-artifact-scope.js", "046-limit-active-deletion-job-scopes.js",
    "047-deletion-import-scope.js",
    "048-deletion-manual-barrier.js",
    "049-run-safe-pause-control.js",
    "050-deletion-journal-admission.js",
    "051-run-control-idempotency.js",
    "052-business-leads.js",
    "053-user-notifications.js", "054-source-mobile.js", "055-run-input-snapshot-contacts.js",
    "056-run-starter-and-sms-retries.js",
    "057-lead-assignment-release.js",
    "058-preserved-lead-results.js",
    "059-privileged-action-confirmations.js",
    "060-account-recovery-and-auth-mail.js", "061-optional-run-contact-person.js",
    "062-enrichment-worker-row-lock-capability.js",
  ]) {
    smokeStage = `tenant_schema_${migration}`;
    await upThrough(migration);
  }
  const journalState = await sequelize.query(
    "SELECT applied_sequence AS sequence, applied_hash AS hash FROM deletion_journal_state WHERE singleton_id = true",
    { type: QueryTypes.SELECT },
  );
  if (journalState.length !== 1 || Number(journalState[0].sequence) !== 0 || journalState[0].hash !== "0".repeat(64)) {
    throw new Error("DELETION_JOURNAL_STATE_NOT_INITIALIZED");
  }
  const newTables = await sequelize.query(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(ARRAY['result_sets', 'business_leads', 'lead_run_links', 'lead_allocations', 'user_notifications', 'lead_result_snapshots'])`,
    { type: QueryTypes.SELECT },
  );
  const tableNames = new Set(newTables.map(({ name }) => name));
  for (const name of ["result_sets", "business_leads", "lead_run_links", "lead_allocations", "user_notifications", "lead_result_snapshots"]) {
    if (!tableNames.has(name)) throw new Error(`LEAD_PLATFORM_TABLE_MISSING_${name}`);
  }
  const newConstraints = await sequelize.query(
    `SELECT conname AS name FROM pg_constraint WHERE conrelid IN
       ('result_sets'::regclass, 'business_leads'::regclass, 'lead_allocations'::regclass, 'user_notifications'::regclass, 'lead_result_snapshots'::regclass)`,
    { type: QueryTypes.SELECT },
  );
  const constraintNames = new Set(newConstraints.map(({ name }) => name));
  for (const name of ["result_sets_source_uidx", "business_leads_contact_status_valid", "business_leads_assignment_pair",
    "lead_allocations_leads_valid", "user_notifications_type_valid", "user_notifications_event_uidx",
    "lead_result_snapshots_lead_run_uidx", "lead_result_snapshots_policies_valid", "result_sets_batch_fk"]) {
    if (!constraintNames.has(name)) throw new Error(`LEAD_PLATFORM_CONSTRAINT_MISSING_${name}`);
  }
  const contactColumns = await sequelize.query(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'source_rows' AND column_name = ANY(ARRAY['mobile', 'phone', 'email'])`,
    { type: QueryTypes.SELECT },
  );
  if (new Set(contactColumns.map(({ name }) => name)).size !== 3) throw new Error("SOURCE_CONTACT_COLUMNS_MISSING");
  const snapshotColumns = await sequelize.query(
    `SELECT column_name AS name, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'result_sets' AND column_name = ANY(ARRAY['batch_id', 'source_import_deleted_at'])`,
    { type: QueryTypes.SELECT },
  );
  if (snapshotColumns.length !== 2 || snapshotColumns.find(({ name }) => name === "batch_id")?.nullable !== "YES") {
    throw new Error("RESULT_SET_IMPORT_DETACH_SCHEMA_INVALID");
  }
}

async function verifyRunPauseControl() {
  const runId = tenantScopeSeed.goldis.runId;
  const actorId = tenantScopeSeed.goldisActorId;
  const now = new Date();
  await sequelize.query(
    `UPDATE automation_runs SET status = 'compensa_form', current_step = 'compensa_form',
       control_state = 'pause_requested', control_revision = 3, control_ack_revision = 2,
       control_requested_by = $2, control_requested_at = $3 WHERE id = $1`,
    { bind: [runId, actorId, now] },
  );
  await sequelize.query(
    `UPDATE automation_runs SET control_state = 'paused', control_ack_revision = control_revision,
       control_acknowledged_at = $2, control_checkpoint_status = status WHERE id = $1`, { bind: [runId, now] },
  );
  const [ack] = await sequelize.query(
    `SELECT control_state, control_revision, control_ack_revision, control_checkpoint_status
       FROM automation_runs WHERE id = $1`, { bind: [runId] },
  );
  if (ack[0]?.control_state !== "paused" || Number(ack[0].control_revision) !== 3
    || Number(ack[0].control_ack_revision) !== 3 || ack[0].control_checkpoint_status !== "compensa_form") {
    throw new Error("RUN_CONTROL_SAFE_ACK_MISMATCH");
  }
  let staleAckBlocked = false;
  try {
    await sequelize.query(
      `UPDATE automation_runs SET control_ack_revision = control_revision - 1 WHERE id = $1`, { bind: [runId] },
    );
  } catch { staleAckBlocked = true; }
  if (!staleAckBlocked) throw new Error("RUN_CONTROL_STALE_ACK_WAS_ACCEPTED");
  await sequelize.query(
    `UPDATE automation_runs SET control_state = 'running', control_revision = control_revision + 1,
       control_requested_at = $2 WHERE id = $1`, { bind: [runId, now] },
  );
  const [resumed] = await sequelize.query(
    `SELECT control_state, control_revision, control_ack_revision FROM automation_runs WHERE id = $1`, { bind: [runId] },
  );
  if (resumed[0]?.control_state !== "running" || Number(resumed[0].control_revision) !== 4
    || Number(resumed[0].control_ack_revision) !== 3) throw new Error("RUN_CONTROL_RESUME_REVISION_MISMATCH");
  console.log("RUN_CONTROL_MIGRATION_PASS pauseRequest=true safeAck=true staleAckBlocked=true resumeRevision=true");
}

async function verifyRegistryRequestPacing() {
  const { createRegistryRequestPacerStore } = require("../dist/features/enrichment/public");
  const providerName = `migration-smoke-${randomUUID().slice(0, 8)}`;
  const intervalMs = 120;
  const independentClients = [new Sequelize(databaseUrl, { logging: false }), new Sequelize(databaseUrl, { logging: false })];
  const stores = independentClients.map((client) => createRegistryRequestPacerStore((sql, bind) =>
    client.query(sql, { bind: [...bind], type: QueryTypes.SELECT })));
  try {
    const now = new Date();
    const slots = await Promise.all(stores.map((store) => store.reserveSlot(providerName, intervalMs, now)));
    slots.sort((left, right) => left.getTime() - right.getTime());
    if (slots.length !== 2 || slots[1].getTime() - slots[0].getTime() < intervalMs) {
      throw new Error("REGISTRY_REQUEST_PACING_CONCURRENT_SLOT_MISMATCH");
    }

    const cooldownUntil = new Date(Date.now() + 400);
    await stores[0].saveCooldown(providerName, intervalMs, cooldownUntil, new Date());
    const afterCooldown = await stores[1].reserveSlot(providerName, intervalMs, new Date());
    if (afterCooldown.getTime() < cooldownUntil.getTime() - 2) {
      throw new Error("REGISTRY_REQUEST_PACING_RETRY_AFTER_MISMATCH");
    }
    const [persisted] = await sequelize.query(
      "SELECT min_interval_ms, cooldown_until FROM registry_provider_request_pacing WHERE provider_name = $1",
      { bind: [providerName] },
    );
    if (persisted.length !== 1 || Number(persisted[0].min_interval_ms) !== intervalMs
      || new Date(persisted[0].cooldown_until).getTime() !== cooldownUntil.getTime()) {
      throw new Error("REGISTRY_REQUEST_PACING_STATE_NOT_PERSISTED");
    }

    let configurationMismatchDetected = false;
    try { await stores[0].reserveSlot(providerName, intervalMs + 1, new Date()); }
    catch (error) { configurationMismatchDetected = error?.message === "REGISTRY_REQUEST_PACER_CONFIGURATION_MISMATCH"; }
    if (!configurationMismatchDetected) throw new Error("REGISTRY_REQUEST_PACING_INTERVAL_MISMATCH_NOT_CLOSED");
    console.log("REGISTRY_REQUEST_PACING_SMOKE_PASS independentClients=2 spacing=true retryAfter=true persisted=true configMismatch=closed externalRequests=0");
  } finally {
    await sequelize.query("DELETE FROM registry_provider_request_pacing WHERE provider_name = $1", { bind: [providerName] });
    await Promise.all(independentClients.map((client) => client.close()));
  }
}

async function assignSyntheticBatchToGoldis(batchId, username = "Synthetic.Scope.Admin") {
  const models = require("../dist/infrastructure/database/db");
  const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
  if (!tenant) throw new Error("TENANT_SCOPE_GOLDIS_TENANT_MISSING");
  const now = new Date();
  const userId = randomUUID();
  // This helper is used before the historical migration sequence reaches the
  // current users schema. Keep its insert aligned with columns present since
  // migration 015 instead of using the latest Sequelize model (which includes
  // later columns such as credential_revision).
  await sequelize.query(
    `INSERT INTO users (user_id, username, username_normalized, password_hash, status, created_at, updated_at, last_login_at)
     VALUES ($1, $2, $3, 'synthetic-password-hash-0123456789abcdef', 'active', $4, $4, NULL)`,
    { bind: [userId, username, username.toLowerCase(), now] },
  );
  await models.TenantMembership.create({
    tenantId: tenant.tenantId, userId, role: "admin", status: "active", createdAt: now, updatedAt: now,
  });
  await sequelize.query(
    "UPDATE import_batches SET tenant_id = $1, owner_user_id = $2 WHERE id = $3",
    { bind: [tenant.tenantId, userId, batchId] },
  );
  return { tenant, userId };
}

async function seedLegacyRun(status = "awaiting_portal_adapter", referenceDate = "2026-09-30", decisionMakerName = null) {
  const batchId = randomUUID();
  const sourceRowId = randomUUID();
  const runId = randomUUID();
  const eventId = randomUUID();
  await sequelize.query(
    `INSERT INTO import_batches (id, file_name, sha256, total_rows, invalid_rows, created_at)
     VALUES ($1, 'synthetic.xlsx', repeat('a', 64), 1, 0, now())`,
    { bind: [batchId] },
  );
  const [sourceColumns] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'source_rows' AND column_name = 'effective_regon'`,
  );
  const hasEffectiveRegon = sourceColumns.length === 1;
  const effectiveRegonColumn = hasEffectiveRegon ? ", effective_regon" : "";
  const effectiveRegonValue = hasEffectiveRegon ? ", '012345678'" : "";
  await sequelize.query(
    `INSERT INTO source_rows (id, batch_id, row_number, company_name, decision_maker_name, nip_raw, address,
       postal_code, city, regon_raw, regon, issues${effectiveRegonColumn})
     VALUES ($1, $2, 18001, 'Synthetic Company', $3, '0000000000', 'Test 1', '00-000', 'Test City',
       '012345678', '012345678', '[]'::jsonb${effectiveRegonValue})`,
    { bind: [sourceRowId, batchId, decisionMakerName] },
  );
  await sequelize.query(
    `INSERT INTO automation_runs (id, batch_id, source_row_id, row_number, tool_id, status, current_step,
       reference_date, error_code, created_at, updated_at)
     VALUES ($1, $2, $3, 18001, 'oc-policy-verification', $4,
       $4, $5, NULL, now(), now())`,
    { bind: [runId, batchId, sourceRowId, status, referenceDate] },
  );
  await sequelize.query(
    `INSERT INTO run_events (id, run_id, status, step, error_code, created_at)
     VALUES ($1, $2, $3, $3, NULL, now())`,
    { bind: [eventId, runId, status] },
  );
  return { batchId, sourceRowId, runId };
}

async function verifyPolicySchema(seeded) {
  await sequelize.query(
    `INSERT INTO run_identities (run_id, source_row_id, regon, company_name, first_name, last_name,
       pesel_ciphertext, pesel_key_version, match_method, adapter_version, created_at)
     VALUES ($1, $2, '012345678', 'Synthetic Company', 'Test', 'Person', 'synthetic-ciphertext',
       1, 'unique_business_identity', 'fixture-v1', now())`,
    { bind: [seeded.runId, seeded.sourceRowId] },
  );
  await sequelize.query(
    `INSERT INTO oc_snapshots (run_id, total_count, captured_at, parser_version)
     VALUES ($1, 158, '2026-09-30T09:00:00Z', 'fixture-v1')`,
    { bind: [seeded.runId] },
  );
  await sequelize.query(
    `INSERT INTO oc_policies (id, run_id, source_ordinal, policy_type_and_number, coverage_from, coverage_to)
     SELECT gen_random_uuid(), $1, ordinal, 'OC TEST-' || ordinal, '2025-01-01', '2027-01-01'
     FROM generate_series(1, 158) AS ordinal`,
    { bind: [seeded.runId] },
  );
  const [rowCounts] = await sequelize.query(
    `SELECT s.total_count, count(p.id)::int AS policy_count
     FROM oc_snapshots s LEFT JOIN oc_policies p ON p.run_id = s.run_id
     WHERE s.run_id = $1 GROUP BY s.total_count`,
    { bind: [seeded.runId] },
  );
  if (rowCounts.length !== 1 || rowCounts[0].total_count !== 158 || rowCounts[0].policy_count !== 158) {
    throw new Error("MIGRATION_SMOKE_POLICY_COUNT_MISMATCH");
  }

  let duplicateRejected = false;
  try {
    await sequelize.query(
      `INSERT INTO oc_policies (id, run_id, source_ordinal, policy_type_and_number, coverage_to)
       VALUES (gen_random_uuid(), $1, 1, 'OC DUPLICATE', '2027-01-01')`,
      { bind: [seeded.runId] },
    );
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23505") throw error;
    duplicateRejected = true;
  }
  if (!duplicateRejected) throw new Error("MIGRATION_SMOKE_DUPLICATE_ACCEPTED");

  const emptySourceId = randomUUID();
  const emptyRunId = randomUUID();
  await sequelize.query(
    `INSERT INTO source_rows (id, batch_id, row_number, company_name, decision_maker_name, nip_raw, address,
       postal_code, city, regon_raw, regon, issues)
     VALUES ($1, $2, 18002, 'Synthetic Empty Company', NULL, '0000000000', 'Test 2', '00-000', 'Test City',
       '012345679', '012345679', '[]'::jsonb)`,
    { bind: [emptySourceId, seeded.batchId] },
  );
  await sequelize.query(
    `INSERT INTO automation_runs (id, batch_id, source_row_id, row_number, tool_id, status, current_step,
       reference_date, error_code, created_at, updated_at)
     VALUES ($1, $2, $3, 18002, 'oc-policy-verification', 'awaiting_portal_adapter',
       'awaiting_portal_adapter', '2026-09-30', NULL, now(), now())`,
    { bind: [emptyRunId, seeded.batchId, emptySourceId] },
  );
  await sequelize.query(
    `INSERT INTO oc_snapshots (run_id, total_count, captured_at, parser_version)
     VALUES ($1, 0, '2026-09-30T09:01:00Z', 'fixture-v1')`,
    { bind: [emptyRunId] },
  );
  const [emptySnapshot] = await sequelize.query(
    `SELECT total_count, (SELECT count(*)::int FROM oc_policies WHERE run_id = $1) AS policy_count
     FROM oc_snapshots WHERE run_id = $1`,
    { bind: [emptyRunId] },
  );
  if (emptySnapshot.length !== 1 || emptySnapshot[0].total_count !== 0 || emptySnapshot[0].policy_count !== 0) {
    throw new Error("MIGRATION_SMOKE_EMPTY_SNAPSHOT_MISMATCH");
  }

  const models = require("../dist/infrastructure/database/db");
  try {
    const [modelIdentity, modelSnapshot, modelPolicyCount] = await Promise.all([
      models.RunIdentity.findByPk(seeded.runId),
      models.OcSnapshot.findByPk(seeded.runId),
      models.OcPolicyRecord.count({ where: { runId: seeded.runId } }),
    ]);
    if (!modelIdentity || modelIdentity.peselCiphertext !== "synthetic-ciphertext"
      || !modelSnapshot || modelSnapshot.totalCount !== 158 || modelPolicyCount !== 158) {
      throw new Error("MIGRATION_SMOKE_MODEL_MAPPING_MISMATCH");
    }
  } finally {
    await models.sequelize.close();
  }
}

async function verifyPeselPersistence(seeded) {
  const { encryptIdentityForPersistence, decryptPesel, peselErrorCodeForLog } = require("../dist/features/results/pesel-crypto");
  const models = require("../dist/infrastructure/database/db");
  const pesel = "90010100016";
  const key = Buffer.alloc(32, 9).toString("base64");
  const environment = {
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": key }), "utf8").toString("base64"),
  };
  const identity = {
    schemaVersion: 1,
    sourceRowId: seeded.sourceRowId,
    regon: "012345678",
    companyName: "Synthetic Company",
    firstName: "Synthetic",
    lastName: "Person",
    pesel,
    matchMethod: "unique_business_identity",
    adapterVersion: "fixture-v1",
  };
  const prepared = encryptIdentityForPersistence(identity, seeded.runId, environment);
  if (Object.hasOwn(prepared, "pesel") || JSON.stringify(prepared).includes(pesel)) {
    throw new Error("PESEL_SMOKE_PLAINTEXT_IN_PERSISTENCE_RECORD");
  }

  let writesAfterInvalidConfiguration = 0;
  const capturedLogTokens = [];
  try {
    const unsafe = encryptIdentityForPersistence(identity, seeded.runId, {});
    await models.RunIdentity.create({ ...unsafe, createdAt: new Date() });
    writesAfterInvalidConfiguration += 1;
  } catch (error) {
    capturedLogTokens.push(peselErrorCodeForLog(error));
  }
  if (writesAfterInvalidConfiguration !== 0 || capturedLogTokens.length !== 1
    || capturedLogTokens[0] !== "PESEL_ENCRYPTION_CONFIG_INVALID"
    || capturedLogTokens.join(" ").includes(pesel)
    || capturedLogTokens.join(" ").includes(key)) {
    throw new Error("PESEL_SMOKE_INVALID_CONFIG_DID_NOT_FAIL_CLOSED");
  }

  try {
    await models.RunIdentity.create({ ...prepared, createdAt: new Date() });
    const [rows] = await sequelize.query(
      "SELECT pesel_ciphertext, pesel_key_version FROM run_identities WHERE run_id = $1",
      { bind: [seeded.runId] },
    );
    if (rows.length !== 1 || rows[0].pesel_ciphertext.includes(pesel)
      || rows[0].pesel_key_version !== 1
      || decryptPesel({ ciphertext: rows[0].pesel_ciphertext, keyVersion: rows[0].pesel_key_version },
        { runId: seeded.runId, sourceRowId: seeded.sourceRowId }, environment) !== pesel) {
      throw new Error("PESEL_SMOKE_DATABASE_CIPHERTEXT_MISMATCH");
    }
    const [events] = await sequelize.query(
      "SELECT metadata::text AS metadata FROM run_events WHERE run_id = $1",
      { bind: [seeded.runId] },
    );
    if (events.some((event) => event.metadata.includes(pesel))) throw new Error("PESEL_SMOKE_PLAINTEXT_IN_EVENT_LOG");
  } finally {
    await models.sequelize.close();
  }
}

async function verifySnapshotPersistence() {
  const { persistOcSnapshot, SnapshotPersistenceError } = require("../dist/features/results/oc-snapshot.repository");
  const models = require("../dist/infrastructure/database/db");
  const key = Buffer.alloc(32, 7).toString("base64");
  const environment = {
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": key }), "utf8").toString("base64"),
  };
  const policy = (ordinal) => ({
    sourceOrdinal: ordinal,
    insuredName: null,
    policyTypeAndNumber: `OC FIXTURE-${ordinal}`,
    contractType: "OC",
    insuredClaimCount: 0,
    vehicleRegistration: `TEST${String(ordinal).padStart(3, "0")}`,
    vehicleGroup: "Test vehicle",
    vehicleMake: "Synthetic",
    vehicleModel: `Model ${ordinal}`,
    insurer: "Synthetic insurer",
    coverageFrom: "2025-01-01",
    coverageTo: "2027-01-01",
  });
  const makeSnapshot = (policies, capturedAt = "2026-09-30T09:00:00.000Z") => ({
    schemaVersion: 1,
    totalCount: policies.length,
    policies,
    capturedAt,
    parserVersion: "fixture-v1",
  });
  const makeIdentity = (sourceRowId) => ({
    schemaVersion: 1,
    sourceRowId,
    regon: "012345678",
    companyName: "Synthetic Company",
    firstName: "Test",
    lastName: "Person",
    pesel: "90010100016",
    matchMethod: "unique_business_identity",
    adapterVersion: "fixture-v1",
  });

  async function counts(runId) {
    const [rows] = await sequelize.query(
      `SELECT (SELECT count(*)::int FROM run_identities WHERE run_id = $1) AS identities,
              (SELECT count(*)::int FROM oc_snapshots WHERE run_id = $1) AS snapshots,
              (SELECT count(*)::int FROM oc_policies WHERE run_id = $1) AS policies`,
      { bind: [runId] },
    );
    return rows[0];
  }

  try {
    const success = await seedLegacyRun("reading_oc");
    const successIdentity = makeIdentity(success.sourceRowId);
    const expectedPolicies = [policy(1), policy(2), policy(3)];
    await persistOcSnapshot(success.runId, successIdentity, makeSnapshot(expectedPolicies), { environment });
    await persistOcSnapshot(success.runId, successIdentity, makeSnapshot(expectedPolicies, "2026-09-30T09:05:00.000Z"), { environment });
    const successfulCounts = await counts(success.runId);
    if (successfulCounts.identities !== 1 || successfulCounts.snapshots !== 1 || successfulCounts.policies !== 3) {
      throw new Error("SNAPSHOT_SMOKE_IDEMPOTENCY_COUNT_MISMATCH");
    }
    const [header] = await sequelize.query("SELECT total_count, captured_at, parser_version FROM oc_snapshots WHERE run_id = $1", { bind: [success.runId] });
    if (header.length !== 1 || header[0].total_count !== 3 || header[0].parser_version !== "fixture-v1"
      || new Date(header[0].captured_at).toISOString() !== "2026-09-30T09:00:00.000Z") {
      throw new Error("SNAPSHOT_SMOKE_HEADER_MISMATCH");
    }

    const changed = expectedPolicies.map((value) => ({ ...value }));
    changed[1].vehicleModel = "Changed on retry";
    let conflictCode = null;
    try {
      await persistOcSnapshot(success.runId, successIdentity, makeSnapshot(changed), { environment });
    } catch (error) {
      conflictCode = error instanceof SnapshotPersistenceError ? error.code : null;
    }
    if (conflictCode !== "SNAPSHOT_CONFLICT") throw new Error("SNAPSHOT_SMOKE_CHANGED_ROW_NOT_REJECTED");
    if (JSON.stringify(await counts(success.runId)) !== JSON.stringify(successfulCounts)) {
      throw new Error("SNAPSHOT_SMOKE_CONFLICT_MUTATED_STORED_DATA");
    }

    const empty = await seedLegacyRun("reading_oc");
    await persistOcSnapshot(empty.runId, makeIdentity(empty.sourceRowId), makeSnapshot([]), { environment });
    const emptyCounts = await counts(empty.runId);
    const [emptyHeader] = await sequelize.query("SELECT total_count FROM oc_snapshots WHERE run_id = $1", { bind: [empty.runId] });
    if (emptyCounts.identities !== 1 || emptyCounts.snapshots !== 1 || emptyCounts.policies !== 0
      || emptyHeader.length !== 1 || emptyHeader[0].total_count !== 0) {
      throw new Error("SNAPSHOT_SMOKE_ZERO_COUNT_MISMATCH");
    }

    const interrupted = await seedLegacyRun("reading_oc");
    let failureCode = null;
    try {
      const manyPolicies = Array.from({ length: 60 }, (_, index) => policy(index + 1));
      await persistOcSnapshot(interrupted.runId, makeIdentity(interrupted.sourceRowId), makeSnapshot(manyPolicies), {
        environment,
        afterPolicyChunk: (insertedCount) => {
          if (insertedCount === 50) throw new Error("SYNTHETIC_MID_TRANSACTION_FAILURE");
        },
      });
    } catch (error) {
      failureCode = error instanceof SnapshotPersistenceError ? error.code : null;
    }
    const rolledBackCounts = await counts(interrupted.runId);
    if (failureCode !== "SNAPSHOT_WRITE_FAILED"
      || rolledBackCounts.identities !== 0 || rolledBackCounts.snapshots !== 0 || rolledBackCounts.policies !== 0) {
      throw new Error("SNAPSHOT_SMOKE_TRANSACTION_DID_NOT_ROLL_BACK");
    }
    console.log("SNAPSHOT_SMOKE_PASS idempotent=true changedRow=conflict zeroCount=stored midTransaction=rolled_back");
  } finally {
    await models.sequelize.close();
  }
}

async function verifyRunEvaluation() {
  const { persistOcSnapshot } = require("../dist/features/results/oc-snapshot.repository");
  const { evaluateStoredSnapshot, RunEvaluationError } = require("../dist/features/results/run-evaluation.repository");
  const { exportRunWorkbook } = require("../dist/features/results/run-export");
  const { exportOcWorkbook } = require("../dist/features/results/export");
  const ExcelJS = require("exceljs");
  const models = require("../dist/infrastructure/database/db");
  const key = Buffer.alloc(32, 6).toString("base64");
  const environment = {
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": key }), "utf8").toString("base64"),
  };
  process.env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = environment.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION;
  process.env.PESEL_ENCRYPTION_KEYS_BASE64 = environment.PESEL_ENCRYPTION_KEYS_BASE64;
  const policy = (ordinal, coverageTo) => ({
    sourceOrdinal: ordinal,
    insuredName: null,
    policyTypeAndNumber: `OC EVAL-${ordinal}`,
    contractType: "OC",
    insuredClaimCount: 0,
    vehicleRegistration: `TEST${ordinal}`,
    vehicleGroup: "Test vehicle",
    vehicleMake: "Synthetic",
    vehicleModel: `Model ${ordinal}`,
    insurer: "Synthetic insurer",
    coverageFrom: "2025-01-01",
    coverageTo,
  });
  const identity = (sourceRowId) => ({
    schemaVersion: 1,
    sourceRowId,
    regon: "012345678",
    companyName: "Synthetic Company",
    firstName: "Test",
    lastName: "Person",
    pesel: "90010100016",
    matchMethod: "unique_business_identity",
    adapterVersion: "fixture-v1",
  });
  const snapshot = (policies, capturedAt = "2026-09-30T10:00:00.000Z") => ({
    schemaVersion: 1,
    totalCount: policies.length,
    policies,
    capturedAt,
    parserVersion: "fixture-v1",
  });
  try {
    const dated = await seedLegacyRun("reading_oc", "2026-09-29");
    const beforeWarsawMidnight = new Date("2026-09-29T21:59:00.000Z");
    const afterWarsawMidnight = "2026-09-29T22:01:00.000Z";
    await models.AutomationRun.update(
      { createdAt: beforeWarsawMidnight, updatedAt: beforeWarsawMidnight },
      { where: { id: dated.runId }, silent: true },
    );
    const datedPolicies = [policy(1, "2026-09-28"), policy(2, "2026-09-29"), policy(3, "2026-09-30")];
    await persistOcSnapshot(dated.runId, identity(dated.sourceRowId), snapshot(datedPolicies, afterWarsawMidnight), { environment });
    const result = await evaluateStoredSnapshot(dated.runId);
    const eventCountAfterFirst = await models.RunEvent.count({ where: { runId: dated.runId } });
    const retryResult = await evaluateStoredSnapshot(dated.runId);
    const eventCountAfterRetry = await models.RunEvent.count({ where: { runId: dated.runId } });
    const storedRun = await models.AutomationRun.findByPk(dated.runId);
    const storedSnapshot = await models.OcSnapshot.findByPk(dated.runId);
    const crossingExport = await exportRunWorkbook(dated.runId);
    const crossingWorkbook = new ExcelJS.Workbook();
    if (crossingExport) await crossingWorkbook.xlsx.load(crossingExport.bytes);
    const crossingSheet = crossingWorkbook.getWorksheet("Polisy OC");
    const crossingEndDates = crossingSheet ? [crossingSheet.getRow(2).getCell(15).value, crossingSheet.getRow(3).getCell(15).value] : [];
    if (result.outcome !== "export_ready" || result.totalOcCount !== 3 || result.currentOcCount !== 2
      || retryResult.currentOcCount !== 2 || eventCountAfterFirst !== eventCountAfterRetry
      || storedRun.status !== "export_ready" || storedRun.referenceDate !== "2026-09-29"
      || storedRun.createdAt.toISOString() !== beforeWarsawMidnight.toISOString()
      || !storedSnapshot || storedSnapshot.capturedAt.toISOString() !== afterWarsawMidnight
      || crossingExport?.policyCount !== 2 || crossingSheet?.rowCount !== 3
      || crossingEndDates.join(",") !== "2026-09-29,2026-09-30") {
      throw new Error("RUN_EVALUATION_BOUNDARY_OR_RETRY_MISMATCH");
    }

    const empty = await seedLegacyRun("reading_oc", "2026-09-30");
    await persistOcSnapshot(empty.runId, identity(empty.sourceRowId), snapshot([]), { environment });
    const noMatch = await evaluateStoredSnapshot(empty.runId);
    const emptyWorkbook = await exportOcWorkbook({
      regon: "012345678", companyName: "Synthetic Company", pesel: "90010100016",
      referenceDate: "2026-09-30", policies: [],
    });
    const emptyRun = await models.AutomationRun.findByPk(empty.runId);
    if (noMatch.outcome !== "no_matching_policies" || noMatch.currentOcCount !== 0
      || emptyRun.status !== "no_matching_policies" || emptyWorkbook !== null) {
      throw new Error("RUN_EVALUATION_EMPTY_RESULT_MISMATCH");
    }

    const incomplete = await seedLegacyRun("reading_oc", "2026-09-30");
    await persistOcSnapshot(incomplete.runId, identity(incomplete.sourceRowId), snapshot([policy(1, "2026-10-01")]), { environment });
    await models.OcPolicyRecord.destroy({ where: { runId: incomplete.runId, sourceOrdinal: 1 } });
    let incompleteCode = null;
    try {
      await evaluateStoredSnapshot(incomplete.runId);
    } catch (error) {
      incompleteCode = error instanceof RunEvaluationError ? error.code : null;
    }
    const incompleteRun = await models.AutomationRun.findByPk(incomplete.runId);
    if (incompleteCode !== "SNAPSHOT_INCOMPLETE" || incompleteRun.status !== "reading_oc") {
      throw new Error("RUN_EVALUATION_PARTIAL_SNAPSHOT_WAS_ACCEPTED");
    }
    console.log("RUN_EVALUATION_SMOKE_PASS boundary=previous-day-excluded_reference-day-and-after-included crossing=Warsaw-midnight-filters-and-xlsx-use-stored-date empty=no-matching no-file=true partial=blocked");
  } finally {
    await models.sequelize.close();
  }
}

async function verifyArtifactSchema() {
  const models = require("../dist/infrastructure/database/db");
  const runA = await seedLegacyRun("export_ready");
  const runB = await seedLegacyRun("export_ready");
  const sameBusinessFileName = "012345678_Synthetic Company_Test Person.xlsx";
  const artifactA = {
    artifactId: randomUUID(), runId: runA.runId, fileName: sameBusinessFileName,
    storageKey: `artifacts/${randomUUID()}.xlsx`, sha256: "a".repeat(64), policyCount: 2,
    state: "ready", createdAt: new Date(), readyAt: new Date(),
  };
  const artifactB = {
    artifactId: randomUUID(), runId: runB.runId, fileName: sameBusinessFileName,
    storageKey: `artifacts/${randomUUID()}.xlsx`, sha256: "b".repeat(64), policyCount: 3,
    state: "ready", createdAt: new Date(), readyAt: new Date(),
  };
  try {
    await models.ExportArtifact.create(artifactA);
    await models.ExportArtifact.create(artifactB);
    const [rows] = await sequelize.query(
      "SELECT artifact_id, run_id, file_name, storage_key, sha256, policy_count, state FROM export_artifacts WHERE file_name = $1 ORDER BY run_id",
      { bind: [sameBusinessFileName] },
    );
    if (rows.length !== 2 || rows[0].artifact_id === rows[1].artifact_id
      || rows[0].run_id === rows[1].run_id || rows[0].file_name !== rows[1].file_name
      || new Set(rows.map((row) => row.storage_key)).size !== 2) {
      throw new Error("ARTIFACT_SMOKE_SAME_FILENAME_COLLISION");
    }

    let foreignKeyRejected = false;
    try {
      await models.ExportArtifact.create({ ...artifactA, artifactId: randomUUID(), runId: randomUUID(), storageKey: `artifacts/${randomUUID()}.xlsx` });
    } catch (error) {
      const code = error?.parent?.code ?? error?.original?.code;
      if (code !== "23503") throw error;
      foreignKeyRejected = true;
    }
    if (!foreignKeyRejected) throw new Error("ARTIFACT_SMOKE_INVALID_RUN_ACCEPTED");

    let storageKeyRejected = false;
    try {
      await models.ExportArtifact.create({ ...artifactA, artifactId: randomUUID(), storageKey: artifactA.storageKey });
    } catch (error) {
      const code = error?.parent?.code ?? error?.original?.code;
      if (code !== "23505") throw error;
      storageKeyRejected = true;
    }
    if (!storageKeyRejected) throw new Error("ARTIFACT_SMOKE_DUPLICATE_KEY_ACCEPTED");
    console.log("ARTIFACT_SMOKE_PASS runForeignKey=true duplicateBusinessName=true uniqueStorageKey=true");
  } finally {
    await models.sequelize.close();
  }
}

async function verifyAuthChallengeSchema(seededRun) {
  smokeStage = "mfa_schema";
  const models = require("../dist/infrastructure/database/db");
  const { Pool } = require("pg");
  const {
    AuthChallengeError,
    createAuthChallenge,
    invalidateStaleAuthChallenges,
    recordAuthChallengeOutcome,
  } = require("../../worker/dist/features/authentication/auth-challenges");
  const expectedColumns = {
    auth_challenges: [
      "challenge_id", "run_id", "portal", "account_key", "browser_session_id", "return_step", "status",
      "attempt_count", "attempt_limit", "expires_at", "claimed_at", "consumed_at", "created_at", "updated_at",
    ],
    manual_interventions: [
      "intervention_id", "run_id", "challenge_id", "portal", "kind", "status", "reason_code",
      "created_at", "resolved_at", "resolved_by",
    ],
  };
  const [columns] = await sequelize.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('auth_challenges', 'manual_interventions')
     ORDER BY table_name, ordinal_position`,
  );
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = columns.filter((column) => column.table_name === table).map((column) => column.column_name);
    if (actual.length !== expected.length || expected.some((column) => !actual.includes(column))) {
      throw new Error(`AUTH_CHALLENGE_SCHEMA_COLUMNS_MISMATCH_${table}`);
    }
  }
  const forbiddenColumn = columns.some(({ column_name }) => /^(sms|otp|one_time|verification|auth)_?(code|secret|token)$/i.test(column_name));
  if (forbiddenColumn || Object.hasOwn(models.AuthChallenge.getAttributes(), "smsCode")
    || Object.hasOwn(models.AuthChallenge.getAttributes(), "otpCode")) {
    throw new Error("AUTH_CHALLENGE_SCHEMA_MUST_NOT_STORE_CODE");
  }
  const [indexes] = await sequelize.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename IN ('auth_challenges', 'manual_interventions')`,
  );
  if (!indexes.some(({ indexname }) => indexname === "auth_challenges_one_active_per_account_portal")
    || !indexes.some(({ indexname }) => indexname === "manual_interventions_one_open_per_run")) {
    throw new Error("AUTH_CHALLENGE_ACTIVE_UNIQUENESS_MISSING");
  }

  const challengePool = new Pool({ connectionString: databaseUrl, max: 1 });
  const syntheticArtifactDirectory = await mkdtemp(path.join(os.tmpdir(), "goldis-w3-sms-artifact-scan-"));
  const capturedLogs = [];
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  let persistenceScanPassed = false;
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...parts) => capturedLogs.push(parts.map((part) => String(part)).join(" "));
  }
  try {
    smokeStage = "mfa_restart_reconcile";
    const now = new Date("2026-09-30T10:00:00.000Z");
    const challengeInput = {
      runId: seededRun.runId, portal: "pzu", accountKey: "b".repeat(64),
      browserSessionId: "55555555-5555-4555-8555-555555555555", returnStep: "pzu_login",
      now, expiresAt: new Date("2026-09-30T10:05:00.000Z"),
    };
    const created = await createAuthChallenge(challengePool, challengeInput);
    const retried = await createAuthChallenge(challengePool, challengeInput);
    const competingRun = await seedLegacyRun("pzu_login");
    let conflictCode = null;
    try {
      await createAuthChallenge(challengePool, {
        ...challengeInput,
        runId: competingRun.runId,
        browserSessionId: "66666666-6666-4666-8666-666666666666",
      });
    } catch (error) {
      conflictCode = error instanceof AuthChallengeError ? error.code : null;
    }
    const resumed = await invalidateStaleAuthChallenges(
      challengePool,
      "77777777-7777-4777-8777-777777777777",
      now,
    );
    const challengeCount = await models.AuthChallenge.count({ where: { accountKey: challengeInput.accountKey, portal: "pzu" } });
    const interventionCount = await models.ManualIntervention.count({ where: { runId: seededRun.runId, status: "expired" } });
    const waitingRun = await models.AutomationRun.findByPk(seededRun.runId);
    const challengeAfterRestart = await models.AuthChallenge.findByPk(created.challengeId);
    const preservedCompetingRun = await models.AutomationRun.findByPk(competingRun.runId);
    if (created.challengeId !== retried.challengeId || created.attemptCount !== 0 || created.attemptLimit !== 5
      || "browserSessionId" in created || "accountKey" in created
      || conflictCode !== "AUTH_CHALLENGE_ALREADY_ACTIVE" || challengeCount !== 1 || interventionCount !== 1
      || resumed.length !== 1 || resumed[0].runId !== seededRun.runId || resumed[0].returnStep !== "pzu_login"
      || resumed[0].reason !== "worker_restarted" || challengeAfterRestart?.status !== "invalidated"
      || waitingRun?.status !== "pzu_login" || preservedCompetingRun?.status !== "pzu_login") {
      throw new Error("AUTH_CHALLENGE_WORKER_CREATE_OR_IDEMPOTENCY_MISMATCH");
    }

    const { AuthChallengeService } = require("../dist/features/interventions/auth-challenge.service");
    smokeStage = "mfa_initial_delivery";
    const deliveryRun = await seedLegacyRun("pzu_login");
    const deliveryInput = {
      runId: deliveryRun.runId, portal: "pzu", accountKey: "c".repeat(64),
      browserSessionId: "88888888-8888-4888-8888-888888888888", returnStep: "pzu_login",
      now: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000),
    };
    const deliveryChallenge = await createAuthChallenge(challengePool, deliveryInput);
    const syntheticCode = "684203";
    const deliveredCodes = [];
    const forwarder = {
      async deliver(challengeId, code) { deliveredCodes.push({ challengeId, code }); },
      async invalidate() {},
    };
    const apiService = new AuthChallengeService(forwarder);
    const accepted = await apiService.submitCode(deliveryChallenge.challengeId, deliveryRun.runId, syntheticCode);
    const claimedChallenge = await models.AuthChallenge.findByPk(deliveryChallenge.challengeId);
    const deliveryRunAfter = await models.AutomationRun.findByPk(deliveryRun.runId);
    const deliveryEvents = await models.RunEvent.findAll({ where: { runId: deliveryRun.runId }, order: [["createdAt", "ASC"]] });
    let duplicateStatus = null;
    try {
      await apiService.submitCode(deliveryChallenge.challengeId, deliveryRun.runId, syntheticCode);
    } catch (error) {
      duplicateStatus = error?.getStatus?.() ?? null;
    }
    if (!accepted.accepted || accepted.attemptCount !== 1 || claimedChallenge?.status !== "submitted"
      || claimedChallenge.attemptCount !== 1 || deliveryRunAfter?.status !== "waiting_for_sms"
      || deliveredCodes.length !== 1 || deliveredCodes[0].code !== syntheticCode
      || duplicateStatus !== 409 || JSON.stringify(deliveryEvents).includes(syntheticCode)) {
      throw new Error("AUTH_CHALLENGE_API_DELIVERY_OR_SINGLE_USE_MISMATCH");
    }

    smokeStage = "mfa_first_rejection";
    const firstOutcomePreflight = await challengePool.query(
      `SELECT c.status AS challenge_status, c.return_step, c.portal, c.attempt_count, c.attempt_limit,
              r.status AS run_status
       FROM auth_challenges c JOIN automation_runs r ON r.id = c.run_id WHERE c.challenge_id = $1`,
      [deliveryChallenge.challengeId],
    );
    const firstOutcomeState = firstOutcomePreflight.rows[0];
    if (firstOutcomeState?.challenge_status !== "submitted" || firstOutcomeState.return_step !== "pzu_login"
      || firstOutcomeState.portal !== "pzu" || firstOutcomeState.attempt_count !== 1
      || firstOutcomeState.attempt_limit !== 5 || firstOutcomeState.run_status !== "waiting_for_sms") {
      throw new Error("AUTH_CHALLENGE_FIRST_OUTCOME_PREFLIGHT_MISMATCH");
    }
    const firstRejected = await recordAuthChallengeOutcome(challengePool, deliveryChallenge.challengeId, "rejected");
    const rejectedChallenge = await models.AuthChallenge.findByPk(deliveryChallenge.challengeId);
    const rejectedIntervention = await models.ManualIntervention.findOne({ where: { challengeId: deliveryChallenge.challengeId } });
    const rejectedRun = await models.AutomationRun.findByPk(deliveryRun.runId);
    if (firstRejected.outcome !== "rejected" || rejectedChallenge?.status !== "consumed"
      || rejectedIntervention?.status !== "resolved" || rejectedIntervention?.reasonCode !== "SMS_CODE_REJECTED"
      || rejectedRun?.status !== "pzu_login") {
      throw new Error("AUTH_CHALLENGE_REJECTED_CODE_STATE_MISMATCH");
    }

    smokeStage = "mfa_second_challenge";
    const secondChallenge = await createAuthChallenge(challengePool, {
      ...deliveryInput,
      now: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    if (secondChallenge.attemptCount !== 1) throw new Error("AUTH_CHALLENGE_CUMULATIVE_ATTEMPT_COUNT_MISMATCH");

    let releaseDelivery;
    let deliveryStarted;
    const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
    const deliveryEntered = new Promise((resolve) => { deliveryStarted = resolve; });
    const concurrentCodes = [];
    const concurrentService = new AuthChallengeService({
      async deliver(challengeId, code) {
        concurrentCodes.push({ challengeId, code });
        deliveryStarted();
        await deliveryGate;
      },
      async invalidate() {},
    });
    smokeStage = "mfa_two_tab_claim";
    const firstTabSubmission = concurrentService.submitCode(secondChallenge.challengeId, deliveryRun.runId, syntheticCode);
    await deliveryEntered;
    let secondTabStatus = null;
    try {
      await concurrentService.submitCode(secondChallenge.challengeId, deliveryRun.runId, syntheticCode);
    } catch (error) {
      secondTabStatus = error?.getStatus?.() ?? null;
    } finally {
      releaseDelivery();
    }
    const secondTabAccepted = await firstTabSubmission;
    const concurrentChallenge = await models.AuthChallenge.findByPk(secondChallenge.challengeId);
    if (!secondTabAccepted.accepted || secondTabAccepted.attemptCount !== 2 || secondTabStatus !== 409
      || concurrentCodes.length !== 1 || concurrentChallenge?.status !== "submitted"
      || concurrentChallenge.attemptCount !== 2) {
      throw new Error("AUTH_CHALLENGE_TWO_TAB_SINGLE_CLAIM_MISMATCH");
    }
    smokeStage = "mfa_second_rejection";
    const secondRejected = await recordAuthChallengeOutcome(challengePool, secondChallenge.challengeId, "rejected");
    if (secondRejected.outcome !== "rejected") throw new Error("AUTH_CHALLENGE_SECOND_REJECTION_MISMATCH");

    for (const expectedAttempt of [3, 4, 5]) {
      smokeStage = `mfa_retry_${expectedAttempt}`;
      const retryChallenge = await createAuthChallenge(challengePool, {
        ...deliveryInput,
        now: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
      if (retryChallenge.attemptCount !== expectedAttempt - 1) {
        throw new Error("AUTH_CHALLENGE_RETRY_ATTEMPT_COUNT_MISMATCH");
      }
      const retryService = new AuthChallengeService({ async deliver() {}, async invalidate() {} });
      const retryAccepted = await retryService.submitCode(retryChallenge.challengeId, deliveryRun.runId, syntheticCode);
      if (!retryAccepted.accepted || retryAccepted.attemptCount !== expectedAttempt) {
        throw new Error("AUTH_CHALLENGE_RETRY_SUBMISSION_MISMATCH");
      }
      const retryOutcome = await recordAuthChallengeOutcome(challengePool, retryChallenge.challengeId, "rejected");
      const retryRun = await models.AutomationRun.findByPk(deliveryRun.runId);
      if (expectedAttempt < 5 && (retryOutcome.outcome !== "rejected" || retryRun?.status !== "pzu_login")) {
        throw new Error("AUTH_CHALLENGE_RETRY_DID_NOT_RESUME_LOGIN");
      }
      if (expectedAttempt === 5 && (retryOutcome.outcome !== "attempt_limit_reached"
        || retryRun?.status !== "failed" || retryRun?.errorCode !== "SMS_ATTEMPT_LIMIT")) {
        throw new Error("AUTH_CHALLENGE_ATTEMPT_LIMIT_NOT_ENFORCED");
      }
    }
    smokeStage = "mfa_attempt_limit";
    let exhaustedChallengeCode = null;
    try {
      await createAuthChallenge(challengePool, {
        ...deliveryInput,
        now: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
    } catch (error) {
      exhaustedChallengeCode = error instanceof AuthChallengeError ? error.code : null;
    }
    if (exhaustedChallengeCode !== "AUTH_CHALLENGE_ATTEMPT_LIMIT") {
      throw new Error("AUTH_CHALLENGE_EXHAUSTED_RETRY_WAS_CREATED");
    }

    smokeStage = "mfa_cancel";
    const cancellationRun = await seedLegacyRun("pzu_login");
    const cancellationChallenge = await createAuthChallenge(challengePool, {
      ...deliveryInput,
      runId: cancellationRun.runId,
      accountKey: "e".repeat(64),
      browserSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      now: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    const { RunService } = require("../dist/features/runs/runs.service");
    let cancellationInvalidations = 0;
    const cancellationService = Object.create(RunService.prototype);
    cancellationService.codeForwarder = {
      async invalidate(challengeId) {
        if (challengeId === cancellationChallenge.challengeId) cancellationInvalidations += 1;
      },
    };
    const cancelled = await cancellationService.cancel(cancellationRun.runId);
    const cancelledRun = await models.AutomationRun.findByPk(cancellationRun.runId);
    const cancelledChallenge = await models.AuthChallenge.findByPk(cancellationChallenge.challengeId);
    const cancelledIntervention = await models.ManualIntervention.findOne({ where: { challengeId: cancellationChallenge.challengeId } });
    if (cancelled.status !== "cancelled" || cancelledRun?.status !== "cancelled"
      || cancelledChallenge?.status !== "invalidated" || cancelledIntervention?.status !== "cancelled"
      || cancelledIntervention?.reasonCode !== "RUN_CANCELLED" || cancellationInvalidations !== 1) {
      throw new Error("AUTH_CHALLENGE_CANCEL_DURING_MFA_MISMATCH");
    }

    smokeStage = "mfa_uncertain_delivery";
    const uncertainRun = await seedLegacyRun("pzu_login");
    const uncertainChallenge = await createAuthChallenge(challengePool, {
      ...deliveryInput,
      runId: uncertainRun.runId,
      accountKey: "d".repeat(64),
      browserSessionId: "99999999-9999-4999-8999-999999999999",
      now: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    let invalidationCalls = 0;
    const failingService = new AuthChallengeService({
      async deliver() { throw new Error("synthetic transport failure"); },
      async invalidate() { invalidationCalls += 1; },
    });
    let uncertainStatus = null;
    try {
      await failingService.submitCode(uncertainChallenge.challengeId, uncertainRun.runId, syntheticCode);
    } catch (error) {
      uncertainStatus = error?.getStatus?.() ?? null;
    }
    const uncertainChallengeAfter = await models.AuthChallenge.findByPk(uncertainChallenge.challengeId);
    const uncertainIntervention = await models.ManualIntervention.findOne({ where: { challengeId: uncertainChallenge.challengeId } });
    const uncertainRunAfter = await models.AutomationRun.findByPk(uncertainRun.runId);
    if (uncertainStatus !== 503 || uncertainChallengeAfter?.status !== "invalidated"
      || uncertainIntervention?.status !== "cancelled" || uncertainIntervention?.reasonCode !== "SMS_DELIVERY_UNCERTAIN"
      || uncertainRunAfter?.status !== "failed" || uncertainRunAfter?.errorCode !== "SMS_DELIVERY_UNCERTAIN"
      || invalidationCalls !== 1) {
      throw new Error("AUTH_CHALLENGE_UNCERTAIN_DELIVERY_NOT_FAILED_CLOSED");
    }
    smokeStage = "mfa_persistence_scan";
    const persistedRows = await challengePool.query(
      `SELECT to_jsonb(challenge)::text AS record FROM auth_challenges challenge
       UNION ALL SELECT to_jsonb(intervention)::text FROM manual_interventions intervention
       UNION ALL SELECT to_jsonb(event)::text FROM run_events event`,
    );
    if (persistedRows.rows.some(({ record }) => record.includes(syntheticCode))
      || capturedLogs.some((line) => line.includes(syntheticCode))) {
      throw new Error("AUTH_CHALLENGE_CODE_FOUND_IN_PERSISTENT_DATA_OR_LOGS");
    }
    const artifactFiles = await readdir(syntheticArtifactDirectory, { recursive: true, withFileTypes: true });
    for (const entry of artifactFiles) {
      if (!entry.isFile()) continue;
      const contents = await readFile(path.join(entry.parentPath ?? syntheticArtifactDirectory, entry.name));
      if (contents.includes(Buffer.from(syntheticCode))) throw new Error("AUTH_CHALLENGE_CODE_FOUND_IN_ARTIFACT");
    }
    persistenceScanPassed = true;
  } finally {
    for (const [method, original] of Object.entries(originalConsole)) console[method] = original;
    await challengePool.end();
    await rm(syntheticArtifactDirectory, { recursive: true, force: true });
    if (persistenceScanPassed) {
      console.log("AUTH_CHALLENGE_SCHEMA_SMOKE_PASS migration=010 challengeMetadata=true interventionMetadata=true smsValueColumns=0 oneActivePerAccountPortal=true workerCreate=true restartInvalidated=true apiClaimForwardSingleUse=true duplicate409=true rejectedCodeResume=true cumulativeAttemptLimit=true twoTabSingleClaim=true cancelDuringMfa=true uncertainDeliveryFailedClosed=true databaseScan=true redisScan=separateTest logsScan=true artifactScan=true codeAbsentFromEvents=true");
    }
  }
}

async function verifyRegistrySchema(seeded) {
  const { deriveEffectiveRegon } = require("@goldis/core");
  const models = require("../dist/infrastructure/database/db");
  const expectedColumns = {
    regon_corrections: [
      "correction_id", "source_row_id", "author_ref", "reason", "previous_regon", "proposed_regon",
      "status", "reviewer_ref", "reviewed_at", "review_reason", "created_at",
    ],
    registry_lookup_cache: [
      "lookup_id", "nip_normalized", "data_version", "status", "result_count", "response_fingerprint",
      "attempt_count", "error_code", "checked_at", "expires_at", "created_at", "updated_at",
    ],
    canonical_entities: ["canonical_entity_id", "tenant_id", "nip_normalized", "regon", "business_name", "created_at", "updated_at"],
    source_entity_links: ["source_row_id", "tenant_id", "canonical_entity_id", "match_method", "linked_at"],
  };
  const [columns] = await sequelize.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    { bind: [Object.keys(expectedColumns)] },
  );
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = columns.filter((column) => column.table_name === table).map((column) => column.column_name);
    if (actual.length !== expected.length || expected.some((column) => !actual.includes(column))) {
      throw new Error(`REGISTRY_SCHEMA_COLUMNS_MISMATCH_${table}`);
    }
  }
  const [sourceColumns] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
     AND table_name = 'source_rows' AND column_name IN ('regon_raw', 'regon', 'effective_regon')`,
  );
  if (!["regon_raw", "regon", "effective_regon"].every((column) => sourceColumns.some((item) => item.column_name === column))) {
    throw new Error("REGISTRY_EFFECTIVE_REGON_COLUMN_MISSING");
  }
  const source = await models.SourceRow.findByPk(seeded.sourceRowId);
  if (!source || source.regonRaw !== "012345678" || source.regon !== "012345678" || source.effectiveRegon !== source.regon) {
    throw new Error("REGISTRY_EFFECTIVE_REGON_BACKFILL_MISMATCH");
  }
  const [indexes] = await sequelize.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
    { bind: [Object.keys(expectedColumns).concat("source_rows")] },
  );
  const expectedIndexes = [
    "source_rows_batch_effective_regon_idx", "regon_corrections_source_created_idx",
    "regon_corrections_one_pending_per_source_row", "registry_lookup_nip_version_unique",
    "registry_lookup_status_expiry_idx", "canonical_entities_tenant_nip_unique",
    "canonical_entities_tenant_regon_unique", "source_entity_links_entity_idx",
    "source_entity_links_tenant_entity_idx",
  ];
  if (expectedIndexes.some((name) => !indexes.some((index) => index.indexname === name))) {
    throw new Error("REGISTRY_SCHEMA_INDEX_MISSING");
  }

  const now = new Date();
  const correction = await models.RegonCorrection.create({
    correctionId: randomUUID(), sourceRowId: seeded.sourceRowId, authorRef: "synthetic-operator",
    reason: "Synthetic correction fixture", previousRegon: source.effectiveRegon,
    proposedRegon: "987654321", status: "pending", reviewerRef: null, reviewedAt: null,
    reviewReason: null, createdAt: now,
  });
  if (correction.status !== "pending") throw new Error("REGISTRY_CORRECTION_MODEL_MISMATCH");

  let pendingCorrectionRejected = false;
  try {
    await models.RegonCorrection.create({
      correctionId: randomUUID(), sourceRowId: seeded.sourceRowId, authorRef: "synthetic-operator",
      reason: "Second pending fixture", previousRegon: source.effectiveRegon,
      proposedRegon: "123456789", status: "pending", reviewerRef: null, reviewedAt: null,
      reviewReason: null, createdAt: new Date(),
    });
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23505") throw error;
    pendingCorrectionRejected = true;
  }
  if (!pendingCorrectionRejected) throw new Error("REGISTRY_DUPLICATE_PENDING_CORRECTION_ACCEPTED");

  const corrected = deriveEffectiveRegon({
    regonRaw: source.regonRaw,
    importedRegon: source.regon,
    approvedCorrection: correction.proposedRegon,
  });
  correction.status = "approved";
  correction.reviewerRef = "synthetic-reviewer";
  correction.reviewedAt = now;
  await correction.save();
  source.effectiveRegon = corrected.effectiveRegon;
  await source.save();
  await source.reload();
  if (source.regonRaw !== "012345678" || source.regon !== "012345678"
    || source.effectiveRegon !== correction.proposedRegon || corrected.regonRaw !== source.regonRaw) {
    throw new Error("REGISTRY_APPROVED_CORRECTION_MUTATED_SOURCE_REGON");
  }

  const dataVersion = "a".repeat(64);
  const cacheEntry = await models.RegistryLookupCache.create({
    lookupId: randomUUID(), nipNormalized: "0123456789", dataVersion, status: "matched",
    resultCount: 1, responseFingerprint: "b".repeat(64), attemptCount: 1, errorCode: null,
    checkedAt: now, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now,
  });
  if (cacheEntry.nipNormalized !== "0123456789") throw new Error("REGISTRY_CACHE_MODEL_DROPPED_LEADING_ZERO");
  let duplicateLookupRejected = false;
  try {
    await models.RegistryLookupCache.create({
      lookupId: randomUUID(), nipNormalized: "0123456789", dataVersion, status: "matched",
      resultCount: 1, responseFingerprint: "b".repeat(64), attemptCount: 1, errorCode: null,
      checkedAt: new Date(), expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23505") throw error;
    duplicateLookupRejected = true;
  }
  if (!duplicateLookupRejected) throw new Error("REGISTRY_DUPLICATE_NIP_VERSION_LOOKUP_ACCEPTED");

  const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
  const entity = await models.CanonicalEntity.create({
    canonicalEntityId: randomUUID(), tenantId: tenant.tenantId, nipNormalized: "0123456789", regon: "012345678",
    businessName: "Synthetic Company", createdAt: now, updatedAt: now,
  });
  const link = await models.SourceEntityLink.create({
    sourceRowId: seeded.sourceRowId, tenantId: tenant.tenantId, canonicalEntityId: entity.canonicalEntityId,
    matchMethod: "registry_verified", linkedAt: now,
  });
  if (link.canonicalEntityId !== entity.canonicalEntityId || link.sourceRowId !== seeded.sourceRowId) {
    throw new Error("REGISTRY_SOURCE_ENTITY_LINK_MODEL_MISMATCH");
  }

  let nipConflictRejected = false;
  try {
    await models.CanonicalEntity.create({
      canonicalEntityId: randomUUID(), tenantId: tenant.tenantId, nipNormalized: "0123456789", regon: "987654321",
      businessName: "Synthetic Conflict", createdAt: new Date(), updatedAt: new Date(),
    });
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23505") throw error;
    nipConflictRejected = true;
  }
  if (!nipConflictRejected) throw new Error("REGISTRY_SAME_NIP_DIFFERENT_REGON_ACCEPTED");

  let regonConflictRejected = false;
  try {
    await models.CanonicalEntity.create({
      canonicalEntityId: randomUUID(), tenantId: tenant.tenantId, nipNormalized: "9876543210", regon: "012345678",
      businessName: "Synthetic Conflict", createdAt: new Date(), updatedAt: new Date(),
    });
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23505") throw error;
    regonConflictRejected = true;
  }
  if (!regonConflictRejected) throw new Error("REGISTRY_SAME_REGON_DIFFERENT_NIP_ACCEPTED");
  let orphanLinkRejected = false;
  try {
    await models.SourceEntityLink.create({
      sourceRowId: randomUUID(), tenantId: tenant.tenantId, canonicalEntityId: entity.canonicalEntityId,
      matchMethod: "manual", linkedAt: new Date(),
    });
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23503") throw error;
    orphanLinkRejected = true;
  }
  if (!orphanLinkRejected) throw new Error("REGISTRY_ORPHAN_SOURCE_LINK_ACCEPTED");
  console.log("REGISTRY_SCHEMA_SMOKE_PASS migration=011 effectiveRegonBackfilled=true approvedCorrectionChangesEffectiveOnly=true sourceRegonUnchanged=true correctionAudit=true onePendingCorrection=true lookupCachedByNipVersion=true leadingZeroNip=true canonicalIdentityConflicts=true oneSourceLink=true");
}

async function verifyRegonCorrections(seeded) {
  const models = require("../dist/infrastructure/database/db");
  const service = createImportService();
  const proposals = await Promise.allSettled([
    service.proposeRegonCorrection(seeded.batchId, 18001, {
      proposedRegon: "987654321", reason: "Synthetic review proposal A", expectedVersion: 1,
    }, "synthetic-operator-a"),
    service.proposeRegonCorrection(seeded.batchId, 18001, {
      proposedRegon: "987654322", reason: "Synthetic review proposal B", expectedVersion: 1,
    }, "synthetic-operator-b"),
  ]);
  const accepted = proposals.filter((result) => result.status === "fulfilled");
  const rejected = proposals.filter((result) => result.status === "rejected");
  if (accepted.length !== 1 || rejected.length !== 1 || rejected[0].reason?.getStatus?.() !== 409) {
    throw new Error("REGON_CONCURRENT_CORRECTION_NOT_SERIALIZED");
  }

  const row = await models.SourceRow.findByPk(seeded.sourceRowId);
  const corrections = await models.RegonCorrection.findAll({ where: { sourceRowId: seeded.sourceRowId } });
  if (!row || row.rowVersion !== 2 || row.regonRaw !== "012345678" || row.regon !== "012345678"
    || row.effectiveRegon !== "012345678" || corrections.length !== 1
    || corrections[0].status !== "pending" || !corrections[0].reason.startsWith("Synthetic review proposal")
    || !corrections[0].authorRef.startsWith("synthetic-operator-")) {
    throw new Error("REGON_CORRECTION_AUDIT_OR_SOURCE_INTEGRITY_MISMATCH");
  }
  const acceptedResult = accepted[0].value;
  if (acceptedResult.rowVersion !== 2 || acceptedResult.status !== "pending" || !acceptedResult.createdAt) {
    throw new Error("REGON_CORRECTION_RESPONSE_MISMATCH");
  }

  const assertRejected = async (input, expectedStatus, code) => {
    let actualStatus = null;
    try {
      await service.proposeRegonCorrection(seeded.batchId, 18001, input, "synthetic-operator-c");
    } catch (error) {
      actualStatus = error?.getStatus?.() ?? null;
    }
    if (actualStatus !== expectedStatus) throw new Error(code);
  };
  await assertRejected({ proposedRegon: "123456789", reason: "Stale request", expectedVersion: 1 }, 409, "REGON_STALE_VERSION_WAS_ACCEPTED");
  await assertRejected({ proposedRegon: "123456789", reason: "Pending exists", expectedVersion: 2 }, 409, "REGON_SECOND_PENDING_CORRECTION_WAS_ACCEPTED");
  await assertRejected({ proposedRegon: "12345678", reason: "Invalid identifier", expectedVersion: 2 }, 400, "REGON_INVALID_PROPOSAL_WAS_ACCEPTED");
  await assertRejected({ proposedRegon: "123456789", reason: "  ", expectedVersion: 2 }, 400, "REGON_EMPTY_REASON_WAS_ACCEPTED");
  const unchanged = await models.SourceRow.findByPk(seeded.sourceRowId);
  if (!unchanged || unchanged.rowVersion !== 2 || unchanged.effectiveRegon !== "012345678") {
    throw new Error("REGON_REJECTED_CORRECTION_MUTATED_SOURCE");
  }
  console.log("REGON_CORRECTION_SMOKE_PASS concurrency=one-accepted-one-conflict audit=actor-reason-time sourceUnchanged=true staleVersion=409 pending=409 invalid=400");
}

async function verifyRegistryEnrichment(seeded) {
  const models = require("../dist/infrastructure/database/db");
  const { RegistryEnrichmentService } = require("../dist/features/enrichment/public");
  const service = new RegistryEnrichmentService();
  const createEmptyRow = async (rowNumber) => {
    const id = randomUUID();
    await sequelize.query(
      `INSERT INTO source_rows (
         id, batch_id, row_number, company_name, decision_maker_name, nip_raw, address,
         postal_code, city, regon_raw, regon, effective_regon, row_version, issues
       ) VALUES ($1, $2, $3, 'Synthetic Company', NULL, '5260250995', 'Test 2', '00-000', 'Test City', '', NULL, NULL, 1, '[]'::jsonb)`,
      { bind: [id, seeded.batchId, rowNumber] },
    );
    return id;
  };
  const matchingRowId = await createEmptyRow(18001);
  const ambiguousRowId = await createEmptyRow(18002);
  const mismatchRowId = await createEmptyRow(18003);
  const notFoundRowId = await createEmptyRow(18004);
  const pendingCorrectionRowId = await createEmptyRow(18005);
  const result = (candidates) => ({
    providerName: "synthetic-registry",
    providerVersion: "fixture-1",
    dataVersion: "synthetic-release-2026-01",
    fetchedAt: new Date("2026-01-15T12:00:00.000Z"),
    candidates,
  });
  const matching = { nip: "5260250995", regon: "012345678", name: "Synthetic Company" };
  const concurrent = await Promise.allSettled([
    service.recordResult(seeded.batchId, 18001, 1, result([matching])),
    service.recordResult(seeded.batchId, 18001, 1, result([matching])),
  ]);
  const accepted = concurrent.filter((item) => item.status === "fulfilled");
  const rejected = concurrent.filter((item) => item.status === "rejected");
  if (accepted.length !== 1 || rejected.length !== 1 || rejected[0].reason?.getStatus?.() !== 409) {
    throw new Error("REGON_ENRICHMENT_CONCURRENCY_NOT_SERIALIZED");
  }
  const applied = await models.SourceRow.findByPk(matchingRowId);
  const appliedAudits = await models.RegistryEnrichmentAudit.findAll({ where: { sourceRowId: matchingRowId } });
  if (!applied || applied.regonRaw !== "" || applied.regon !== null || applied.effectiveRegon !== "012345678"
    || applied.rowVersion !== 2 || appliedAudits.length !== 1
    || appliedAudits[0].decisionStatus !== "matched" || !appliedAudits[0].applied
    || appliedAudits[0].effectiveRegonBefore !== null || appliedAudits[0].effectiveRegonAfter !== "012345678"
    || appliedAudits[0].rowVersionBefore !== 1 || appliedAudits[0].rowVersionAfter !== 2
    || appliedAudits[0].providerName !== "synthetic-registry"
    || appliedAudits[0].dataVersionLabel !== "synthetic-release-2026-01"
    || !/^[0-9a-f]{64}$/.test(appliedAudits[0].dataVersionHash)
    || !/^[0-9a-f]{64}$/.test(appliedAudits[0].responseFingerprint)) {
    throw new Error("REGON_ENRICHMENT_MATCH_AUDIT_OR_SOURCE_INTEGRITY_MISMATCH");
  }
  if (JSON.stringify(appliedAudits[0].toJSON()).includes("Synthetic Company")
    || JSON.stringify(appliedAudits[0].toJSON()).includes("candidates")) {
    throw new Error("REGON_ENRICHMENT_AUDIT_STORED_RAW_PROVIDER_DATA");
  }

  const ambiguous = await service.recordResult(seeded.batchId, 18002, 1, result([
    matching, { nip: "5260250995", regon: "00123456789012", name: "Synthetic Company", unitType: "LOCAL" },
  ]));
  const mismatch = await service.recordResult(seeded.batchId, 18003, 1, result([
    { ...matching, nip: "0000000017" },
  ]));
  const notFound = await service.recordResult(seeded.batchId, 18004, 1, result([]));
  const reviewedRows = await models.SourceRow.findAll({ where: { id: [ambiguousRowId, mismatchRowId, notFoundRowId] }, order: [["rowNumber", "ASC"]] });
  if (ambiguous.decision.status !== "ambiguous" || mismatch.decision.status !== "manual_review"
    || notFound.decision.status !== "not_found"
    || reviewedRows.length !== 3 || reviewedRows.some((row) => row.effectiveRegon !== null || row.regonRaw !== "" || row.regon !== null || row.rowVersion !== 2)) {
    throw new Error("REGON_ENRICHMENT_REVIEW_DECISIONS_MUTATED_SOURCE");
  }
  const cacheEntries = await models.RegistryLookupCache.findAll({ where: { nipNormalized: "5260250995" } });
  if (cacheEntries.length !== 1 || cacheEntries[0].attemptCount !== 4 || cacheEntries[0].status !== "not_found"
    || cacheEntries[0].dataVersion.length !== 64 || cacheEntries[0].responseFingerprint.length !== 64) {
    throw new Error("REGON_ENRICHMENT_LOOKUP_CACHE_MISMATCH");
  }
  await createImportService().proposeRegonCorrection(seeded.batchId, 18005, {
    proposedRegon: "123456789", reason: "Synthetic pending correction", expectedVersion: 1,
  }, "synthetic-operator");
  let pendingCorrectionConflict = false;
  try {
    await service.recordResult(seeded.batchId, 18005, 2, result([matching]));
  } catch (error) {
    pendingCorrectionConflict = error?.getStatus?.() === 409;
  }
  const pendingRow = await models.SourceRow.findByPk(pendingCorrectionRowId);
  const pendingAudits = await models.RegistryEnrichmentAudit.findAll({ where: { sourceRowId: pendingCorrectionRowId } });
  if (!pendingCorrectionConflict || !pendingRow || pendingRow.rowVersion !== 2 || pendingRow.effectiveRegon !== null
    || pendingAudits.length !== 0) {
    throw new Error("REGON_ENRICHMENT_OVERWROTE_PENDING_CORRECTION");
  }
  console.log("REGON_ENRICHMENT_SMOKE_PASS migration=013 matchAppliedToEffectiveOnly=true sourceRegonUnchanged=true auditHasProviderVersionAndFingerprints=true rawResponseAbsent=true ambiguousConflictNotFoundDoNotApply=true concurrentStaleVersion=409 pendingCorrectionBlocks=true cacheByNipAndVersion=true");
}

async function verifyCanonicalRunGroups(seeded) {
  smokeStage = "canonical_group_setup";
  const models = require("../dist/infrastructure/database/db");
  const { EntityGroupingService } = require("../dist/features/grouping/grouping.service");
  const { CanonicalRunService } = require("../dist/features/runs/canonical-run-service");
  const { WorkerCodeForwarder } = require("../dist/features/interventions/worker-code-forwarder");
  const { RunService } = require("../dist/features/runs/runs.service");
  const grouping = new EntityGroupingService();
  const canonicalRuns = new CanonicalRunService();
  const runService = new RunService(new WorkerCodeForwarder(), grouping, canonicalRuns);
  await sequelize.query("UPDATE source_rows SET nip_raw = '5260250995' WHERE id = $1", { bind: [seeded.sourceRowId] });
  const createSourceRow = async (rowNumber, values = {}) => {
    const id = randomUUID();
    const data = {
      companyName: "Synthetic Company",
      decisionMakerName: "Synthetic Decision Maker",
      nipRaw: "5260250995",
      regonRaw: "012345678",
      regon: "012345678",
      effectiveRegon: "012345678",
      ...values,
    };
    await sequelize.query(
      `INSERT INTO source_rows (
         id, batch_id, row_number, company_name, decision_maker_name, nip_raw, address,
         postal_code, city, regon_raw, regon, effective_regon, row_version, issues
       ) VALUES ($1, $2, $3, $4, $5, $6, 'Test 2', '00-000', 'Test City', $7, $8, $9, 1, '[]'::jsonb)`,
      { bind: [id, seeded.batchId, rowNumber, data.companyName, data.decisionMakerName, data.nipRaw, data.regonRaw, data.regon, data.effectiveRegon] },
    );
    return id;
  };
  const duplicateSourceRowId = await createSourceRow(18002);
  const secondPersonSourceRowId = await createSourceRow(18003, { decisionMakerName: "Another Synthetic Decision Maker" });
  try {
    smokeStage = "canonical_group_same_person_idempotency";
    const firstRun = await runService.create(seeded.batchId, 18001);
    const duplicateRequest = await runService.create(seeded.batchId, 18002);
    const secondPersonRun = await runService.create(seeded.batchId, 18003);
    if (firstRun.id !== duplicateRequest.id || firstRun.id === secondPersonRun.id) {
      throw new Error("CANONICAL_RUN_IDEMPOTENCY_OR_PERSON_SEPARATION_MISMATCH");
    }

    const groupedRun = await models.AutomationRun.findByPk(firstRun.id);
    const separateRun = await models.AutomationRun.findByPk(secondPersonRun.id);
    const groupedMembers = await models.RunSourceRow.findAll({ where: { runId: firstRun.id }, order: [["rowNumber", "ASC"]] });
    const separateMembers = await models.RunSourceRow.findAll({ where: { runId: secondPersonRun.id } });
    const sourceLinks = await models.SourceEntityLink.findAll({ where: { sourceRowId: [seeded.sourceRowId, duplicateSourceRowId, secondPersonSourceRowId] } });
    if (!groupedRun || !separateRun || !groupedRun.canonicalEntityId
      || groupedRun.canonicalEntityId !== separateRun.canonicalEntityId
      || groupedRun.leadIdentityKey === separateRun.leadIdentityKey
      || groupedMembers.length !== 2 || groupedMembers[0].rowNumber !== 18001 || groupedMembers[1].rowNumber !== 18002
      || groupedMembers.filter((member) => member.isPrimary).length !== 1
      || groupedRun.sourceRowId !== seeded.sourceRowId || separateMembers.length !== 1 || separateMembers[0].rowNumber !== 18003
      || sourceLinks.length !== 3 || new Set(sourceLinks.map((link) => link.canonicalEntityId)).size !== 1) {
      throw new Error("CANONICAL_RUN_SOURCE_LINKS_OR_IDENTITY_MISMATCH");
    }

    smokeStage = "canonical_group_conflict_persistence";
    const conflictSourceRowId = await createSourceRow(18004, { regonRaw: "987654321", regon: "987654321", effectiveRegon: "987654321" });
    const conflictOutcomes = await grouping.resolveRelatedRows(seeded.batchId, 18004);
    const conflictRow = await models.SourceRow.findByPk(conflictSourceRowId);
    const conflictRecords = await models.EntityGroupingConflict.findAll({ where: { sourceRowId: conflictSourceRowId } });
    let runBlocked = false;
    try { await runService.create(seeded.batchId, 18004); }
    catch (error) { runBlocked = error?.getStatus?.() === 409; }
    if (!conflictOutcomes.some((item) => item.status === "conflict" && item.reasonCode === "SAME_NIP_DIFFERENT_REGON")
      || !conflictRow || conflictRow.rowVersion !== 2 || conflictRecords.length !== 1
      || conflictRecords[0].status !== "open" || conflictRecords[0].reasonCode !== "SAME_NIP_DIFFERENT_REGON"
      || !runBlocked) {
      throw new Error("CANONICAL_GROUP_CONFLICT_NOT_PERSISTED_OR_RUN_NOT_BLOCKED");
    }

    smokeStage = "canonical_group_similar_name_separation";
    const similarNameSourceRowId = await createSourceRow(18005, {
      companyName: "Synthetic Company Limited", decisionMakerName: "Synthetic Decision Maker",
      nipRaw: "0000000017", regonRaw: "987654321", regon: "987654321", effectiveRegon: "987654321",
    });
    const similarNameRun = await runService.create(seeded.batchId, 18005);
    const similarNameLink = await models.SourceEntityLink.findByPk(similarNameSourceRowId);
    if (!similarNameLink || similarNameLink.canonicalEntityId === groupedRun.canonicalEntityId
      || (await models.AutomationRun.findByPk(similarNameRun.id))?.canonicalEntityId !== similarNameLink.canonicalEntityId) {
      throw new Error("CANONICAL_GROUP_SIMILAR_NAME_WAS_MERGED");
    }

    smokeStage = "canonical_group_enrichment_review";
    const imports = createImportService();
    const similarNameRow = await models.SourceRow.findByPk(similarNameSourceRowId);
    await imports.proposeRegonCorrection(seeded.batchId, 18005, {
      proposedRegon: "111111111", reason: "Synthetic review fixture", expectedVersion: similarNameRow.rowVersion,
    }, "bootstrap-admin");
    const review = await imports.enrichmentReview(seeded.batchId, 1);
    const reviewConflict = review.rows.find((row) => row.rowNumber === 18004)?.conflict;
    const reviewCorrection = review.rows.find((row) => row.rowNumber === 18005)?.correction;
    if (review.totalRows !== 1 || review.summary.pendingCorrectionRows !== 1 || review.summary.openConflictRows !== 1
      || reviewCorrection?.status !== "pending" || reviewCorrection.proposedRegon !== "111111111"
      || reviewConflict?.reasonCode !== "SAME_NIP_DIFFERENT_REGON"
      || review.rows.some((row) => "nipRaw" in row || "pesel" in row)) {
      throw new Error("CANONICAL_GROUP_ENRICHMENT_REVIEW_MISMATCH");
    }
    console.log("CANONICAL_RUN_GROUPS_SMOKE_PASS migration=014 sameIdentityDuplicates=oneRunTwoSourceRows=true differentDecisionMakers=separateRuns=true canonicalCompanyShared=true conflictPersistedAndBlocked=true similarNameKeptSeparate=true correctionProposalAudited=true reviewRedactsIdentifiers=true queueEnqueue=true");
  } finally {
    await runService.onModuleDestroy();
  }
}

async function verifyGroupingScale(batchId) {
  smokeStage = "grouping_scale_seed_30000";
  const models = require("../dist/infrastructure/database/db");
  const { EntityGroupingService } = require("../dist/features/grouping/grouping.service");
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const makeValidNip = (prefixValue) => {
    let value = prefixValue;
    for (;;) {
      const prefix = String(value).padStart(9, "0");
      const check = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11;
      if (check !== 10) return `${prefix}${check}`;
      value += 1;
    }
  };
  const makeValidRegon = (prefixValue) => {
    const weights = [8, 9, 2, 3, 4, 5, 6, 7];
    const prefix = String(prefixValue).padStart(8, "0").slice(-8);
    const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11;
    return `${prefix}${checksum === 10 ? 0 : checksum}`;
  };
  const measureSql = async (operation) => {
    const previousLogging = models.sequelize.options.logging;
    const statements = [];
    models.sequelize.options.logging = (sql) => statements.push(String(sql));
    try { return { value: await operation(), queryCount: statements.length }; }
    finally { models.sequelize.options.logging = previousLogging; }
  };
  const seedRows = Array.from({ length: 30_000 }, (_, index) => ({
    id: randomUUID(), batchId, rowNumber: 100_000 + index,
    companyName: `Synthetic grouping load ${index}`, decisionMakerName: null,
    nipRaw: makeValidNip(600_000_000 + index), address: "Synthetic", postalCode: "00-000", city: "Test City",
    regonRaw: "", regon: null, effectiveRegon: null, rowVersion: 1, issues: [],
  }));
  for (let start = 0; start < seedRows.length; start += 1_000) {
    await models.SourceRow.bulkCreate(seedRows.slice(start, start + 1_000));
  }
  const targetNip = makeValidNip(950_000_001);
  const targetRows = [
    { id: randomUUID(), batchId, rowNumber: 140_001 },
    { id: randomUUID(), batchId, rowNumber: 140_002 },
  ];
  await models.SourceRow.bulkCreate(targetRows.map(({ id, rowNumber }) => ({
    id, batchId, rowNumber, companyName: "Synthetic grouping target", decisionMakerName: null,
    nipRaw: targetNip, address: "Synthetic", postalCode: "00-000", city: "Test City",
    regonRaw: "", regon: null, effectiveRegon: null, rowVersion: 1, issues: [],
  })));
  await sequelize.query("ANALYZE source_rows");

  const [explainRows] = await sequelize.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id, row_number FROM source_rows
     WHERE batch_id = $1 AND nip_raw <> '' AND regexp_replace(nip_raw, '[[:space:]-]', '', 'g') = $2
     ORDER BY row_number ASC`,
    { bind: [batchId, targetNip] },
  );
  const queryPlan = explainRows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  if (!queryPlan) throw new Error("GROUPING_SCALE_EXPLAIN_MISSING_PLAN");
  const planNodes = [];
  const collectPlanNodes = (node) => {
    planNodes.push(node);
    for (const child of node.Plans ?? []) collectPlanNodes(child);
  };
  collectPlanNodes(queryPlan);
  const usedIndexes = planNodes.map((node) => node["Index Name"]).filter(Boolean);
  if (!usedIndexes.includes("source_rows_batch_nip_normalized_idx")) {
    const planSummary = planNodes.map((node) => ({
      type: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"],
      rows: node["Actual Rows"], filter: node.Filter, indexCondition: node["Index Cond"],
    }));
    throw new Error(`GROUPING_SCALE_NIP_INDEX_NOT_USED_${usedIndexes.join(",") || "none"}_${JSON.stringify(planSummary)}`);
  }

  smokeStage = "grouping_scale_resolve_related_rows";
  const startedAt = performance.now();
  const grouping = new EntityGroupingService();
  const measuredTarget = await measureSql(() => grouping.resolveRelatedRows(batchId, targetRows[0].rowNumber));
  const outcomes = measuredTarget.value;
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  if (outcomes.length !== 2 || outcomes.some((outcome) => outcome.status !== "linked")
    || new Set(outcomes.map((outcome) => outcome.canonicalEntityId)).size !== 1
    || measuredTarget.queryCount < 1 || measuredTarget.queryCount > 100) {
    throw new Error("GROUPING_SCALE_RELATED_RESULT_MISMATCH");
  }

  smokeStage = "grouping_broad_candidate_group";
  const broadNip = makeValidNip(950_000_051);
  const broadRows = Array.from({ length: 40 }, (_, index) => ({
    id: randomUUID(), batchId, rowNumber: 141_000 + index, companyName: "Synthetic broad grouping group",
    decisionMakerName: null, nipRaw: broadNip, address: "Synthetic", postalCode: "00-000", city: "Test City",
    regonRaw: "", regon: null, effectiveRegon: null, rowVersion: 1, issues: [],
  }));
  await models.SourceRow.bulkCreate(broadRows);
  const measuredBroad = await measureSql(() => grouping.resolveRelatedRows(batchId, broadRows[0].rowNumber));
  if (measuredBroad.value.length !== broadRows.length || measuredBroad.value.some((outcome) => outcome.status !== "linked")
    || new Set(measuredBroad.value.map((outcome) => outcome.canonicalEntityId)).size !== 1
    || measuredBroad.queryCount < 1 || measuredBroad.queryCount > 1_500) {
    throw new Error(`GROUPING_BROAD_CANDIDATE_GROUP_MISMATCH outcomes=${measuredBroad.value.length} queries=${measuredBroad.queryCount}`);
  }

  smokeStage = "grouping_semantic_scan_equivalence";
  const semanticNip = makeValidNip(950_000_101);
  const semanticOtherNip = makeValidNip(950_000_201);
  const semanticRegon = makeValidRegon(87654321);
  const semanticOtherRegon = makeValidRegon(87654311);
  const semanticRows = [
    { rowNumber: 140_010, nipRaw: `${semanticNip.slice(0, 3)}-${semanticNip.slice(3, 6)}-${semanticNip.slice(6)}`, effectiveRegon: semanticRegon },
    { rowNumber: 140_011, nipRaw: `${semanticNip.slice(0, 3)} ${semanticNip.slice(3, 6)} ${semanticNip.slice(6)}`, effectiveRegon: semanticRegon },
    { rowNumber: 140_012, nipRaw: semanticOtherNip, effectiveRegon: semanticRegon },
    { rowNumber: 140_013, nipRaw: semanticOtherNip, effectiveRegon: semanticOtherRegon },
  ];
  await models.SourceRow.bulkCreate(semanticRows.map((row) => ({
    id: randomUUID(), batchId, rowNumber: row.rowNumber, companyName: "Synthetic semantic grouping target",
    decisionMakerName: null, nipRaw: row.nipRaw, address: "Synthetic", postalCode: "00-000", city: "Test City",
    regonRaw: row.effectiveRegon, regon: row.effectiveRegon, effectiveRegon: row.effectiveRegon,
    rowVersion: 1, issues: [],
  })));
  const { normalizeNip, normalizeRegon } = require("@goldis/core");
  const selected = semanticRows[0];
  const fullScanRows = await models.SourceRow.findAll({
    where: { batchId }, attributes: ["rowNumber", "nipRaw", "effectiveRegon"], order: [["rowNumber", "ASC"]],
  });
  const selectedNip = normalizeNip(selected.nipRaw).normalized;
  const selectedRegon = normalizeRegon(selected.effectiveRegon).normalized;
  const referenceRows = fullScanRows.filter((row) => {
    const candidateNip = normalizeNip(row.nipRaw).normalized;
    const candidateRegon = row.effectiveRegon ? normalizeRegon(row.effectiveRegon).normalized : null;
    return (selectedNip !== null && candidateNip === selectedNip)
      || (selectedRegon !== null && candidateRegon === selectedRegon);
  }).map((row) => row.rowNumber);
  const semanticOutcomes = await new EntityGroupingService().resolveRelatedRows(batchId, selected.rowNumber);
  const optimizedRows = semanticOutcomes.map((outcome) => outcome.rowNumber);
  if (JSON.stringify(optimizedRows) !== JSON.stringify(referenceRows)
    || JSON.stringify(optimizedRows) !== JSON.stringify([140_010, 140_011, 140_012])
    || semanticOutcomes[2]?.status !== "conflict"
    || semanticOutcomes[2]?.reasonCode !== "SAME_REGON_DIFFERENT_NIP") {
    throw new Error(`GROUPING_SCAN_SEMANTICS_MISMATCH_expected_${JSON.stringify(referenceRows)}_actual_${JSON.stringify(optimizedRows)}`);
  }
  console.log(`GROUPING_SCALE_PASS seededRows=30000 targetRows=2 indexUsed=true actualMs=${queryPlan["Actual Total Time"]} resolveMs=${elapsedMs} targetSqlQueries=${measuredTarget.queryCount} broadGroupRows=${broadRows.length} broadGroupSqlQueries=${measuredBroad.queryCount} externalRequests=0 semanticReferenceRows=${fullScanRows.length} semanticMatches=${referenceRows.length} optimizedMatches=${optimizedRows.length} nipRegonDeduplicated=true conflictPreserved=true`);
}

async function verifyUserSchema(seeded = null, queuedSeed = null, legacyGrantUsers = null) {
  smokeStage = "users_schema_seed";
  const models = require("../dist/infrastructure/database/db");
  const [interventionColumns] = await sequelize.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('manual_interventions', 'intervention_user_reads',
       'automation_runs', 'run_manual_data_overrides', 'worker_runtime_status', 'import_batches',
       'users', 'user_sessions', 'tool_grants', 'tool_settings', 'tools', 'intervention_activity')`,
  );
  const requiredInterventionColumns = {
    intervention_user_reads: ["intervention_id", "user_id", "seen_revision", "updated_at"],
    automation_runs: ["manual_data_version"],
    manual_interventions: ["revision", "updated_at", "field_code", "assignee_user_id", "priority", "due_at", "assigned_at", "assigned_by"],
    run_manual_data_overrides: ["run_id", "version", "source", "fields", "reason", "created_by", "created_at"],
    worker_runtime_status: ["worker_id", "mode", "portal_config_valid", "observed_at"],
    import_batches: ["tool_id"],
    users: ["must_change_password"],
    user_sessions: ["session_id", "tenant_id", "user_id", "expires_at", "revoked_at", "browser_label", "last_activity_at"],
    tools: ["tool_id", "display_name", "status"],
    tool_grants: ["tenant_id", "tool_id", "user_id", "can_discover", "can_execute", "can_view_results", "can_download_results", "version"],
    tool_settings: ["tenant_id", "tool_id", "enabled_for_new_runs", "timezone", "version"],
    intervention_activity: ["activity_id", "intervention_id", "actor_user_id", "event_type", "created_at"],
  };
  for (const [table, required] of Object.entries(requiredInterventionColumns)) {
    const actual = interventionColumns.filter((column) => column.table_name === table).map((column) => column.column_name);
    if (required.some((column) => !actual.includes(column))) throw new Error(`INTERVENTION_SCHEMA_COLUMNS_MISMATCH_${table}`);
  }
  const { hashPassword } = require("../dist/features/auth/index");
  const { AuthController, SessionGuard, resolveActiveSessionRole, resolveCurrentSessionRole, verifyCsrfRequest } = require("../dist/features/auth/index");
  const { bootstrapAdminOnce } = require("../dist/features/auth/bootstrap-admin");
  const bootstrapConfig = () => ({ username: process.env.GOLDIS_ADMIN_USER, password: process.env.GOLDIS_ADMIN_PASSWORD });
  const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
  if (!tenant || tenant.displayName !== "Goldis Ubezpieczenia") throw new Error("USER_MIGRATION_TENANT_SEED_MISMATCH");
  const tenantCount = await models.Tenant.count();
  if (tenantCount !== 1) throw new Error("USER_MIGRATION_DUPLICATED_TENANT");

  const oldBootstrapUser = process.env.GOLDIS_ADMIN_USER;
  const oldBootstrapPassword = process.env.GOLDIS_ADMIN_PASSWORD;
  const bootstrapPassword = "Synthetic-only Bootstrap Password!";
  process.env.GOLDIS_ADMIN_USER = "Synthetic.Bootstrap.Admin";
  process.env.GOLDIS_ADMIN_PASSWORD = bootstrapPassword;
  try {
    await bootstrapAdminOnce(bootstrapConfig());
    process.env.GOLDIS_ADMIN_USER = "Synthetic.Other.Admin";
    process.env.GOLDIS_ADMIN_PASSWORD = "Different Synthetic Password!";
    await bootstrapAdminOnce(bootstrapConfig());
  } finally {
    if (oldBootstrapUser === undefined) delete process.env.GOLDIS_ADMIN_USER;
    else process.env.GOLDIS_ADMIN_USER = oldBootstrapUser;
    if (oldBootstrapPassword === undefined) delete process.env.GOLDIS_ADMIN_PASSWORD;
    else process.env.GOLDIS_ADMIN_PASSWORD = oldBootstrapPassword;
  }
  const bootstrapAdmin = await models.User.findOne({ where: { usernameNormalized: "synthetic.bootstrap.admin" } });
  const { verifyPassword } = require("../dist/features/auth/index");
  const bootstrapMembership = bootstrapAdmin ? await models.TenantMembership.findOne({
    where: { tenantId: tenant.tenantId, userId: bootstrapAdmin.userId, role: "admin", status: "active" },
  }) : null;
  if (!bootstrapAdmin || !await verifyPassword(bootstrapPassword, bootstrapAdmin.passwordHash)
    || await models.User.findOne({ where: { usernameNormalized: "synthetic.other.admin" } })
    || !bootstrapMembership || (await models.User.count()) !== (legacyGrantUsers ? 4 : 1)
    || (await models.TenantMembership.count()) !== (legacyGrantUsers ? 4 : 1)) {
    throw new Error("USER_MIGRATION_BOOTSTRAP_ADMIN_NOT_IDEMPOTENT");
  }
  if (seeded) {
    const batch = await models.ImportBatch.findByPk(seeded.batchId);
    const run = await models.AutomationRun.findByPk(seeded.runId);
    if (!batch || batch.tenantId !== tenant.tenantId || batch.ownerUserId !== bootstrapAdmin.userId || run?.status !== "failed") {
      throw new Error("USER_MIGRATION_LEGACY_OWNERSHIP_OR_RUN_CHANGED");
    }
  }

  const now = new Date();
  const baseUserCount = await models.User.count();
  const baseMembershipCount = await models.TenantMembership.count();
  const syntheticPassword = "Synthetic-only migration smoke password!";
  const user = await models.User.create({
    userId: randomUUID(), username: "Synthetic.Operator", usernameNormalized: "synthetic.operator",
    passwordHash: await hashPassword(syntheticPassword), status: "active", createdAt: now, updatedAt: now, lastLoginAt: null,
  });
  const membership = await models.TenantMembership.create({
    tenantId: tenant.tenantId, userId: user.userId, role: "operator", status: "active", createdAt: now, updatedAt: now,
  });
  if (await models.ToolGrant.findOne({ where: { tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: user.userId } })) {
    throw new Error("NEW_USER_TOOL_GRANT_SHOULD_DEFAULT_TO_NONE");
  }
  const toolGrant = await models.ToolGrant.create({
    tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: user.userId,
    canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true,
    grantedBy: bootstrapAdmin.userId, createdAt: now, updatedAt: now, version: 1,
  });
  await toolGrant.update({ canViewResults: false, canDownloadResults: true });
  if (toolGrant.canViewResults || !toolGrant.canDownloadResults) throw new Error("DOWNLOAD_GRANT_MUST_BE_INDEPENDENT");
  await toolGrant.update({ canViewResults: true });
  if (legacyGrantUsers) {
    const migratedOperatorGrant = await models.ToolGrant.findOne({ where: {
      tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: legacyGrantUsers.operatorId,
    } });
    const migratedReviewerGrant = await models.ToolGrant.findOne({ where: {
      tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: legacyGrantUsers.reviewerId,
    } });
    const disabledMembershipGrant = await models.ToolGrant.findOne({ where: {
      tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: legacyGrantUsers.disabledOperatorId,
    } });
    if (!migratedOperatorGrant?.canDiscover || !migratedOperatorGrant.canExecute
      || !migratedOperatorGrant.canViewResults || !migratedOperatorGrant.canDownloadResults
      || !migratedReviewerGrant?.canDiscover || migratedReviewerGrant.canExecute
      || !migratedReviewerGrant.canViewResults || migratedReviewerGrant.canDownloadResults
      || disabledMembershipGrant) {
      throw new Error("TOOL_GRANT_LEGACY_BACKFILL_MISMATCH");
    }
  }
  let manualOverride = null;
  let mergedOverrides = null;
  if (seeded) {
    manualOverride = await models.RunManualDataOverride.create({
      runId: seeded.runId, version: 1, source: "admin_correction", fields: { address: "ul. Testowa 1" },
      reason: "Syntetyczna poprawka adresu do testu schematu", createdBy: user.userId, createdAt: now,
    });
    await models.RunManualDataOverride.create({
      runId: seeded.runId, version: 2, source: "admin_correction", fields: { city: "Testowo" },
      reason: "Syntetyczna poprawka miasta do testu schematu", createdBy: user.userId, createdAt: now,
    });
    const [mergedRows] = await sequelize.query(
      `SELECT jsonb_object_agg(field_name, field_value) AS fields FROM (
         SELECT DISTINCT ON (entry.key) entry.key AS field_name, entry.value AS field_value
         FROM run_manual_data_overrides override CROSS JOIN LATERAL jsonb_each(override.fields) entry
         WHERE override.run_id = :runId ORDER BY entry.key, override.version DESC
       ) latest_fields`,
      { replacements: { runId: seeded.runId } },
    );
    mergedOverrides = mergedRows[0]?.fields;
  }
  const event = await models.AuditEvent.create({
    eventId: randomUUID(), tenantId: tenant.tenantId, actorUserId: user.userId,
    action: "run.created", resourceType: "run", resourceId: randomUUID(), outcome: "succeeded",
    requestRef: "synthetic-request", metadata: { rowNumber: 18001 }, createdAt: now,
  });
  if (membership.role !== "operator" || !toolGrant.canExecute || event.actorUserId !== user.userId
    || (seeded && (!manualOverride || manualOverride.fields.address !== "ul. Testowa 1" || manualOverride.version !== 1
      || mergedOverrides?.address !== "ul. Testowa 1" || mergedOverrides?.city !== "Testowo"))
    || (await models.User.count()) !== baseUserCount + 1
    || (await models.TenantMembership.count()) !== baseMembershipCount + 1
    || (await models.AuditEvent.count()) !== 1) {
    throw new Error("USER_MIGRATION_ORM_MAPPING_MISMATCH");
  }
  await sequelize.query(
    `INSERT INTO worker_runtime_status (worker_id, mode, portal_config_valid, observed_at)
     VALUES ('migration-smoke-worker', 'off', false, now())`,
  );
  const [runtimeRows] = await sequelize.query(
    "SELECT mode, portal_config_valid FROM worker_runtime_status WHERE worker_id = 'migration-smoke-worker'",
  );
  if (runtimeRows.length !== 1 || runtimeRows[0].mode !== "off" || runtimeRows[0].portal_config_valid !== false) {
    throw new Error("WORKER_RUNTIME_STATUS_SCHEMA_MISMATCH");
  }
  await sequelize.query("DELETE FROM worker_runtime_status WHERE worker_id = 'migration-smoke-worker'");
  if (await resolveActiveSessionRole(user.userId, tenant.tenantId) !== "operator") {
    throw new Error("USER_MIGRATION_ACTIVE_MEMBERSHIP_NOT_RESOLVED");
  }
  const managerUser = await models.User.create({
    userId: randomUUID(), username: "Synthetic.Manager", usernameNormalized: "synthetic.manager",
    passwordHash: await hashPassword("Synthetic-only manager smoke password!"), status: "active",
    createdAt: now, updatedAt: now, lastLoginAt: null,
  });
  const managerMembership = await models.TenantMembership.create({ tenantId: tenant.tenantId, userId: managerUser.userId,
    role: "manager", status: "active", createdAt: now, updatedAt: now });
  const managerRole = await resolveActiveSessionRole(managerUser.userId, tenant.tenantId);
  await models.ToolGrant.create({ tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: managerUser.userId,
    canDiscover: true, canExecute: true, canViewResults: false, canDownloadResults: false,
    grantedBy: bootstrapAdmin.userId, createdAt: now, updatedAt: now, version: 1 });
  const { readToolAccess } = require("../dist/features/authorization/tool-access");
  const managerAccess = await readToolAccess({ tenantId: tenant.tenantId, userId: managerUser.userId, role: managerRole }, "oc-policy-verification");
  const { canPerform } = require("../dist/features/authorization/index");
  if (managerRole !== "manager" || !managerAccess?.canExecute || !managerAccess.canViewResults
    || !managerAccess.canDownloadResults || canPerform("manager", "user:manage", {})) {
    throw new Error("MANAGER_MEMBERSHIP_GRANT_OR_ADMIN_BOUNDARY_MISMATCH");
  }
  const managerGrant = await models.ToolGrant.findOne({ where: {
    tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: managerUser.userId,
  } });
  const managerGrantCases = [
    { name: "none", canDiscover: false, canExecute: false, canViewResults: false, canDownloadResults: false,
      expected: [true, false, true, true] },
    { name: "discover", canDiscover: true, canExecute: false, canViewResults: false, canDownloadResults: false,
      expected: [true, false, true, true] },
    { name: "execute", canDiscover: true, canExecute: true, canViewResults: false, canDownloadResults: false,
      expected: [true, true, true, true] },
    { name: "view", canDiscover: false, canExecute: false, canViewResults: true, canDownloadResults: false,
      expected: [true, false, true, true] },
    { name: "discover-view", canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: false,
      expected: [true, false, true, true] },
    { name: "execute-view", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false,
      expected: [true, true, true, true] },
    { name: "view-download", canDiscover: false, canExecute: false, canViewResults: true, canDownloadResults: true,
      expected: [true, false, true, true] },
    { name: "discover-view-download", canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: true,
      expected: [true, false, true, true] },
    { name: "execute-view-download", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true,
      expected: [true, true, true, true] },
  ];
  for (const [index, grantCase] of managerGrantCases.entries()) {
    await managerGrant.update({
      canDiscover: grantCase.canDiscover, canExecute: grantCase.canExecute,
      canViewResults: grantCase.canViewResults, canDownloadResults: grantCase.canDownloadResults,
      version: index + 2, updatedAt: new Date(now.getTime() + index + 1),
    });
    const access = await readToolAccess({ tenantId: tenant.tenantId, userId: managerUser.userId, role: managerRole }, "oc-policy-verification");
    const actual = access && [access.canDiscover, access.canExecute, access.canViewResults, access.canDownloadResults];
    if (JSON.stringify(actual) !== JSON.stringify(grantCase.expected)) {
      throw new Error(`MANAGER_GRANT_CAPABILITY_MATRIX_MISMATCH_${grantCase.name}`);
    }
  }
  const managerSessionId = randomUUID();
  await models.UserSession.create({
    sessionId: managerSessionId, tenantId: tenant.tenantId, userId: managerUser.userId,
    credentialRevision: managerUser.credentialRevision ?? 1, createdAt: now, lastSeenAt: now,
    lastActivityAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000), revokedAt: null,
    revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic manager revocation matrix",
  });
  if (await resolveCurrentSessionRole(managerUser.userId, tenant.tenantId, managerSessionId) !== "manager") {
    throw new Error("MANAGER_CURRENT_SESSION_ROLE_NOT_RESOLVED");
  }
  await managerMembership.update({ role: "reviewer", updatedAt: new Date(now.getTime() + 1) });
  if (await resolveCurrentSessionRole(managerUser.userId, tenant.tenantId, managerSessionId) !== "reviewer") {
    throw new Error("MANAGER_ROLE_CHANGE_NOT_APPLIED_TO_ACTIVE_SESSION");
  }
  await managerMembership.update({ role: "manager", status: "disabled", updatedAt: new Date(now.getTime() + 2) });
  if (await resolveCurrentSessionRole(managerUser.userId, tenant.tenantId, managerSessionId) !== null) {
    throw new Error("DISABLED_MANAGER_MEMBERSHIP_DID_NOT_REVOKE_ACTIVE_SESSION");
  }

  const previousSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "synthetic-session-secret-for-users-migration-smoke";
  const { AuthenticationRepository, AuthService } = require("../dist/features/auth");
  const { recordAuditEvent } = require("../dist/features/audit/public");
  const cookies = {};
  const loginLimiter = {
    async consumeAttempt() { return { allowed: true, retryAfterSeconds: 0 }; },
    async clearPair() {},
  };
  const login = await new AuthController(
    loginLimiter,
    new AuthService(new AuthenticationRepository({ record: recordAuditEvent })),
    {},
  ).login({ username: " synthetic.operator ", password: syntheticPassword }, {
    ip: "203.0.113.99",
    socket: { remoteAddress: "203.0.113.99" },
    headers: {},
  }, {
    cookie(name, value, options) { cookies[name] = { value, options }; },
    setHeader() {},
  });
  const sessionToken = cookies.goldis_session?.value;
  const csrfToken = cookies.goldis_csrf?.value;
  const sessionPayload = sessionToken
    ? JSON.parse(Buffer.from(sessionToken.split(".")[0], "base64url").toString("utf8"))
    : null;
  const csrfValid = Boolean(sessionToken && csrfToken && verifyCsrfRequest({ headers: {
    cookie: `goldis_session=${sessionToken}; goldis_csrf=${csrfToken}`,
    "x-csrf-token": csrfToken,
  } }));
  if (login.role !== "operator" || sessionPayload?.v !== 2 || !sessionPayload?.sessionId
    || sessionPayload?.userId !== user.userId
    || sessionPayload?.tenantId !== tenant.tenantId || "role" in (sessionPayload ?? {}) || !csrfValid) {
    throw new Error("USER_MIGRATION_DB_LOGIN_OR_SESSION_MISMATCH");
  }
  if (await resolveCurrentSessionRole(user.userId, tenant.tenantId, sessionPayload.sessionId) !== "operator"
    || (await models.UserSession.findByPk(sessionPayload.sessionId))?.userId !== user.userId) {
    throw new Error("USER_SESSION_REGISTRY_OR_ROLE_RESOLUTION_MISMATCH");
  }
  const sessionGuard = new SessionGuard();
  const makeSessionContext = (path) => {
    const request = { path, headers: { cookie: `goldis_session=${sessionToken}` } };
    return { switchToHttp: () => ({ getRequest: () => request }) };
  };
  if (!await sessionGuard.canActivate(makeSessionContext("/api/runs"))) {
    throw new Error("ACTIVE_SESSION_GUARD_REJECTED_DB_SESSION");
  }
  await user.update({ mustChangePassword: true });
  let passwordChangeRequiredStatus = null;
  try { await sessionGuard.canActivate(makeSessionContext("/api/runs")); }
  catch (error) { passwordChangeRequiredStatus = error?.getStatus?.() ?? null; }
  await user.update({ mustChangePassword: false });
  if (passwordChangeRequiredStatus !== 403) throw new Error("TEMPORARY_PASSWORD_GATE_NOT_ENFORCED");
  const idleNow = new Date();
  const idleCreatedAt = new Date(idleNow.getTime() - 31 * 60_000);
  const idleSessionId = randomUUID();
  await models.UserSession.create({
    sessionId: idleSessionId, tenantId: tenant.tenantId, userId: user.userId,
    credentialRevision: user.credentialRevision, createdAt: idleCreatedAt,
    lastSeenAt: idleNow, lastActivityAt: idleCreatedAt,
    expiresAt: new Date(idleNow.getTime() + 60 * 60_000), revokedAt: null,
    revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic idle smoke",
  });
  if (await resolveCurrentSessionRole(user.userId, tenant.tenantId, idleSessionId) !== null
    || (await models.UserSession.findByPk(idleSessionId))?.revokeReason !== "idle") {
    throw new Error("IDLE_SESSION_NOT_REVOKED");
  }
  await models.UserSession.update({ revokedAt: new Date(), revokeReason: "admin" }, {
    where: { sessionId: sessionPayload.sessionId, tenantId: tenant.tenantId, userId: user.userId, revokedAt: null },
  });
  if (await resolveCurrentSessionRole(user.userId, tenant.tenantId, sessionPayload.sessionId) !== null) {
    throw new Error("REVOKED_SESSION_STILL_RESOLVES");
  }
  let revokedSessionStatus = null;
  try { await sessionGuard.canActivate(makeSessionContext("/api/runs")); }
  catch (error) { revokedSessionStatus = error?.getStatus?.() ?? null; }
  if (revokedSessionStatus !== 401) throw new Error("REVOKED_SESSION_GUARD_NOT_ENFORCED");

  await membership.update({ status: "disabled" });
  const disabledMembershipRole = await resolveActiveSessionRole(user.userId, tenant.tenantId);
  await membership.update({ status: "active" });
  await user.update({ status: "disabled" });
  const disabledUserRole = await resolveActiveSessionRole(user.userId, tenant.tenantId);
  await user.update({ status: "active" });
  if (disabledMembershipRole !== null || disabledUserRole !== null) {
    throw new Error("USER_MIGRATION_DISABLED_PRINCIPAL_ACCEPTED");
  }
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;

  const checkViolation = (error) => error?.parent?.code === "23514" || error?.original?.code === "23514";
  const userPayload = (username, usernameNormalized, passwordHash = `scrypt$${"a".repeat(40)}`) => ({
    userId: randomUUID(), username, usernameNormalized, passwordHash,
    status: "active", createdAt: now, updatedAt: now, lastLoginAt: null,
  });
  for (const [username, usernameNormalized, passwordHash] of [
    ["Bad.Normalization", "different.normalization", `scrypt$${"a".repeat(40)}`],
    ["short.hash", "short.hash", "short"],
  ]) {
    let invalidUserRejected = false;
    try {
      await models.User.create(userPayload(username, usernameNormalized, passwordHash));
    } catch (error) {
      invalidUserRejected = checkViolation(error);
    }
    if (!invalidUserRejected) throw new Error("USER_MIGRATION_INVALID_USER_ACCEPTED");
  }

  const roleProbe = await models.User.create(userPayload("synthetic.role-probe", "synthetic.role-probe"));
  for (const invalidMembership of [
    { role: "root", status: "active" },
    { role: "operator", status: "unknown" },
  ]) {
    let invalidMembershipRejected = false;
    try {
      await models.TenantMembership.create({
        tenantId: tenant.tenantId, userId: roleProbe.userId, ...invalidMembership,
        createdAt: now, updatedAt: now,
      });
    } catch (error) {
      invalidMembershipRejected = checkViolation(error);
    }
    if (!invalidMembershipRejected) throw new Error("USER_MIGRATION_INVALID_MEMBERSHIP_ACCEPTED");
  }

  let batchId;
  if (seeded) {
    batchId = seeded.batchId;
  } else {
    const batch = await models.ImportBatch.create({
      id: randomUUID(), tenantId: null, ownerUserId: null,
      toolId: "oc-policy-verification",
      fileName: "synthetic.xlsx", sha256: "b".repeat(64), totalRows: 0, invalidRows: 0, createdAt: now,
    });
    batchId = batch.id;
  }
  await sequelize.query(
    "UPDATE import_batches SET tenant_id = $1, owner_user_id = $2 WHERE id = $3",
    { bind: [tenant.tenantId, user.userId, batchId] },
  );
  const adoptedBatch = await models.ImportBatch.findByPk(batchId);
  if (adoptedBatch?.tenantId !== tenant.tenantId || adoptedBatch.ownerUserId !== user.userId) {
    throw new Error("USER_MIGRATION_BATCH_MEMBERSHIP_LINK_MISMATCH");
  }

  smokeStage = "users_permission_guard_db_scope";
  const { PermissionGuard, resolvePermissionResource } = require("../dist/features/authorization/index");
  const { ImportController } = require("../dist/features/imports/import.controller");
  const { RunController } = require("../dist/features/runs/runs.controller");
  const permissionGuard = new PermissionGuard(resolvePermissionResource);
  const makePrincipal = (role, userId = user.userId, tenantId = tenant.tenantId) => ({
    exp: Date.now() + 60000, csrf: "synthetic-csrf-token-with-sufficient-length-0000000000000000",
    userId, tenantId, actorRef: userId, role,
  });
  const guardContext = (principal, handler, request) => ({
    switchToHttp: () => ({ getRequest: () => ({ ...request, goldisPrincipal: principal }) }),
    getHandler: () => handler,
  });
  const operatorOwnBatch = await permissionGuard.canActivate(guardContext(
    makePrincipal("operator"), ImportController.prototype.get, { params: { id: batchId } },
  ));
  let otherOwnerStatus = null;
  try {
    await permissionGuard.canActivate(guardContext(
      makePrincipal("operator", randomUUID()), ImportController.prototype.get, { params: { id: batchId } },
    ));
  } catch (error) { otherOwnerStatus = error?.getStatus?.() ?? null; }
  const reviewerTenantRead = await permissionGuard.canActivate(guardContext(
    makePrincipal("reviewer"), ImportController.prototype.get, { params: { id: batchId } },
  ));
  let reviewerWriteStatus = null;
  try {
    await permissionGuard.canActivate(guardContext(
      makePrincipal("reviewer", randomUUID()), ImportController.prototype.proposeRegonCorrection,
      { params: { id: batchId } },
    ));
  } catch (error) { reviewerWriteStatus = error?.getStatus?.() ?? null; }
  const crossTenantStatus = await permissionGuard.canActivate(guardContext(
    makePrincipal("reviewer", randomUUID(), randomUUID()), ImportController.prototype.get, { params: { id: batchId } },
  )).then(() => null).catch((error) => error?.getStatus?.() ?? null);
  if (!operatorOwnBatch || otherOwnerStatus !== 404 || !reviewerTenantRead
    || reviewerWriteStatus !== 403 || crossTenantStatus !== 404) {
    throw new Error(`USER_MIGRATION_BATCH_SCOPE_GUARD_MISMATCH ${JSON.stringify({ operatorOwnBatch, otherOwnerStatus, reviewerTenantRead, reviewerWriteStatus, crossTenantStatus })}`);
  }
  if (seeded) {
    const operatorOwnRun = await permissionGuard.canActivate(guardContext(
      makePrincipal("operator"), RunController.prototype.get, { params: { id: seeded.runId } },
    ));
    const { AuthChallengeController } = require("../dist/features/interventions/auth-challenge.controller");
    const operatorOwnSmsRun = await permissionGuard.canActivate(guardContext(
      makePrincipal("operator"), AuthChallengeController.prototype.submitCode,
      { body: { runId: seeded.runId, code: "synthetic-only" } },
    ));
    const anotherOwnerSmsStatus = await permissionGuard.canActivate(guardContext(
      makePrincipal("operator", randomUUID()), AuthChallengeController.prototype.submitCode,
      { body: { runId: seeded.runId, code: "synthetic-only" } },
    )).then(() => null).catch((error) => error?.getStatus?.() ?? null);
    const missingSmsRunStatus = await permissionGuard.canActivate(guardContext(
      makePrincipal("operator"), AuthChallengeController.prototype.submitCode,
      { body: { runId: randomUUID(), code: "synthetic-only" } },
    )).then(() => null).catch((error) => error?.getStatus?.() ?? null);
    if (!operatorOwnRun || !operatorOwnSmsRun || anotherOwnerSmsStatus !== 404 || missingSmsRunStatus !== 404) {
      throw new Error("USER_MIGRATION_RUN_OR_SMS_BODY_SCOPE_GUARD_MISMATCH");
    }
  }

  let halfOwnershipRejected = false;
  try {
    await sequelize.query(
      "UPDATE import_batches SET owner_user_id = NULL WHERE id = $1",
      { bind: [batchId] },
    );
  } catch (error) {
    halfOwnershipRejected = error?.parent?.code === "23514" || error?.original?.code === "23514";
  }
  if (!halfOwnershipRejected) throw new Error("USER_MIGRATION_HALF_OWNERSHIP_ACCEPTED");

  const otherTenantId = randomUUID();
  await models.Tenant.create({
    tenantId: otherTenantId, slug: "synthetic-other", displayName: "Synthetic Other", createdAt: now,
  });
  let crossTenantOwnerRejected = false;
  try {
    await sequelize.query(
      "UPDATE import_batches SET tenant_id = $1, owner_user_id = $2 WHERE id = $3",
      { bind: [otherTenantId, user.userId, batchId] },
    );
  } catch (error) {
    crossTenantOwnerRejected = error?.parent?.code === "23503" || error?.original?.code === "23503";
  }
  if (!crossTenantOwnerRejected) throw new Error("USER_MIGRATION_CROSS_TENANT_OWNER_ACCEPTED");

  const forbiddenMetadata = [
    { result: [{ profile: { SMSCode: "synthetic-only" } }] },
    { source: { PESEL: "synthetic-only" } },
    { result: { contact: { Email: "synthetic@example.invalid" } } },
    { access_token: "synthetic-only" },
  ];
  const auditEventCountBeforeRejectedMetadata = await models.AuditEvent.count();
  for (const metadata of forbiddenMetadata) {
    let sensitiveMetadataRejected = false;
    try {
      await models.AuditEvent.create({
        eventId: randomUUID(), tenantId: tenant.tenantId, actorUserId: user.userId,
        action: "sms.submitted", resourceType: "challenge", resourceId: randomUUID(), outcome: "succeeded",
        requestRef: null, metadata, createdAt: now,
      });
    } catch (error) {
      sensitiveMetadataRejected = checkViolation(error);
    }
    if (!sensitiveMetadataRejected) throw new Error("USER_MIGRATION_AUDIT_SENSITIVE_KEY_ACCEPTED");
  }
  if ((await models.AuditEvent.count()) !== auditEventCountBeforeRejectedMetadata) {
    throw new Error("USER_MIGRATION_AUDIT_SECRET_GUARD_MISMATCH");
  }
  const auditActions = [
    ["import.created", "import", randomUUID(), "succeeded"],
    ["run.created", "run", randomUUID(), "succeeded"],
    ["run.cancelled", "run", randomUUID(), "succeeded"],
    ["sms.submitted", "run", randomUUID(), "failed"],
    ["regon.correction.proposed", "correction", randomUUID(), "succeeded"],
    ["artifact.downloaded", "artifact", randomUUID(), "succeeded"],
  ];
  for (const [action, resourceType, resourceId, outcome] of auditActions) {
    await recordAuditEvent({
      tenantId: tenant.tenantId, actorUserId: user.userId, action,
      resourceType, resourceId, outcome,
    });
  }
  const savedEvents = await models.AuditEvent.findAll({
    where: { actorUserId: user.userId }, order: [["createdAt", "ASC"], ["eventId", "ASC"]],
  });
  const expectedAuditResourceIds = new Set(auditActions.map(([, , resourceId]) => resourceId));
  const recordedSmokeEvents = savedEvents.filter((item) => expectedAuditResourceIds.has(item.resourceId));
  if (recordedSmokeEvents.length !== auditActions.length
    || auditActions.some(([action, , resourceId]) => !recordedSmokeEvents.some((item) => item.action === action && item.resourceId === resourceId))
    || recordedSmokeEvents.some((item) => item.tenantId !== tenant.tenantId || item.outcome === "" || Object.keys(item.metadata).length !== 0)) {
    throw new Error("USER_MIGRATION_AUDIT_ACTION_MAPPING_MISMATCH");
  }
  const beforeRollback = await models.AuditEvent.count();
  try {
    await models.sequelize.transaction(async (transaction) => {
      await recordAuditEvent({
        tenantId: tenant.tenantId, actorUserId: user.userId, action: "run.created",
        resourceType: "run", resourceId: randomUUID(), outcome: "succeeded",
      }, transaction);
      throw new Error("synthetic audit rollback");
    });
  } catch (error) {
    if (error?.message !== "synthetic audit rollback") throw error;
  }
  if ((await models.AuditEvent.count()) !== beforeRollback) throw new Error("USER_MIGRATION_AUDIT_TRANSACTION_NOT_ROLLED_BACK");

  if (seeded) {
    smokeStage = "sms_body_run_http_real_guards";
    const { Module } = require("@nestjs/common");
    const { NestFactory } = require("@nestjs/core");
    const { AuthChallengeController } = require("../dist/features/interventions/auth-challenge.controller");
    const { AuthChallengeService } = require("../dist/features/interventions/auth-challenge.service");
    const { SESSION_ROLE_RESOLVER, SessionGuard, resolveActiveSessionRole } = require("../dist/features/auth/index");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard, resolvePermissionResource } = require("../dist/features/authorization/index");
    const challengeId = randomUUID();
    const mfaCycleId = randomUUID();
    const challengeNow = new Date();
    const browserSessionId = randomUUID();
    const accountKey = createHmac("sha256", "synthetic-account-key-for-scope-test").update(randomUUID()).digest("hex");
    await models.AutomationRun.update({ status: "pzu_login", currentStep: "pzu_login", errorCode: null, finishedAt: null,
      startedByUserId: user.userId }, {
      where: { id: seeded.runId },
    });
    await models.AuthChallenge.create({
      challengeId, runId: seeded.runId, portal: "pzu", accountKey, browserSessionId,
      returnStep: "pzu_login", status: "active", attemptCount: 0, attemptLimit: 5,
      expiresAt: new Date(challengeNow.getTime() + 60_000), claimedAt: null, consumedAt: null,
      createdAt: challengeNow, updatedAt: challengeNow, mfaCycleId,
    });
    await models.ManualIntervention.create({
      interventionId: randomUUID(), runId: seeded.runId, challengeId, portal: "pzu", kind: "sms",
      status: "open", reasonCode: "SMS_REQUIRED", createdAt: challengeNow, resolvedAt: null, resolvedBy: null,
    });
    await models.AutomationRun.update({ status: "waiting_for_sms", currentStep: "waiting_for_sms",
      currentAuthChallengeId: challengeId, authCycleId: mfaCycleId, authCyclePortal: "pzu",
      authCycleStartedAt: challengeNow, authCycleExpiresAt: new Date(challengeNow.getTime() + 60_000) }, {
      where: { id: seeded.runId },
    });

    const previousSessionSecretForHttp = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "synthetic-session-secret-for-body-run-http-scope";
    const deliveredChallengeIds = [];
    const service = new AuthChallengeService({
      async deliver(receivedChallengeId, code) {
        if (code !== "654321") throw new Error("SYNTHETIC_HTTP_CODE_MISMATCH");
        deliveredChallengeIds.push(receivedChallengeId);
      },
      async invalidate() {},
    });
    class SmsBodyRunHttpSmokeModule {}
    Module({
      controllers: [AuthChallengeController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: SESSION_ROLE_RESOLVER, useValue: resolveActiveSessionRole },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: resolvePermissionResource },
        { provide: AuthChallengeService, useValue: service },
      ],
    })(SmsBodyRunHttpSmokeModule);

    let httpApp;
    try {
      httpApp = await NestFactory.create(SmsBodyRunHttpSmokeModule, { logger: false });
      httpApp.setGlobalPrefix("api");
      await httpApp.listen(0, "127.0.0.1");
      const address = httpApp.getHttpServer().address();
      const endpoint = `http://127.0.0.1:${address.port}/api/auth-challenges/${challengeId}/code`;
      const csrf = "synthetic-csrf-token-for-body-run-http-test-0123456789";
      const payload = Buffer.from(JSON.stringify({
        exp: Date.now() + 60_000, userId: user.userId, tenantId: tenant.tenantId, csrf,
      })).toString("base64url");
      const signature = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
      const cookie = `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
      const postCode = (body, headers = {}) => fetch(endpoint, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, ...headers },
        body: JSON.stringify(body),
      });

      const missingSession = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: seeded.runId, code: "654321" }),
      });
      const badCsrf = await postCode({ runId: seeded.runId, code: "654321" }, { "x-csrf-token": "wrong" });
      const missingRun = await postCode({ runId: randomUUID(), code: "654321" });
      const accepted = await postCode({ runId: seeded.runId, code: "654321" });
      const duplicate = await postCode({ runId: seeded.runId, code: "654321" });
      const challenge = await models.AuthChallenge.findByPk(challengeId);
      const finalRun = await models.AutomationRun.findByPk(seeded.runId);
      if (missingSession.status !== 401 || badCsrf.status !== 403 || missingRun.status !== 404
        || accepted.status !== 202 || duplicate.status !== 409 || deliveredChallengeIds.length !== 1
        || challenge?.status !== "submitted" || challenge?.attemptCount !== 1 || finalRun?.status !== "waiting_for_sms") {
        throw new Error(`SMS_BODY_RUN_HTTP_GUARD_OR_SUBMISSION_MISMATCH:${missingSession.status}:${badCsrf.status}:${missingRun.status}:${accepted.status}:${duplicate.status}:${deliveredChallengeIds.length}:${challenge?.status ?? "missing"}:${challenge?.attemptCount ?? "missing"}:${finalRun?.status ?? "missing"}`);
      }
      console.log("SMS_BODY_RUN_HTTP_SMOKE_PASS guards=real session=401 csrf=403 missingRun=404 accepted=202 duplicate=409 forwarding=once code=not-persisted");
    } finally {
      await httpApp?.close();
      if (previousSessionSecretForHttp === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSessionSecretForHttp;
    }
  }
  const outboxColumns = await models.sequelize.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='run_dispatch_outbox'`,
  );
  const runLeaseColumns = await models.sequelize.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='automation_runs'
     AND column_name IN ('execution_id','worker_session_id','lease_expires_at','technical_cycle_id','technical_attempt_count','staging_file_id','staging_sha256','staging_key_version','staging_format_version')`,
  );
  if (outboxColumns[0].length !== 11 || runLeaseColumns[0].length !== 9) {
    throw new Error("USER_MIGRATION_OUTBOX_OR_LEASE_COLUMNS_MISSING");
  }
  if (queuedSeed) {
    const queuedDispatch = await models.RunDispatchOutbox.findOne({ where: { runId: queuedSeed.runId } });
    if (!queuedDispatch || queuedDispatch.intentType !== "create" || queuedDispatch.status !== "pending"
      || queuedDispatch.attemptCount !== 0 || JSON.stringify(queuedDispatch.toJSON()).includes("654321")) {
      throw new Error("USER_MIGRATION_QUEUED_RUN_OUTBOX_BACKFILL_MISMATCH");
    }
  }
  console.log(`USER_SCHEMA_SMOKE_PASS migration=${latestMigration} existingBatchAdoptedByBootstrap=${Boolean(seeded)} bootstrapIdempotent=true ownershipPair=true membership=valid managerMembership=true managerGrantCapabilityMatrix=9/9 managerActiveSessionRoleChange=true managerMembershipDisableRevokesSession=true managerNoUserAdmin=true crossTenantOwner=blocked toolGrantBackfill=${Boolean(legacyGrantUsers)} newUserNoGrant=true dbLogin=valid sessionRegistry=true sessionRevoke=true temporaryPasswordGate=true roleFromMembership=true disabledPrincipal=blocked audit=nestedSensitiveMetadata=blocked actionRows=${savedEvents.length} transactionRollback=true outbox=queued-backfilled:${Boolean(queuedSeed)} lease=empty staging=metadata-only`);
}

async function verifyAccountRecoveryFlow() {
  smokeStage = "account_recovery";
  const models = require("../dist/infrastructure/database/db");
  const { PasswordRecoveryService } = require("../dist/features/account-recovery/index");
  const { AuthMailDispatcher } = require("../dist/features/account-recovery/auth-mail-dispatcher");
  const { hashPassword, verifyPassword } = require("../dist/features/auth/index");
  const { randomBytes } = require("node:crypto");
  const { QueryTypes } = require("sequelize");
  const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
  if (!tenant) throw new Error("RECOVERY_SMOKE_TENANT_MISSING");

  const envNames = ["GOLDIS_PASSWORD_RECOVERY_ENABLED", "GOLDIS_EMAIL_PROVIDER", "PUBLIC_APP_ORIGIN",
    "GOLDIS_EMAIL_FROM", "GOLDIS_EMAIL_REPLY_TO", "RESEND_API_KEY", "AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION",
    "AUTH_MAIL_ENCRYPTION_KEYS_BASE64", "LOGIN_RATE_LIMIT_SECRET"];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED = "1";
  process.env.GOLDIS_EMAIL_PROVIDER = "resend";
  process.env.PUBLIC_APP_ORIGIN = "https://goldis.test";
  process.env.GOLDIS_EMAIL_FROM = "Goldis <noreply@goldis.test>";
  process.env.GOLDIS_EMAIL_REPLY_TO = "support@goldis.test";
  process.env.RESEND_API_KEY = `re_${"x".repeat(24)}`;
  process.env.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
  process.env.AUTH_MAIL_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({
    "1": randomBytes(32).toString("base64"),
  })).toString("base64");
  process.env.LOGIN_RATE_LIMIT_SECRET = "synthetic-recovery-rate-limit-secret-0123456789";

  try {
    const now = new Date();
    const userId = randomUUID();
    const sessionId = randomUUID();
    const password = "Synthetic recovery original password!";
    const username = `Synthetic.Recovery.${userId.slice(0, 8)}`;
    await models.User.create({ userId, username, usernameNormalized: username.toLowerCase(),
      passwordHash: await hashPassword(password), status: "active", createdAt: now, updatedAt: now,
      lastLoginAt: null, mustChangePassword: false, credentialRevision: 1 });
    await models.TenantMembership.create({ tenantId: tenant.tenantId, userId, role: "operator", status: "active",
      createdAt: now, updatedAt: now });
    await models.UserSession.create({ sessionId, tenantId: tenant.tenantId, userId, credentialRevision: 1,
      createdAt: now, lastSeenAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000),
      revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic recovery smoke" });

    const rateLimiter = {
      consumeRecoveryRequest: async () => ({ kind: "queue", retryAfterSeconds: 0, limitedBy: null }),
      consumeRecoveryTokenAttempt: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      consumeReauthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0, generation: "synthetic" }),
      consumeAuthMailSendBudget: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      clearReauth: async () => undefined,
      recordReauthFailure: async () => undefined,
    };
    const sentMessages = [];
    const dispatcher = new AuthMailDispatcher({
      send: async (message) => {
        sentMessages.push(message);
        return { kind: "submitted", providerMessageId: `synthetic-resend-${sentMessages.length}` };
      },
    }, rateLimiter);
    const dispatchUntilSubmitted = async (mailId) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await models.AuthMailOutbox.findByPk(mailId);
        if (current?.status === "submitted") return sentMessages.find((message) => message.idempotencyKey === `goldis-auth-mail/${mailId}`);
        if (!await dispatcher.dispatchOne()) break;
      }
      const current = await models.AuthMailOutbox.findByPk(mailId);
      if (current?.status !== "submitted") throw new Error("RECOVERY_SMOKE_MAIL_DISPATCH_FAILED");
      return sentMessages.find((message) => message.idempotencyKey === `goldis-auth-mail/${mailId}`);
    };
    const { AccountRecoveryRepository } = require("../dist/features/account-recovery/account-recovery.repository");
    const service = new PasswordRecoveryService(rateLimiter, createAuditService(), new AccountRecoveryRepository(models.sequelize));
    await service.setRecoveryEmail({ userId, tenantId: tenant.tenantId, sessionId,
      currentPassword: password, email: "recovery.user@goldis.test" }, "127.0.0.1");

    const verificationMail = await models.AuthMailOutbox.findOne({ where: { userId, purpose: "email_verify", status: "pending" } });
    if (!verificationMail?.payloadCiphertext || !verificationMail.payloadNonce || !verificationMail.payloadAuthTag) {
      throw new Error("RECOVERY_SMOKE_VERIFICATION_MAIL_MISSING");
    }
    const unverifiedOutboxCount = await models.AuthMailOutbox.count({ where: { userId } });
    await service.requestPasswordReset("recovery.user@goldis.test", "127.0.0.1");
    if ((await models.AuthMailOutbox.count({ where: { userId } })) !== unverifiedOutboxCount) {
      throw new Error("RECOVERY_SMOKE_UNVERIFIED_ADDRESS_RECEIVED_RESET_MAIL");
    }
    const verificationMessage = await dispatchUntilSubmitted(verificationMail.mailId);
    const verificationToken = /#token=([A-Za-z0-9_-]{43})/.exec(verificationMessage?.text ?? "")?.[1];
    if (!verificationToken || verificationMessage?.to !== "recovery.user@goldis.test"
      || verificationMessage?.idempotencyKey !== `goldis-auth-mail/${verificationMail.mailId}`) {
      throw new Error("RECOVERY_SMOKE_VERIFICATION_CONTENT_INVALID");
    }
    const submittedVerification = await models.AuthMailOutbox.findByPk(verificationMail.mailId);
    if (submittedVerification?.payloadCiphertext || submittedVerification?.payloadNonce || submittedVerification?.payloadAuthTag) {
      throw new Error("RECOVERY_SMOKE_SUBMITTED_PAYLOAD_NOT_CLEARED");
    }
    await service.verifyRecoveryEmail(verificationToken, "127.0.0.1");
    const profile = await models.sequelize.query(
      `SELECT recovery_email AS email, recovery_email_normalized AS normalized, recovery_email_verified_at AS "verifiedAt",
              pending_recovery_email AS pending FROM users WHERE user_id = :userId`,
      { replacements: { userId }, type: QueryTypes.SELECT },
    );
    if (profile[0]?.email !== "recovery.user@goldis.test" || profile[0]?.normalized !== "recovery.user@goldis.test"
      || !profile[0]?.verifiedAt || profile[0]?.pending !== null) throw new Error("RECOVERY_SMOKE_EMAIL_VERIFICATION_FAILED");

    const outboxCount = await models.AuthMailOutbox.count({ where: { userId } });
    const knownResponse = await service.requestPasswordReset("RECOVERY.USER@goldis.test", "127.0.0.1");
    const unknownResponse = await service.requestPasswordReset("missing.user@goldis.test", "127.0.0.1");
    if (JSON.stringify(knownResponse) !== JSON.stringify(unknownResponse)
      || (await models.AuthMailOutbox.count({ where: { userId } })) !== outboxCount + 1) {
      throw new Error("RECOVERY_SMOKE_PUBLIC_RESPONSE_OR_ENUMERATION_MISMATCH");
    }
    const resetMail = await models.AuthMailOutbox.findOne({ where: { userId, purpose: "password_reset", status: "pending" } });
    if (!resetMail?.payloadCiphertext || !resetMail.payloadNonce || !resetMail.payloadAuthTag) throw new Error("RECOVERY_SMOKE_RESET_MAIL_MISSING");
    const resetMessage = await dispatchUntilSubmitted(resetMail.mailId);
    const resetToken = /#token=([A-Za-z0-9_-]{43})/.exec(resetMessage?.text ?? "")?.[1];
    if (!resetToken || resetMessage?.to !== "recovery.user@goldis.test"
      || resetMessage?.idempotencyKey !== `goldis-auth-mail/${resetMail.mailId}`
      || resetMail.payloadCiphertext.includes(Buffer.from(resetToken))) throw new Error("RECOVERY_SMOKE_RESET_CONTENT_INVALID");
    const changedPassword = "Synthetic recovery replacement password!";
    const concurrentResets = await Promise.allSettled([
      service.resetPassword(resetToken, changedPassword, "127.0.0.1"),
      service.resetPassword(resetToken, changedPassword, "127.0.0.1"),
    ]);
    if (concurrentResets.filter((result) => result.status === "fulfilled").length !== 1
      || concurrentResets.filter((result) => result.status === "rejected").length !== 1
      || concurrentResets.some((result) => result.status === "rejected" && result.reason?.getStatus?.() !== 409)) {
      throw new Error("RECOVERY_SMOKE_CONCURRENT_RESET_NOT_SINGLE_USE");
    }
    const updatedUser = await models.User.findByPk(userId);
    const updatedSession = await models.UserSession.findByPk(sessionId);
    const { hashRecoveryToken } = require("../dist/features/account-recovery/account-recovery-tokens");
    const token = await models.AccountRecoveryToken.findOne({ where: { tokenHash: hashRecoveryToken(resetToken) } });
    if (!updatedUser || !await verifyPassword(changedPassword, updatedUser.passwordHash)
      || await verifyPassword(password, updatedUser.passwordHash) || updatedUser.credentialRevision !== 2
      || !updatedSession?.revokedAt || updatedSession.revokeReason !== "password_change" || !token?.consumedAt) {
      throw new Error("RECOVERY_SMOKE_PASSWORD_RESET_OR_SESSION_REVOCATION_FAILED");
    }
    let replayRejected = false;
    try { await service.resetPassword(resetToken, "Synthetic replay replacement password!", "127.0.0.1"); }
    catch (error) { replayRejected = error?.getStatus?.() === 409; }
    if (!replayRejected) throw new Error("RECOVERY_SMOKE_TOKEN_REPLAY_ACCEPTED");
    if (!(await models.AuthMailOutbox.findOne({ where: { userId, purpose: "password_changed_notice", status: "pending" } }))) {
      throw new Error("RECOVERY_SMOKE_PASSWORD_CHANGE_NOTICE_MISSING");
    }
    console.log("ACCOUNT_RECOVERY_DB_SMOKE_PASS unverifiedSuppressed=true emailVerification=true genericResponse=true encryptedOutbox=true dispatcher=true idempotency=true singleUseToken=true concurrentReset=true credentialRevision=true sessionsRevoked=true");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function verifyOperationalSettingsAndRunControls() {
  smokeStage = "operational_settings_http_and_run_controls";
  const models = require("../dist/infrastructure/database/db");
  const { AdminToolsController } = require("../dist/features/admin/admin-tools.controller");
  const { AdminToolsRepository } = require("../dist/features/admin/admin-tools.repository");
  const { AdminToolsService } = require("../dist/features/admin/admin-tools.service");
  const { AdminMutationsService } = require("../dist/features/admin/admin-mutations.service");
  const { AdminMutationsRepository } = require("../dist/features/admin/admin-mutations.repository");
  const { API_DATABASE } = require("../dist/infrastructure/database");
  const { AuditRepository } = require("../dist/features/audit/audit.repository");
  const { AuditService } = require("../dist/features/audit/audit.service");
  const { AdminOnlyGuard } = require("../dist/features/admin/admin.support");
  const {
    SESSION_ROLE_RESOLVER, SESSION_PASSWORD_CHANGE_RESOLVER,
    SessionGuard, resolveCurrentSessionRole, resolveMustChangePassword,
  } = require("../dist/features/auth/index");
  const { EntityGroupingService } = require("../dist/features/grouping/grouping.service");
  const { CanonicalRunService, createLeadIdentityKey } = require("../dist/features/runs/canonical-run-service");
  const { Module } = require("@nestjs/common");
  const { NestFactory } = require("@nestjs/core");
  const admin = await models.User.findOne({ where: { usernameNormalized: "synthetic.bootstrap.admin" } });
  const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
  if (!admin || !tenant) throw new Error("SETTINGS_SMOKE_ADMIN_OR_TENANT_MISSING");

  const secretBefore = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "synthetic-settings-http-session-secret-long-enough";
  const csrf = "synthetic-settings-csrf-token-0123456789abcdef";
  const sessionId = randomUUID();
  const createdAt = new Date();
  await models.UserSession.create({
    sessionId, tenantId: tenant.tenantId, userId: admin.userId, createdAt,
    lastSeenAt: createdAt, lastActivityAt: createdAt, expiresAt: new Date(createdAt.getTime() + 5 * 60_000),
    revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic smoke",
  });
  const payload = Buffer.from(JSON.stringify({
    v: 2, sessionId, exp: Date.now() + 5 * 60_000,
    userId: admin.userId, tenantId: tenant.tenantId, csrf,
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
  const cookie = `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
  class OperationalSettingsSmokeModule {}
  Module({
    controllers: [AdminToolsController],
    providers: [
      SessionGuard, AdminOnlyGuard,
      { provide: API_DATABASE, useValue: models.sequelize },
      AdminToolsRepository,
      AdminMutationsRepository,
      AdminMutationsService,
      AdminToolsService,
      { provide: AuditService, useValue: new AuditService(new AuditRepository()) },
      { provide: SESSION_ROLE_RESOLVER, useValue: resolveCurrentSessionRole },
      { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: resolveMustChangePassword },
    ],
  })(OperationalSettingsSmokeModule);

  let app;
  try {
    app = await NestFactory.create(OperationalSettingsSmokeModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    const endpoint = `http://127.0.0.1:${address.port}/api/admin/tools/oc-policy-verification/settings`;
    const readSettings = async () => {
      const response = await fetch(endpoint, { headers: { cookie } });
      return { response, body: await response.json() };
    };
    const patchSettings = async (body, includeCsrf = true) => {
      const headers = { cookie, "content-type": "application/json" };
      if (includeCsrf) headers["x-csrf-token"] = csrf;
      return fetch(endpoint, { method: "PATCH", headers, body: JSON.stringify(body) });
    };
    const { response: initialResponse, body: initial } = await readSettings();
    const allowedResponseKeys = ["allowedLocalEnd", "allowedLocalStart", "enabledForNewRuns", "maxNewRunsPerHour", "timezone", "toolId", "updatedAt", "version"];
    if (initialResponse.status !== 200 || initial.version !== 1 || initial.enabledForNewRuns !== true
      || JSON.stringify(Object.keys(initial).sort()) !== JSON.stringify(allowedResponseKeys)) {
      throw new Error("SETTINGS_HTTP_READ_OR_SAFE_SHAPE_MISMATCH");
    }
    const operator = await models.User.findOne({ where: { usernameNormalized: "synthetic.operator" } });
    if (!operator) throw new Error("SETTINGS_SMOKE_OPERATOR_MISSING");
    const operatorSessionId = randomUUID();
    const operatorSessionAt = new Date();
    await models.UserSession.create({
      sessionId: operatorSessionId, tenantId: tenant.tenantId, userId: operator.userId,
      createdAt: operatorSessionAt, lastSeenAt: operatorSessionAt, lastActivityAt: operatorSessionAt,
      expiresAt: new Date(operatorSessionAt.getTime() + 5 * 60_000), revokedAt: null,
      revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic operator smoke",
    });
    const operatorPayload = Buffer.from(JSON.stringify({
      v: 2, sessionId: operatorSessionId, exp: Date.now() + 5 * 60_000,
      userId: operator.userId, tenantId: tenant.tenantId, csrf,
    })).toString("base64url");
    const operatorSignature = createHmac("sha256", process.env.SESSION_SECRET).update(operatorPayload).digest("base64url");
    const operatorCookie = `goldis_session=${operatorPayload}.${operatorSignature}; goldis_csrf=${csrf}`;
    const operatorRead = await fetch(endpoint, { headers: { cookie: operatorCookie } });
    if (operatorRead.status !== 403) throw new Error("SETTINGS_HTTP_OPERATOR_SCOPE_NOT_ENFORCED");
    const pausedBody = {
      enabledForNewRuns: false, maxNewRunsPerHour: null, allowedLocalStart: null,
      allowedLocalEnd: null, timezone: "Europe/Warsaw", expectedVersion: 1,
    };
    const missingCsrf = await patchSettings(pausedBody, false);
    if (missingCsrf.status !== 403) throw new Error("SETTINGS_HTTP_CSRF_NOT_ENFORCED");
    const concurrent = await Promise.all([patchSettings(pausedBody), patchSettings(pausedBody)]);
    const concurrentStatuses = concurrent.map((response) => response.status).sort((a, b) => a - b);
    if (JSON.stringify(concurrentStatuses) !== JSON.stringify([200, 409])) {
      throw new Error("SETTINGS_HTTP_CONCURRENT_CAS_MISMATCH");
    }
    const unknownField = await patchSettings({ ...pausedBody, pzuPassword: "synthetic" });
    const halfWindow = await patchSettings({ ...pausedBody, expectedVersion: 2, allowedLocalEnd: "18:00" });
    const invalidZone = await patchSettings({ ...pausedBody, expectedVersion: 2, timezone: "Synthetic/Unknown" });
    const stale = await patchSettings(pausedBody);
    const auditsAfterInvalid = await models.AuditEvent.count({
      where: { tenantId: tenant.tenantId, actorUserId: admin.userId, action: "settings.updated", resourceId: "oc-policy-verification" },
    });
    if (unknownField.status !== 400 || halfWindow.status !== 400 || invalidZone.status !== 400
      || stale.status !== 409 || auditsAfterInvalid !== 1) {
      throw new Error("SETTINGS_HTTP_VALIDATION_OR_CAS_AUDIT_MISMATCH");
    }

    const batchId = randomUUID();
    await sequelize.query(
      `INSERT INTO import_batches (id, file_name, sha256, total_rows, invalid_rows, created_at, tenant_id, owner_user_id, tool_id)
       VALUES ($1, 'synthetic-settings.xlsx', repeat('b', 64), 2, 0, now(), $2, $3, 'oc-policy-verification')`,
      { bind: [batchId, tenant.tenantId, admin.userId] },
    );
    for (const [rowNumber, decisionMaker] of [[18001, "Synthetic First Lead"], [18002, "Synthetic Second Lead"]]) {
      await sequelize.query(
        `INSERT INTO source_rows (id, batch_id, row_number, company_name, decision_maker_name, nip_raw, address,
           postal_code, city, regon_raw, regon, effective_regon, row_version, issues)
         VALUES ($1, $2, $3, 'Synthetic Settings Company', $4, '5260250995', 'Test 2', '00-000',
           'Test City', '012345678', '012345678', '012345678', 1, '[]'::jsonb)`,
        { bind: [randomUUID(), batchId, rowNumber, decisionMaker] },
      );
    }
    const grouping = new EntityGroupingService();
    const canonicalRuns = new CanonicalRunService();
    const actor = { tenantId: tenant.tenantId, actorUserId: admin.userId };
    const dispatchFor = async (run, transaction) => {
      const existing = await models.RunDispatchOutbox.findOne({
        where: { runId: run.id, status: ["pending", "publishing", "published"] },
        transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!existing) {
        await models.RunDispatchOutbox.create({
          dispatchId: randomUUID(), runId: run.id, intentType: "create", status: "pending",
          attemptCount: 0, nextAttemptAt: new Date(), claimedAt: null, claimedBy: null,
          lastErrorCode: null, createdAt: new Date(), updatedAt: new Date(),
        }, { transaction });
      }
    };
    const prepareRun = async (rowNumber) => {
      const outcomes = await grouping.resolveRelatedRows(batchId, rowNumber);
      const selected = outcomes.find((item) => item.rowNumber === rowNumber);
      if (selected?.status !== "linked") throw new Error("SETTINGS_SMOKE_SOURCE_GROUP_NOT_LINKED");
      const linkedIds = outcomes.filter((item) => item.status === "linked"
        && item.canonicalEntityId === selected.canonicalEntityId).map((item) => item.sourceRowId);
      const rows = await models.SourceRow.findAll({ where: { id: linkedIds, batchId }, order: [["rowNumber", "ASC"]] });
      const selectedRow = rows.find((row) => row.rowNumber === rowNumber);
      if (!selectedRow) throw new Error("SETTINGS_SMOKE_SOURCE_ROW_MISSING");
      const leadIdentityKey = createLeadIdentityKey(selected.canonicalEntityId, selectedRow.decisionMakerName);
      const members = rows.filter((row) => createLeadIdentityKey(selected.canonicalEntityId, row.decisionMakerName) === leadIdentityKey);
      return canonicalRuns.createOrGet(batchId, selected.canonicalEntityId, leadIdentityKey, members, actor, dispatchFor);
    };
    const pausedRunStatus = await prepareRun(18001).then(() => null).catch((error) => error?.getStatus?.() ?? null);
    if (pausedRunStatus !== 409 || (await models.AutomationRun.count({ where: { batchId } })) !== 0) {
      throw new Error("SETTINGS_PAUSE_DID_NOT_BLOCK_NEW_RUN");
    }

    const nowParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Warsaw", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const futureStartHour = (Number(nowParts.hour) + 3) % 24;
    const futureEndHour = (futureStartHour + 1) % 24;
    const futureWindow = {
      enabledForNewRuns: true, maxNewRunsPerHour: 3,
      allowedLocalStart: `${String(futureStartHour).padStart(2, "0")}:00`,
      allowedLocalEnd: `${String(futureEndHour).padStart(2, "0")}:00`,
      timezone: "Europe/Warsaw", expectedVersion: 2,
    };
    if ((await patchSettings(futureWindow)).status !== 200) throw new Error("SETTINGS_WINDOW_UPDATE_FAILED");
    const outsideWindowStatus = await prepareRun(18001).then(() => null).catch((error) => error?.getStatus?.() ?? null);
    if (outsideWindowStatus !== 409 || (await models.AutomationRun.count({ where: { batchId } })) !== 0) {
      throw new Error("SETTINGS_WINDOW_DID_NOT_BLOCK_NEW_RUN");
    }

    const clearWindowResponse = await patchSettings({
      enabledForNewRuns: true, maxNewRunsPerHour: 3, allowedLocalStart: null,
      allowedLocalEnd: null, timezone: "Europe/Warsaw", expectedVersion: 3,
    });
    if (clearWindowResponse.status !== 200) throw new Error("SETTINGS_CLEAR_WINDOW_FAILED");
    const firstRun = await prepareRun(18001);
    if (firstRun.status !== "queued") throw new Error("SETTINGS_ALLOWED_RUN_NOT_QUEUED");
    const rateLimitedStatus = await prepareRun(18002).then(() => null).catch((error) => error?.getStatus?.() ?? null);
    if (rateLimitedStatus !== 429) throw new Error("SETTINGS_HOURLY_LIMIT_DID_NOT_BLOCK_NEW_RUN");

    const pauseAgain = await patchSettings({
      enabledForNewRuns: false, maxNewRunsPerHour: 3, allowedLocalStart: null,
      allowedLocalEnd: null, timezone: "Europe/Warsaw", expectedVersion: 4,
    });
    if (pauseAgain.status !== 200) throw new Error("SETTINGS_FINAL_PAUSE_FAILED");
    const retriedExisting = await prepareRun(18001);
    const outboxCount = await models.RunDispatchOutbox.count({ where: { runId: firstRun.id } });
    const newRunCount = await models.AutomationRun.count({ where: { batchId } });
    const finalSettings = await models.ToolSettings.findOne({ where: { tenantId: tenant.tenantId, toolId: "oc-policy-verification" } });
    const auditCount = await models.AuditEvent.count({
      where: { tenantId: tenant.tenantId, actorUserId: admin.userId, action: "settings.updated", resourceId: "oc-policy-verification" },
    });
    const runAuditCount = await models.AuditEvent.count({
      where: { tenantId: tenant.tenantId, actorUserId: admin.userId, action: "run.created", resourceId: firstRun.id },
    });
    if (retriedExisting.id !== firstRun.id || outboxCount !== 1 || newRunCount !== 1
      || finalSettings?.enabledForNewRuns !== false || finalSettings?.version !== 5 || auditCount !== 4 || runAuditCount !== 1) {
      throw new Error("SETTINGS_PAUSE_RETRY_OUTBOX_OR_AUDIT_MISMATCH");
    }
    console.log("OPERATIONS_SETTINGS_DB_HTTP_SMOKE_PASS adminAuth=true operatorDenied=403 csrf=true safeShape=true casConcurrent=200,409 invalidInputNoMutation=true pause=409 window=409 hourlyLimit=429 accepted=queued pausedRetry=existingOutboxIdempotent auditAtomic=true");
  } finally {
    await app?.close();
    if (secretBefore === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = secretBefore;
  }
}

async function verifyRunExport() {
  const { persistOcSnapshot } = require("../dist/features/results/oc-snapshot.repository");
  const { evaluateStoredSnapshot } = require("../dist/features/results/run-evaluation.repository");
  const { exportRunWorkbook, RunExportError } = require("../dist/features/results/run-export");
  const ExcelJS = require("exceljs");
  const models = require("../dist/infrastructure/database/db");
  const key = Buffer.alloc(32, 5).toString("base64");
  const environment = {
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": key }), "utf8").toString("base64"),
  };
  process.env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = environment.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION;
  process.env.PESEL_ENCRYPTION_KEYS_BASE64 = environment.PESEL_ENCRYPTION_KEYS_BASE64;
  const run = await seedLegacyRun("reading_oc", "2026-09-30", "Synthetic Decision Maker");
  const identity = {
    schemaVersion: 1,
    sourceRowId: run.sourceRowId,
    regon: "012345678",
    companyName: "Synthetic Company",
    firstName: "Synthetic",
    lastName: "Decision Maker",
    pesel: "90010100016",
    matchMethod: "regon_company_name_decision_maker",
    adapterVersion: "fixture-v1",
  };
  const policy = (ordinal, coverageTo) => ({
    sourceOrdinal: ordinal,
    insuredName: `Insured ${ordinal}`,
    policyTypeAndNumber: `OC EXPORT-${ordinal}`,
    contractType: "OC fixture",
    insuredClaimCount: ordinal - 1,
    vehicleRegistration: `TEST${ordinal}`,
    vehicleGroup: "Truck fixture",
    vehicleMake: "Make fixture",
    vehicleModel: `Model ${ordinal}`,
    insurer: "Insurer fixture",
    coverageFrom: "2025-02-03",
    coverageTo,
  });
  const policies = [policy(1, "2026-09-29"), policy(2, "2026-09-30"), policy(3, "2026-10-01")];
  const snapshot = {
    schemaVersion: 1,
    totalCount: policies.length,
    policies,
    capturedAt: "2026-09-30T11:00:00.000Z",
    parserVersion: "fixture-v1",
  };
  try {
    await persistOcSnapshot(run.runId, identity, snapshot, { environment });
    const outcome = await evaluateStoredSnapshot(run.runId);
    if (outcome.outcome !== "export_ready" || outcome.currentOcCount !== 2) throw new Error("RUN_EXPORT_NOT_READY");
    const exported = await exportRunWorkbook(run.runId);
    if (!exported || exported.policyCount !== 2
      || exported.fileName !== "012345678_Synthetic Company_Synthetic Decision Maker.xlsx") {
      throw new Error("RUN_EXPORT_METADATA_MISMATCH");
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.bytes);
    const sheet = workbook.getWorksheet("Polisy OC");
    if (!sheet || sheet.rowCount !== 3 || sheet.columnCount !== 15) throw new Error("RUN_EXPORT_LAYOUT_MISMATCH");
    const expectedRows = [policies[1], policies[2]];
    for (let index = 0; index < expectedRows.length; index += 1) {
      const row = sheet.getRow(index + 2);
      const policyRow = expectedRows[index];
      const expected = [
        "012345678", "Synthetic Company", "90010100016", policyRow.sourceOrdinal,
        policyRow.insuredName, policyRow.policyTypeAndNumber, policyRow.contractType,
        policyRow.insuredClaimCount, policyRow.vehicleRegistration, policyRow.vehicleGroup,
        policyRow.vehicleMake, policyRow.vehicleModel, policyRow.insurer, "2025-02-03", policyRow.coverageTo,
      ];
      for (let column = 1; column <= expected.length; column += 1) {
        if (row.getCell(column).value !== expected[column - 1]) {
          throw new Error(`RUN_EXPORT_COLUMN_MISMATCH_${column}`);
        }
      }
      if (row.getCell(14).numFmt !== "@" || row.getCell(15).numFmt !== "@") throw new Error("RUN_EXPORT_DATE_NOT_TEXT");
    }

    let stateRejected = false;
    const notReady = await seedLegacyRun("reading_oc");
    try {
      await exportRunWorkbook(notReady.runId);
    } catch (error) {
      stateRejected = error instanceof RunExportError && error.code === "RUN_NOT_EXPORT_READY";
    }
    if (!stateRejected) throw new Error("RUN_EXPORT_UNREADY_RUN_WAS_EXPORTED");
    console.log("RUN_EXPORT_SMOKE_PASS source=database columns=15 dateText=true personalFilename=true unready=blocked");
  } finally {
    await models.sequelize.close();
  }
}

async function verifyFinalizedExport() {
  const { persistOcSnapshot } = require("../dist/features/results/oc-snapshot.repository");
  const { evaluateStoredSnapshot } = require("../dist/features/results/run-evaluation.repository");
  const { exportRunWorkbook } = require("../dist/features/results/run-export");
  const { finalizeRunExport, ExportFinalizeError } = require("../dist/features/results/export-finalization.service");
  const { findOrphanedArtifacts } = require("../dist/features/results/public");
  const models = require("../dist/infrastructure/database/db");
  const key = Buffer.alloc(32, 4).toString("base64");
  process.env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
  process.env.PESEL_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({ "1": key }), "utf8").toString("base64");
  const environment = {
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: process.env.PESEL_ENCRYPTION_KEYS_BASE64,
  };
  const makePolicy = (ordinal) => ({
    sourceOrdinal: ordinal, insuredName: null, policyTypeAndNumber: `OC FINAL-${ordinal}`,
    contractType: "OC", insuredClaimCount: 0, vehicleRegistration: `TEST${ordinal}`,
    vehicleGroup: "Test vehicle", vehicleMake: "Synthetic", vehicleModel: `Model ${ordinal}`,
    insurer: "Synthetic insurer", coverageFrom: "2025-01-01", coverageTo: "2026-10-01",
  });
  const makeIdentity = (sourceRowId) => ({
    schemaVersion: 1, sourceRowId, regon: "012345678", companyName: "Synthetic Company",
    firstName: "Synthetic", lastName: "Decision Maker", pesel: "90010100016",
    matchMethod: "regon_company_name_decision_maker", adapterVersion: "fixture-v1",
  });
  const makeSnapshot = () => ({
    schemaVersion: 1, totalCount: 1, policies: [makePolicy(1)],
    capturedAt: "2026-09-30T12:00:00.000Z", parserVersion: "fixture-v1",
  });
  const roots = [];
  const newRoot = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "goldis-finalize-smoke-"));
    roots.push(root);
    return root;
  };
  try {
    const success = await seedLegacyRun("reading_oc", "2026-09-30", "Synthetic Decision Maker");
    await persistOcSnapshot(success.runId, makeIdentity(success.sourceRowId), makeSnapshot(), { environment });
    await evaluateStoredSnapshot(success.runId);
    const successRoot = await newRoot();
    let successExportCalls = 0;
    const successExporter = async (runId) => {
      successExportCalls += 1;
      return exportRunWorkbook(runId);
    };
    const completedArtifact = await finalizeRunExport(success.runId, { artifactRoot: successRoot, exportWorkbook: successExporter });
    const completedRetry = await finalizeRunExport(success.runId, { artifactRoot: successRoot, exportWorkbook: successExporter });
    const completedRun = await models.AutomationRun.findByPk(success.runId);
    const storedArtifact = await models.ExportArtifact.findByPk(completedArtifact.artifactId);
    const successFile = await readFile(path.join(successRoot, completedArtifact.storageKey));
    const successSha = createHash("sha256").update(successFile).digest("hex");
    if (completedRun.status !== "completed" || completedRun.errorCode !== null
      || completedArtifact.state !== "ready" || completedArtifact.policyCount !== 1
      || completedRetry.artifactId !== completedArtifact.artifactId || successExportCalls !== 1
      || !storedArtifact || storedArtifact.state !== "ready" || storedArtifact.sha256 !== successSha
      || successSha !== completedArtifact.sha256
      || (await findOrphanedArtifacts(successRoot, new Set([completedArtifact.storageKey]))).length !== 0) {
      throw new Error("EXPORT_FINALIZE_SUCCESS_OR_RETRY_MISMATCH");
    }

    const retry = await seedLegacyRun("reading_oc", "2026-09-30", "Synthetic Decision Maker");
    await persistOcSnapshot(retry.runId, makeIdentity(retry.sourceRowId), makeSnapshot(), { environment });
    await evaluateStoredSnapshot(retry.runId);
    const retryRoot = await newRoot();
    let failedAttemptCode = null;
    try {
      await finalizeRunExport(retry.runId, {
        artifactRoot: retryRoot,
        afterFilePublished: () => { throw new Error("SYNTHETIC_CRASH_AFTER_RENAME"); },
      });
    } catch (error) {
      failedAttemptCode = error instanceof ExportFinalizeError ? error.code : null;
    }
    const pendingRun = await models.AutomationRun.findByPk(retry.runId);
    const beforeRetryArtifactCount = await models.ExportArtifact.count({ where: { runId: retry.runId } });
    const orphanedBeforeRetry = await findOrphanedArtifacts(retryRoot, new Set());
    if (failedAttemptCode !== "EXPORT_FAILED" || pendingRun.status !== "export_ready"
      || pendingRun.errorCode !== "EXPORT_FAILED" || beforeRetryArtifactCount !== 0
      || orphanedBeforeRetry.length !== 1 || orphanedBeforeRetry[0].kind !== "published") {
      throw new Error("EXPORT_FINALIZE_FAILURE_DID_NOT_REMAIN_RETRYABLE");
    }

    let retryExportCalls = 0;
    const retryExporter = async (runId) => {
      retryExportCalls += 1;
      return exportRunWorkbook(runId);
    };
    const retriedArtifact = await finalizeRunExport(retry.runId, { artifactRoot: retryRoot, exportWorkbook: retryExporter });
    const retriedRun = await models.AutomationRun.findByPk(retry.runId);
    const persistedSnapshotCount = await models.OcPolicyRecord.count({ where: { runId: retry.runId } });
    const orphansAfterRetry = await findOrphanedArtifacts(retryRoot, new Set([retriedArtifact.storageKey]));
    if (retriedRun.status !== "completed" || retriedRun.errorCode !== null
      || retryExportCalls !== 1 || persistedSnapshotCount !== 1
      || await models.ExportArtifact.count({ where: { runId: retry.runId } }) !== 1
      || orphansAfterRetry.length !== 1 || orphansAfterRetry[0].storageKey !== orphanedBeforeRetry[0].storageKey) {
      throw new Error("EXPORT_FINALIZE_RETRY_REVISITED_PORTAL_OR_LOST_ORPHAN");
    }
    console.log("EXPORT_FINALIZE_SMOKE_PASS fileBeforeMetadata=true sha256=verified completedAfterReady=true retryExportOnly=true orphanDetected=true");
  } finally {
    await models.sequelize.close();
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
}

async function verifyArtifactDownload() {
  const { persistOcSnapshot } = require("../dist/features/results/oc-snapshot.repository");
  const { evaluateStoredSnapshot } = require("../dist/features/results/run-evaluation.repository");
  const { finalizeRunExport } = require("../dist/features/results/export-finalization.service");
  const { ArtifactDownloadError } = require("../dist/features/results/artifact-download.contract");
  const { ArtifactDownloadRepository } = require("../dist/features/results/artifact-download.repository");
  const { ArtifactDownloadService } = require("../dist/features/results/artifact-download.service");
  const getVerifiedArtifactDownload = (runId) => new ArtifactDownloadService(new ArtifactDownloadRepository()).download(runId);
  const { artifactDownloadHeaders } = require("../dist/features/results/artifact-download-headers");
  const { RunController } = require("../dist/features/runs/runs.controller");
  const { RunService } = require("../dist/features/runs/runs.service");
  const { SessionGuard } = require("../dist/features/auth/index");
  const { PermissionGuard } = require("../dist/features/authorization/index");
  const models = require("../dist/infrastructure/database/db");
  const root = await mkdtemp(path.join(os.tmpdir(), "goldis-download-smoke-"));
  const key = Buffer.alloc(32, 3).toString("base64");
  process.env.API_EXPORT_DIR = root;
  process.env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
  process.env.PESEL_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({ "1": key }), "utf8").toString("base64");
  const environment = {
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: process.env.PESEL_ENCRYPTION_KEYS_BASE64,
  };
  try {
    const ready = await seedLegacyRun("reading_oc", "2026-09-30", "Synthetic Decision Maker");
    const identity = {
      schemaVersion: 1, sourceRowId: ready.sourceRowId, regon: "012345678", companyName: "Synthetic Company",
      firstName: "Synthetic", lastName: "Decision Maker", pesel: "90010100016",
      matchMethod: "regon_company_name_decision_maker", adapterVersion: "fixture-v1",
    };
    const snapshot = {
      schemaVersion: 1, totalCount: 1, capturedAt: "2026-09-30T13:00:00.000Z", parserVersion: "fixture-v1",
      policies: [{
        sourceOrdinal: 1, insuredName: null, policyTypeAndNumber: "OC DOWNLOAD-1", contractType: "OC",
        insuredClaimCount: 0, vehicleRegistration: "TEST1", vehicleGroup: "Test vehicle", vehicleMake: "Synthetic",
        vehicleModel: "Model 1", insurer: "Synthetic insurer", coverageFrom: "2025-01-01", coverageTo: "2026-10-01",
      }],
    };
    await persistOcSnapshot(ready.runId, identity, snapshot, { environment });
    await evaluateStoredSnapshot(ready.runId);
    const runReader = Object.create(RunService.prototype);
    const evaluatedDetails = await runReader.get(ready.runId);
    if (evaluatedDetails.status !== "export_ready"
      || evaluatedDetails.policyCounts?.totalOcCount !== 1
      || evaluatedDetails.policyCounts?.currentOcCount !== 1
      || evaluatedDetails.artifactAvailable !== false) {
      throw new Error("RUN_DETAILS_COUNTS_OR_PREEXPORT_STATE_MISMATCH");
    }

    const noMatch = await seedLegacyRun("reading_oc", "2026-09-30");
    await persistOcSnapshot(noMatch.runId, { ...identity, sourceRowId: noMatch.sourceRowId }, {
      ...snapshot,
      policies: [{ ...snapshot.policies[0], policyTypeAndNumber: "OC DOWNLOAD-EXPIRED", coverageTo: "2026-09-29" }],
    }, { environment });
    await evaluateStoredSnapshot(noMatch.runId);
    const noMatchDetails = await runReader.get(noMatch.runId);
    if (noMatchDetails.status !== "no_matching_policies"
      || noMatchDetails.policyCounts?.totalOcCount !== 1
      || noMatchDetails.policyCounts?.currentOcCount !== 0
      || noMatchDetails.artifactAvailable !== false) {
      throw new Error("RUN_DETAILS_NO_MATCH_COUNTS_MISMATCH");
    }

    const artifact = await finalizeRunExport(ready.runId, { artifactRoot: root });
    const completedDetails = await runReader.get(ready.runId);
    if (completedDetails.status !== "completed"
      || completedDetails.policyCounts?.totalOcCount !== 1
      || completedDetails.policyCounts?.currentOcCount !== 1
      || completedDetails.artifactAvailable !== true) {
      throw new Error("RUN_DETAILS_COMPLETED_ARTIFACT_MISMATCH");
    }
    const verified = await getVerifiedArtifactDownload(ready.runId);
    const downloadHeaders = artifactDownloadHeaders(verified.fileName, verified.bytes.byteLength);
    if (!Buffer.isBuffer(verified.bytes) || verified.fileName !== artifact.fileName
      || createHash("sha256").update(verified.bytes).digest("hex") !== artifact.sha256
      || downloadHeaders["Cache-Control"] !== "private, no-store"
      || downloadHeaders["Content-Length"] !== String(verified.bytes.byteLength)
      || JSON.stringify(verified).includes(root)) {
      throw new Error("ARTIFACT_DOWNLOAD_METADATA_OR_HASH_MISMATCH");
    }

    const notReady = await seedLegacyRun("export_ready");
    let missingCode = null;
    try {
      await getVerifiedArtifactDownload(notReady.runId);
    } catch (error) {
      missingCode = error instanceof ArtifactDownloadError ? error.code : null;
    }
    if (missingCode !== "ARTIFACT_NOT_FOUND") throw new Error("ARTIFACT_DOWNLOAD_UNFINISHED_RUN_LEAKED");

    const secret = "synthetic-session-secret-for-artifact-download-test";
    process.env.SESSION_SECRET = secret;
    const adminUserId = "11111111-1111-4111-8111-111111111111";
    const operatorUserId = "22222222-2222-4222-8222-222222222222";
    const tenantId = "99999999-9999-4999-8999-999999999999";
    const guard = new SessionGuard(async (userId, requestedTenantId) =>
      requestedTenantId === tenantId
        ? userId === adminUserId ? "admin" : userId === operatorUserId ? "operator" : null
        : null);
    const permissionGuard = new PermissionGuard(async () => ({
      resourceTenantId: tenantId, resourceOwnerId: adminUserId,
    }));
    const contextFor = (request, handler = RunController.prototype.artifact) => ({
      switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler,
    });
    let unauthenticatedStatus = null;
    try {
      await guard.canActivate(contextFor({ headers: {} }));
    } catch (error) {
      unauthenticatedStatus = error?.getStatus?.() ?? null;
    }
    const issueTestCookie = (userId) => {
      const payload = Buffer.from(JSON.stringify({
        exp: Date.now() + 60000, userId, tenantId,
        csrf: "synthetic-csrf-token-with-sufficient-length-0000000000000000",
      })).toString("base64url");
      const hmac = createHmac("sha256", secret).update(payload).digest("base64url");
      return `goldis_session=${payload}.${hmac}`;
    };
    const adminRequest = { headers: { cookie: issueTestCookie(adminUserId) }, params: { id: ready.runId } };
    const adminContext = contextFor(adminRequest);
    const authorized = await guard.canActivate(adminContext);
    const adminResourceAuthorized = await permissionGuard.canActivate(adminContext);
    let otherOwnerStatus = null;
    try {
      const operatorContext = contextFor({ headers: { cookie: issueTestCookie(operatorUserId) }, params: { id: ready.runId } });
      await guard.canActivate(operatorContext);
      await permissionGuard.canActivate(operatorContext);
    } catch (error) {
      otherOwnerStatus = error?.getStatus?.() ?? null;
    }
    if (unauthenticatedStatus !== 401 || authorized !== true || !adminResourceAuthorized || otherOwnerStatus !== 404) {
      throw new Error("ARTIFACT_DOWNLOAD_SESSION_GUARD_MISMATCH");
    }

    const controller = new RunController({ downloadArtifact: getVerifiedArtifactDownload });
    const response = {
      headers: {}, statusCode: 0, body: null,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      send(bytes) { this.body = bytes; return this; },
    };
    await controller.artifact(ready.runId, response);
    if (response.statusCode !== 200 || !Buffer.isBuffer(response.body)
      || !response.body.equals(verified.bytes)
      || response.headers["Content-Type"] !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      throw new Error("ARTIFACT_DOWNLOAD_CONTROLLER_RESPONSE_MISMATCH");
    }

    await writeFile(path.join(root, artifact.storageKey), "tampered artifact bytes");
    let corruptCode = null;
    try {
      await getVerifiedArtifactDownload(ready.runId);
    } catch (error) {
      corruptCode = error instanceof ArtifactDownloadError ? error.code : null;
    }
    if (corruptCode !== "ARTIFACT_INTEGRITY_FAILED") throw new Error("ARTIFACT_DOWNLOAD_TAMPERING_NOT_DETECTED");
    console.log("ARTIFACT_DOWNLOAD_SMOKE_PASS signedAdmin=200 missingSession=401 adminResource=allowed otherOwner=404 missingArtifact=404 hash=verified tamper=blocked noPublicPath=true");
  } finally {
    await models.sequelize.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyCanonicalTenantMigration() {
  smokeStage = "canonical_tenant_scope_migration_setup";
  const models = require("../dist/infrastructure/database/db");
  const { randomUUID } = require("node:crypto");
  const goldis = await models.Tenant.findOne({ where: { slug: "goldis" } });
  if (!goldis) throw new Error("CANONICAL_TENANT_GOLDIS_MISSING");
  const otherTenantId = randomUUID();
  const now = new Date();
  await models.Tenant.create({
    tenantId: otherTenantId, slug: "synthetic-canonical-other", displayName: "Synthetic Other", createdAt: now,
  });
  const otherUserId = randomUUID();
  await sequelize.query(
    `INSERT INTO users (user_id, username, username_normalized, password_hash, status, created_at, updated_at, last_login_at)
     VALUES ($1, 'Synthetic.Canonical.Other', 'synthetic.canonical.other',
       'synthetic-password-hash-0123456789abcdef', 'active', $2, $2, NULL)`,
    { bind: [otherUserId, now] },
  );
  await models.TenantMembership.create({
    tenantId: otherTenantId, userId: otherUserId, role: "admin", status: "active", createdAt: now, updatedAt: now,
  });
  await sequelize.query(
    "UPDATE import_batches SET tenant_id = $1, owner_user_id = $2 WHERE id = $3",
    { bind: [otherTenantId, otherUserId, tenantScopeSeed.other.batchId] },
  );
  tenantScopeSeed.otherTenantId = otherTenantId;
  tenantScopeSeed.otherActorId = otherUserId;
  tenantScopeSeed.goldisTenantId = goldis.tenantId;

  const canonicalEntityId = randomUUID();
  await sequelize.query(
    `INSERT INTO canonical_entities
       (canonical_entity_id, nip_normalized, regon, business_name, created_at, updated_at)
     VALUES ($1, '5260250995', '012345678', 'Synthetic Company', $2, $2)`,
    { bind: [canonicalEntityId, now] },
  );
  for (const seeded of [tenantScopeSeed.goldis, tenantScopeSeed.other]) {
    await sequelize.query(
      `INSERT INTO source_entity_links (source_row_id, canonical_entity_id, match_method, linked_at)
       VALUES ($1, $2, 'nip_regon_exact', $3)`,
      { bind: [seeded.sourceRowId, canonicalEntityId, now] },
    );
    await sequelize.query(
      "UPDATE automation_runs SET canonical_entity_id = $1 WHERE id = $2",
      { bind: [canonicalEntityId, seeded.runId] },
    );
  }
  await sequelize.query(
    `INSERT INTO entity_grouping_conflicts
       (conflict_id, source_row_id, reason_code, candidate_entity_ids, status, created_at)
     VALUES ($1, $2, 'NAME_MISMATCH', jsonb_build_array($3::text), 'open', $4)`,
    { bind: [randomUUID(), tenantScopeSeed.other.sourceRowId, canonicalEntityId, now] },
  );
  await upThrough("024-canonical-entity-tenant-scope.js");
  // Current Sequelize models select the contact fields introduced in 052.
  // Finish the additive schema before using those models below; tenant-scope
  // assertions still inspect the data created around migration 024.
  await upThroughLatestTenantSchema();

  smokeStage = "canonical_tenant_scope_migration_assertions";
  const entities = await models.CanonicalEntity.findAll({ order: [["tenantId", "ASC"]] });
  const goldisEntity = entities.find((entity) => entity.tenantId === goldis.tenantId);
  const otherEntity = entities.find((entity) => entity.tenantId === otherTenantId);
  const goldisLink = await models.SourceEntityLink.findByPk(tenantScopeSeed.goldis.sourceRowId);
  const otherLink = await models.SourceEntityLink.findByPk(tenantScopeSeed.other.sourceRowId);
  const goldisRun = await models.AutomationRun.findByPk(tenantScopeSeed.goldis.runId, { attributes: ["id", "canonicalEntityId"] });
  const otherRun = await models.AutomationRun.findByPk(tenantScopeSeed.other.runId, { attributes: ["id", "canonicalEntityId"] });
  const [conflicts] = await sequelize.query(
    "SELECT candidate_entity_ids FROM entity_grouping_conflicts WHERE source_row_id = $1",
    { bind: [tenantScopeSeed.other.sourceRowId] },
  );
  if (entities.length !== 2 || !goldisEntity || !otherEntity || goldisEntity.canonicalEntityId === otherEntity.canonicalEntityId
    || goldisEntity.nipNormalized !== otherEntity.nipNormalized || goldisEntity.regon !== otherEntity.regon
    || goldisLink?.tenantId !== goldis.tenantId || goldisLink.canonicalEntityId !== goldisEntity.canonicalEntityId
    || otherLink?.tenantId !== otherTenantId || otherLink.canonicalEntityId !== otherEntity.canonicalEntityId
    || goldisRun?.canonicalEntityId !== goldisEntity.canonicalEntityId
    || otherRun?.canonicalEntityId !== otherEntity.canonicalEntityId
    || JSON.stringify(conflicts[0]?.candidate_entity_ids) !== JSON.stringify([otherEntity.canonicalEntityId])) {
    throw new Error("CANONICAL_TENANT_BACKFILL_MISMATCH");
  }

  let sameTenantDuplicateRejected = false;
  try {
    await models.CanonicalEntity.create({
      canonicalEntityId: randomUUID(), tenantId: otherTenantId, nipNormalized: "5260250995", regon: "987654321",
      businessName: "Synthetic Conflicting Company", createdAt: now, updatedAt: now,
    });
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23505") throw error;
    sameTenantDuplicateRejected = true;
  }
  const thirdTenantId = randomUUID();
  await models.Tenant.create({
    tenantId: thirdTenantId, slug: "synthetic-canonical-third", displayName: "Synthetic Third", createdAt: now,
  });
  await models.CanonicalEntity.create({
    canonicalEntityId: randomUUID(), tenantId: thirdTenantId, nipNormalized: "5260250995", regon: "012345678",
    businessName: "Synthetic Company", createdAt: now, updatedAt: now,
  });
  const crossTenantRow = await models.SourceRow.create({
    id: randomUUID(), batchId: tenantScopeSeed.goldis.batchId, rowNumber: 18100,
    companyName: "Synthetic Company", decisionMakerName: "Synthetic Lead", nipRaw: "5260250995",
    address: "Synthetic", postalCode: "00-000", city: "Synthetic", regonRaw: "012345678",
    regon: "012345678", effectiveRegon: "012345678", rowVersion: 1, issues: [],
  });
  let crossTenantLinkRejected = false;
  try {
    await models.SourceEntityLink.create({
      sourceRowId: crossTenantRow.id, tenantId: goldis.tenantId,
      canonicalEntityId: otherEntity.canonicalEntityId, matchMethod: "manual", linkedAt: now,
    });
  } catch (error) {
    const code = error?.parent?.code ?? error?.original?.code;
    if (code !== "23503") throw error;
    crossTenantLinkRejected = true;
  }
  if (!sameTenantDuplicateRejected || !crossTenantLinkRejected) {
    throw new Error("CANONICAL_TENANT_CONSTRAINTS_NOT_ENFORCED");
  }

  smokeStage = "canonical_tenant_scope_application_queries";
  const { EntityGroupingService } = require("../dist/features/grouping/grouping.service");
  const { CanonicalRunService, createLeadIdentityKey } = require("../dist/features/runs/canonical-run-service");
  const grouping = new EntityGroupingService();
  const goldisNewRow = await models.SourceRow.create({
    id: randomUUID(), batchId: tenantScopeSeed.goldis.batchId, rowNumber: 18101,
    companyName: "Synthetic Company", decisionMakerName: "Synthetic Lead", nipRaw: "5260250995",
    address: "Synthetic", postalCode: "00-000", city: "Synthetic", regonRaw: "012345678",
    regon: "012345678", effectiveRegon: "012345678", rowVersion: 1, issues: [],
  });
  const otherNewRow = await models.SourceRow.create({
    id: randomUUID(), batchId: tenantScopeSeed.other.batchId, rowNumber: 18101,
    companyName: "Synthetic Company", decisionMakerName: "Synthetic Lead", nipRaw: "5260250995",
    address: "Synthetic", postalCode: "00-000", city: "Synthetic", regonRaw: "012345678",
    regon: "012345678", effectiveRegon: "012345678", rowVersion: 1, issues: [],
  });
  const goldisOutcome = await grouping.resolveSourceRow(tenantScopeSeed.goldis.batchId, 18101);
  const otherOutcome = await grouping.resolveSourceRow(tenantScopeSeed.other.batchId, 18101);
  let wrongTenantRunRejected = false;
  try {
    await new CanonicalRunService().createOrGet(
      tenantScopeSeed.goldis.batchId, otherEntity.canonicalEntityId,
      createLeadIdentityKey(otherEntity.canonicalEntityId, "Synthetic Lead"), [goldisNewRow],
    );
  } catch (error) { wrongTenantRunRejected = error?.getStatus?.() === 400; }
  const refreshedLinks = await models.SourceEntityLink.findAll({ where: { sourceRowId: [goldisNewRow.id, otherNewRow.id] } });
  if (goldisOutcome.status !== "linked" || goldisOutcome.canonicalEntityId !== goldisEntity.canonicalEntityId
    || otherOutcome.status !== "linked" || otherOutcome.canonicalEntityId !== otherEntity.canonicalEntityId
    || refreshedLinks.length !== 2 || refreshedLinks.some((link) => link.tenantId === otherTenantId && link.sourceRowId === goldisNewRow.id)
    || !wrongTenantRunRejected) {
    throw new Error("CANONICAL_TENANT_APPLICATION_SCOPE_MISMATCH");
  }
  await verifyReviewDecisionFlows(models, goldisEntity, otherEntity);
  console.log("CANONICAL_TENANT_SCOPE_SMOKE_PASS migration=024 sharedLegacyEntitySplit=true linksRunsConflictsRemapped=true tenantScopedUnique=true compositeLinkFk=true groupingScoped=true wrongTenantRun=blocked reviewApproveReject=true conflictDecisions=true tenantGrantScoped=true auditRollback=true runIdentityImmutable=true");
}

async function verifyReviewDecisionFlows(models, goldisEntity, otherEntity) {
  smokeStage = "review_decision_fixture_setup";
  const { randomUUID } = require("node:crypto");
  const { EntityGroupingService } = require("../dist/features/grouping/grouping.service");
  const { ReviewService } = require("../dist/features/review/review.service");
  const imports = createImportService();
  const grouping = new EntityGroupingService();
  const review = new ReviewService(grouping, createAuditService());
  const actor = { tenantId: tenantScopeSeed.goldisTenantId, userId: tenantScopeSeed.goldisActorId, role: "admin" };
  const reviewerId = randomUUID();
  const now = new Date();
  await models.User.create({
    userId: reviewerId, username: "Synthetic.Review.Reader", usernameNormalized: "synthetic.review.reader",
    passwordHash: "synthetic-password-hash-0123456789abcdef", status: "active", createdAt: now, updatedAt: now, lastLoginAt: null,
  });
  await models.TenantMembership.create({
    tenantId: actor.tenantId, userId: reviewerId, role: "reviewer", status: "active", createdAt: now, updatedAt: now,
  });
  await models.ToolGrant.create({
    tenantId: actor.tenantId, toolId: "oc-policy-verification", userId: reviewerId,
    canDiscover: false, canExecute: false, canViewResults: false, canDownloadResults: false,
    grantedBy: actor.userId, createdAt: now, updatedAt: now, version: 1,
  });

  let rowNumber = 18200;
  const regon = () => randomUUID().replace(/\D/g, "").slice(0, 9).padEnd(9, "1");
  const createRow = async (values = {}) => models.SourceRow.create({
    id: randomUUID(), batchId: tenantScopeSeed.goldis.batchId, rowNumber: rowNumber++,
    companyName: "Synthetic Review Company", decisionMakerName: "Synthetic Review Lead", nipRaw: "",
    address: "Synthetic", postalCode: "00-000", city: "Synthetic", regonRaw: "", regon: null,
    effectiveRegon: null, rowVersion: 1, issues: ["REGON_EMPTY"], ...values,
  });
  const proposal = async (row, proposedRegon) => imports.proposeRegonCorrection(
    tenantScopeSeed.goldis.batchId, row.rowNumber,
    { proposedRegon, reason: "Synthetic source document checked", expectedVersion: row.rowVersion },
    actor.userId, { tenantId: actor.tenantId, actorUserId: actor.userId },
  );

  smokeStage = "review_queue_scope_sql";
  const approveRow = await createRow();
  const approveProposal = await proposal(approveRow, regon());
  let reviewerPage = await review.listCorrections({ tenantId: actor.tenantId, userId: reviewerId, role: "reviewer" }, {
    status: "pending", batchId: tenantScopeSeed.goldis.batchId, limit: "10",
  });
  if (reviewerPage.items.length !== 0) throw new Error("REVIEW_QUEUE_IGNORED_CURRENT_TOOL_GRANT");
  await models.ToolGrant.update({ canViewResults: true, updatedAt: new Date(), version: 2 }, {
    where: { tenantId: actor.tenantId, toolId: "oc-policy-verification", userId: reviewerId },
  });
  reviewerPage = await review.listCorrections({ tenantId: actor.tenantId, userId: reviewerId, role: "reviewer" }, {
    status: "pending", batchId: tenantScopeSeed.goldis.batchId, limit: "10",
  });
  if (!reviewerPage.items.some((item) => item.id === approveProposal.correctionId)) throw new Error("REVIEW_QUEUE_IGNORED_GRANTED_REVIEWER");
  const otherTenantPage = await review.listCorrections({ tenantId: tenantScopeSeed.otherTenantId, userId: tenantScopeSeed.otherActorId, role: "admin" }, {
    status: "pending", batchId: tenantScopeSeed.goldis.batchId, limit: "10",
  });
  if (otherTenantPage.items.length !== 0) throw new Error("REVIEW_QUEUE_LEAKED_CROSS_TENANT_RECORD");

  smokeStage = "review_correction_approve_atomic_grouping_audit";
  const approved = await review.decideCorrection(approveProposal.correctionId, actor, {
    decision: "approved", expectedRowVersion: approveProposal.rowVersion, reasonCode: "SOURCE_DOCUMENT_VERIFIED",
  });
  const approvedRow = await models.SourceRow.findByPk(approveRow.id);
  const approvedLink = await models.SourceEntityLink.findByPk(approveRow.id);
  const approvedCorrection = await models.RegonCorrection.findByPk(approveProposal.correctionId);
  const [approvedAudit] = await sequelize.query(
    "SELECT event_id FROM audit_events WHERE action = 'regon.correction.reviewed' AND resource_id = $1 AND actor_user_id = $2",
    { bind: [approveProposal.correctionId, actor.userId] },
  );
  if (approved.decision !== "approved" || approvedRow?.effectiveRegon !== approveProposal.proposedRegon
    || approvedRow?.issues.length !== 0 || approvedRow?.rowVersion !== approved.rowVersion
    || approvedLink?.tenantId !== actor.tenantId || approvedCorrection?.reviewerRef !== actor.userId
    || approvedCorrection?.status !== "approved" || approvedAudit.length !== 1) {
    throw new Error("REVIEW_CORRECTION_APPROVAL_DID_NOT_ATOMICALLY_UPDATE_SOURCE_GROUP_AUDIT");
  }

  smokeStage = "review_correction_rejection_preserves_effective_value";
  const rejectRow = await createRow({ effectiveRegon: "765432109", regonRaw: "765432109", regon: "765432109", issues: [] });
  const rejectProposal = await proposal(rejectRow, regon());
  await review.decideCorrection(rejectProposal.correctionId, actor, {
    decision: "rejected", expectedRowVersion: rejectProposal.rowVersion, reasonCode: "OTHER",
  });
  const rejectedRow = await models.SourceRow.findByPk(rejectRow.id);
  const rejectedCorrection = await models.RegonCorrection.findByPk(rejectProposal.correctionId);
  if (rejectedRow?.effectiveRegon !== "765432109" || rejectedRow.rowVersion !== rejectProposal.rowVersion + 1
    || rejectedCorrection?.status !== "rejected" || rejectedCorrection.reviewerRef !== actor.userId) {
    throw new Error("REVIEW_CORRECTION_REJECTION_MUTATED_EFFECTIVE_VALUE");
  }

  smokeStage = "review_conflict_link_and_reject";
  const manualCandidateId = randomUUID();
  const manualRegon = regon();
  await models.CanonicalEntity.create({
    canonicalEntityId: manualCandidateId, tenantId: actor.tenantId, nipNormalized: null,
    regon: manualRegon, businessName: "Synthetic Manual Candidate", createdAt: now, updatedAt: now,
  });
  const linkRow = await createRow({ companyName: "Synthetic Manual Candidate", regonRaw: manualRegon, regon: manualRegon, effectiveRegon: manualRegon, issues: [] });
  const linkConflictId = randomUUID();
  await models.EntityGroupingConflict.create({
    conflictId: linkConflictId, sourceRowId: linkRow.id, reasonCode: "MULTIPLE_CANONICAL_MATCHES",
    candidateEntityIds: [manualCandidateId], status: "open", resolutionNote: null, resolvedBy: null, resolvedAt: null, createdAt: now,
  });
  const linkDecision = await review.resolveConflict(linkConflictId, actor, {
    action: "link_existing", expectedRowVersion: 1, reasonCode: "IDENTIFIERS_VERIFIED", canonicalEntityId: manualCandidateId,
  });
  const linkRecord = await models.SourceEntityLink.findByPk(linkRow.id);
  const resolvedLinkConflict = await models.EntityGroupingConflict.findByPk(linkConflictId);
  if (linkDecision.decision !== "link_existing" || linkRecord?.canonicalEntityId !== manualCandidateId
    || resolvedLinkConflict?.status !== "resolved" || resolvedLinkConflict.resolvedBy !== actor.userId) {
    throw new Error("REVIEW_CONFLICT_LINK_DECISION_MISMATCH");
  }

  const rejectLinkRow = await createRow({ companyName: "Synthetic Manual Candidate", regonRaw: manualRegon, regon: manualRegon, effectiveRegon: manualRegon, issues: [] });
  await models.SourceEntityLink.create({
    sourceRowId: rejectLinkRow.id, tenantId: actor.tenantId, canonicalEntityId: manualCandidateId,
    matchMethod: "manual", linkedAt: now,
  });
  const rejectLinkConflictId = randomUUID();
  await models.EntityGroupingConflict.create({
    conflictId: rejectLinkConflictId, sourceRowId: rejectLinkRow.id, reasonCode: "SOURCE_LINK_MISMATCH",
    candidateEntityIds: [manualCandidateId], status: "open", resolutionNote: null, resolvedBy: null, resolvedAt: null, createdAt: now,
  });
  await review.resolveConflict(rejectLinkConflictId, actor, {
    action: "reject_link", expectedRowVersion: 1, reasonCode: "CANDIDATE_REJECTED",
  });
  const rejectedLinkRow = await models.SourceRow.findByPk(rejectLinkRow.id);
  if (await models.SourceEntityLink.findByPk(rejectLinkRow.id) || !rejectedLinkRow?.issues.includes("ENTITY_LINK_REJECTED")) {
    throw new Error("REVIEW_REJECT_LINK_DID_NOT_LEAVE_EXPLICIT_REVIEW_STATE");
  }

  smokeStage = "review_conflict_recheck_and_tenant_id_validation";
  const mismatchRow = await createRow({
    companyName: goldisEntity.businessName, nipRaw: goldisEntity.nipNormalized,
    regonRaw: "987654321", regon: "987654321", effectiveRegon: "987654321", issues: [],
  });
  const mismatchOutcome = await grouping.resolveSourceRow(tenantScopeSeed.goldis.batchId, mismatchRow.rowNumber);
  const mismatchConflict = await models.EntityGroupingConflict.findOne({ where: { sourceRowId: mismatchRow.id, status: "open" } });
  if (mismatchOutcome.status !== "conflict" || !mismatchConflict) throw new Error("REVIEW_RECHECK_FIXTURE_NOT_CONFLICTED");
  const recheck = await review.resolveConflict(mismatchConflict.conflictId, actor, {
    action: "recheck", expectedRowVersion: mismatchOutcome.rowVersion, reasonCode: "SOURCE_DATA_UPDATED",
  });
  const openAfterRecheck = await models.EntityGroupingConflict.findAll({ where: { sourceRowId: mismatchRow.id, status: "open" } });
  const crossTenantCandidateConflictId = randomUUID();
  const foreignCandidateRow = await createRow({
    companyName: otherEntity.businessName, nipRaw: otherEntity.nipNormalized,
    regonRaw: otherEntity.regon, regon: otherEntity.regon, effectiveRegon: otherEntity.regon, issues: [],
  });
  await models.EntityGroupingConflict.create({
    conflictId: crossTenantCandidateConflictId, sourceRowId: foreignCandidateRow.id, reasonCode: "MULTIPLE_CANONICAL_MATCHES",
    candidateEntityIds: [otherEntity.canonicalEntityId], status: "open", resolutionNote: null, resolvedBy: null, resolvedAt: null, createdAt: now,
  });
  let foreignCandidateRejected = false;
  try {
    await review.resolveConflict(crossTenantCandidateConflictId, actor, {
      action: "link_existing", expectedRowVersion: 1, reasonCode: "IDENTIFIERS_VERIFIED", canonicalEntityId: otherEntity.canonicalEntityId,
    });
  } catch (error) { foreignCandidateRejected = error?.getStatus?.() === 404; }
  const crossTenantList = await review.listConflicts(actor, { status: "open", batchId: tenantScopeSeed.goldis.batchId, limit: "50" });
  const hiddenForeignCandidate = crossTenantList.items.find((item) => item.id === crossTenantCandidateConflictId);
  if (recheck.grouping !== "conflict" || openAfterRecheck.length !== 1 || !foreignCandidateRejected
    || hiddenForeignCandidate?.candidates.some((candidate) => candidate.id === otherEntity.canonicalEntityId)) {
    throw new Error("REVIEW_RECHECK_OR_FOREIGN_CANDIDATE_SCOPE_MISMATCH");
  }

  smokeStage = "review_existing_run_blocks_identity_change";
  await models.AutomationRun.update({ status: "queued", currentStep: "queued" }, { where: { id: tenantScopeSeed.goldis.runId } });
  const activeSourceRow = await models.SourceRow.findByPk(tenantScopeSeed.goldis.sourceRowId);
  const activeProposal = await proposal(activeSourceRow, regon());
  let existingRunBlocked = false;
  try {
    await review.decideCorrection(activeProposal.correctionId, actor, {
      decision: "approved", expectedRowVersion: activeProposal.rowVersion, reasonCode: "SOURCE_DOCUMENT_VERIFIED",
    });
  } catch (error) { existingRunBlocked = error?.getStatus?.() === 409; }
  const activeStillQueued = await models.AutomationRun.findByPk(tenantScopeSeed.goldis.runId);
  const activeSourceAfter = await models.SourceRow.findByPk(tenantScopeSeed.goldis.sourceRowId);
  if (!existingRunBlocked || activeStillQueued?.status !== "queued" || activeSourceAfter?.effectiveRegon !== "012345678") {
    throw new Error("REVIEW_CHANGED_IDENTITY_OF_ACCEPTED_RUN");
  }

  smokeStage = "review_audit_failure_rolls_back_decision";
  const rollbackRow = await createRow();
  const rollbackProposal = await proposal(rollbackRow, regon());
  await sequelize.query(`CREATE FUNCTION reject_review_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'regon.correction.reviewed' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_WRITE_FAILURE'; END IF; RETURN NEW; END $$`);
  await sequelize.query("CREATE TRIGGER reject_review_audit_event BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_review_audit_event()");
  let auditFailureObserved = false;
  try {
    await review.decideCorrection(rollbackProposal.correctionId, actor, {
      decision: "approved", expectedRowVersion: rollbackProposal.rowVersion, reasonCode: "SOURCE_DOCUMENT_VERIFIED",
    });
  } catch { auditFailureObserved = true; }
  finally {
    await sequelize.query("DROP TRIGGER IF EXISTS reject_review_audit_event ON audit_events");
    await sequelize.query("DROP FUNCTION IF EXISTS reject_review_audit_event()");
  }
  const rollbackAfter = await models.SourceRow.findByPk(rollbackRow.id);
  const rollbackCorrectionAfter = await models.RegonCorrection.findByPk(rollbackProposal.correctionId);
  if (!auditFailureObserved || rollbackAfter?.effectiveRegon !== null || rollbackAfter.rowVersion !== rollbackProposal.rowVersion
    || rollbackCorrectionAfter?.status !== "pending" || await models.SourceEntityLink.findByPk(rollbackRow.id)) {
    throw new Error("REVIEW_AUDIT_FAILURE_DID_NOT_ROLL_BACK_DECISION");
  }
}

async function verifyEnrichmentJobFlows() {
  smokeStage = "enrichment_job_persistence_and_runner";
  const models = require("../dist/infrastructure/database/db");
  const { EnrichmentJobService, RegistryEnrichmentJobRunner } = require("../dist/features/enrichment/public");
  const jobs = new EnrichmentJobService();
  const actor = { tenantId: tenantScopeSeed.goldisTenantId, userId: tenantScopeSeed.goldisActorId, role: "admin" };
  let nextRowNumber = 18300;
  const addRow = async (overrides = {}) => models.SourceRow.create({
    id: randomUUID(), batchId: tenantScopeSeed.goldis.batchId, rowNumber: nextRowNumber++,
    companyName: "Synthetic Enrichment Company", decisionMakerName: null, nipRaw: "1234563218",
    address: "Synthetic", postalCode: "00-000", city: "Test City", regonRaw: "", regon: null,
    effectiveRegon: null, rowVersion: 1, issues: ["REGON_EMPTY"], ...overrides,
  });
  const first = await addRow();
  const second = await addRow();
  const key = "synthetic-enrichment-job-fixture-01";
  const input = { idempotencyKey: key, rowNumbers: [first.rowNumber, second.rowNumber] };
  const created = await jobs.start(tenantScopeSeed.goldis.batchId, input, actor);
  const replay = await jobs.start(tenantScopeSeed.goldis.batchId, input, actor);
  let changedPayloadStatus = null;
  try {
    await jobs.start(tenantScopeSeed.goldis.batchId, { idempotencyKey: key, rowNumbers: [first.rowNumber] }, actor);
  } catch (error) { changedPayloadStatus = error?.getStatus?.() ?? null; }
  if (created.replayed || !replay.replayed || created.id !== replay.id || changedPayloadStatus !== 409) {
    throw new Error("ENRICHMENT_JOB_IDEMPOTENCY_MISMATCH");
  }
  let crossTenantStatus = null;
  try {
    await jobs.get(created.id, { tenantId: tenantScopeSeed.otherTenantId, userId: tenantScopeSeed.otherActorId, role: "admin" });
  } catch (error) { crossTenantStatus = error?.getStatus?.() ?? null; }
  if (crossTenantStatus !== 404) throw new Error("ENRICHMENT_JOB_CROSS_TENANT_READ_NOT_CONCEALED");

  const otherTenantActor = { tenantId: tenantScopeSeed.otherTenantId, userId: tenantScopeSeed.otherActorId, role: "admin" };
  const assertConcealed = async (label, operation) => {
    let status = null;
    try { await operation(); } catch (error) { status = error?.getStatus?.() ?? null; }
    if (status !== 404) throw new Error(`ENRICHMENT_${label}_NOT_CONCEALED status=${status}`);
  };
  const adminJobAuditCountBefore = await models.AuditEvent.count({ where: { resourceId: created.id } });
  const tenantJobCountBefore = await models.EnrichmentJob.count({ where: { tenantId: actor.tenantId } });
  await assertConcealed("CROSS_TENANT_LIST", () => jobs.listForBatch(tenantScopeSeed.goldis.batchId, otherTenantActor));
  await assertConcealed("CROSS_TENANT_ITEMS", () => jobs.listItems(created.id, undefined, otherTenantActor));
  await assertConcealed("CROSS_TENANT_CANCEL", () => jobs.cancel(created.id, { expectedVersion: created.version }, otherTenantActor));
  await assertConcealed("CROSS_TENANT_START", () => jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-cross-tenant-enrichment", rowNumbers: [first.rowNumber],
  }, otherTenantActor));

  const nonOwnerId = randomUUID();
  const nonOwnerName = `Synthetic.Registry.NonOwner.${nonOwnerId.slice(0, 8)}`;
  const nonOwnerNow = new Date();
  await models.User.create({
    userId: nonOwnerId, username: nonOwnerName, usernameNormalized: nonOwnerName.toLowerCase(),
    passwordHash: "synthetic-password-hash-0123456789abcdef", status: "active", createdAt: nonOwnerNow, updatedAt: nonOwnerNow,
    lastLoginAt: null, mustChangePassword: false,
  });
  await models.TenantMembership.create({
    tenantId: actor.tenantId, userId: nonOwnerId, role: "operator", status: "active", createdAt: nonOwnerNow, updatedAt: nonOwnerNow,
  });
  const sameTenantNonOwner = { tenantId: actor.tenantId, userId: nonOwnerId, role: "operator" };
  await assertConcealed("NON_OWNER_LIST", () => jobs.listForBatch(tenantScopeSeed.goldis.batchId, sameTenantNonOwner));
  await assertConcealed("NON_OWNER_READ", () => jobs.get(created.id, sameTenantNonOwner));
  await assertConcealed("NON_OWNER_ITEMS", () => jobs.listItems(created.id, undefined, sameTenantNonOwner));
  await assertConcealed("NON_OWNER_CANCEL", () => jobs.cancel(created.id, { expectedVersion: created.version }, sameTenantNonOwner));
  await assertConcealed("NON_OWNER_START", () => jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-non-owner-enrichment", rowNumbers: [first.rowNumber],
  }, sameTenantNonOwner));
  const unchangedAfterAuthorizationAttempts = await jobs.get(created.id, actor);
  const unchangedItemsAfterAuthorizationAttempts = await jobs.listItems(created.id, undefined, actor);
  if (unchangedAfterAuthorizationAttempts.version !== created.version || unchangedAfterAuthorizationAttempts.status !== "queued"
    || unchangedItemsAfterAuthorizationAttempts.items.length !== 2
    || unchangedItemsAfterAuthorizationAttempts.items.some((item) => item.status !== "pending")
    || await models.EnrichmentJob.count({ where: { tenantId: actor.tenantId } }) !== tenantJobCountBefore
    || await models.AuditEvent.count({ where: { resourceId: created.id } }) !== adminJobAuditCountBefore) {
    throw new Error("ENRICHMENT_AUTHORIZATION_DENIAL_CHANGED_JOB_OR_AUDIT");
  }
  console.log("ENRICHMENT_TENANT_OWNER_MATRIX_PASS crossTenant=list,read,items,cancel,start denied=true sameTenantNonOwner=list,read,items,cancel,start denied=true noStateOrAuditChange=true");

  const candidate = { nip: "1234563218", regon: "987654321", name: "Synthetic Enrichment Company" };
  let providerCalls = 0;
  const fixtureProvider = {
    async lookupByNip() {
      providerCalls += 1;
      return {
        providerName: "synthetic-registry", providerVersion: "fixture-1", dataVersion: "synthetic-release-1",
        fetchedAt: new Date("2026-01-15T12:00:00.000Z"), candidates: [candidate],
      };
    },
  };
  const workerId = randomUUID();
  const runner = new RegistryEnrichmentJobRunner(fixtureProvider);
  if (!await runner.processOne(workerId) || !await runner.processOne(workerId) || await runner.processOne(workerId)) {
    throw new Error("ENRICHMENT_JOB_RUNNER_DRAIN_MISMATCH");
  }
  const completed = await jobs.get(created.id, actor);
  const persistedRows = await models.SourceRow.findAll({ where: { id: [first.id, second.id] }, order: [["rowNumber", "ASC"]] });
  const links = await models.SourceEntityLink.findAll({ where: { sourceRowId: [first.id, second.id] } });
  if (providerCalls !== 1 || completed.status !== "completed" || completed.completedCount !== 2
    || persistedRows.length !== 2 || persistedRows.some((row) => row.effectiveRegon !== "987654321" || row.rowVersion !== 2)
    || links.length !== 2 || links[0].canonicalEntityId !== links[1].canonicalEntityId
    || links.some((link) => link.matchMethod !== "registry_verified")) {
    throw new Error("ENRICHMENT_JOB_DEDUP_GROUPING_OR_APPLY_MISMATCH");
  }
  const items = await jobs.listItems(created.id, undefined, actor);
  if (items.items.length !== 2 || items.items.some((item) => item.status !== "matched") || items.nextCursor !== null) {
    throw new Error("ENRICHMENT_JOB_ITEM_PROJECTION_MISMATCH");
  }

  const makeValidNip = (prefixNumber) => {
    const prefix = String(prefixNumber).padStart(9, "0").slice(-9);
    const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11;
    if (checksum === 10) return makeValidNip(prefixNumber + 1);
    return `${prefix}${checksum}`;
  };
  const { normalizeRegon } = require("@goldis/core");
  const makeValidRegon = (seed) => {
    const weights = [8, 9, 2, 3, 4, 5, 6, 7];
    for (let candidate = seed; ; candidate += 1) {
      const prefix = String(candidate).padStart(8, "0").slice(-8);
      const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11 % 10;
      const regon = `${prefix}${checksum}`;
      if (normalizeRegon(regon).normalized === regon) return regon;
    }
  };

  smokeStage = "enrichment_pending_correction_during_lookup";
  const pendingCorrectionRow = await addRow({ nipRaw: makeValidNip(123459901) });
  const pendingCorrectionJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-pending-correction-race", rowNumbers: [pendingCorrectionRow.rowNumber],
  }, actor);
  let pendingCorrectionId = null;
  const pendingCorrectionRunner = new RegistryEnrichmentJobRunner({
    async lookupByNip(nip) {
      const correction = await models.RegonCorrection.create({
        correctionId: randomUUID(), sourceRowId: pendingCorrectionRow.id, authorRef: actor.userId,
        reason: "Synthetic correction opened during registry request", previousRegon: null,
        proposedRegon: makeValidRegon(81234001), status: "pending", reviewerRef: null, reviewedAt: null,
        reviewReason: null, createdAt: new Date(),
      });
      pendingCorrectionId = correction.correctionId;
      return { providerName: "synthetic-registry", providerVersion: "correction-race-1", dataVersion: "synthetic",
        fetchedAt: new Date(), candidates: [{ nip, regon: "987654321", name: "Synthetic Enrichment Company" }] };
    },
  });
  if (!await pendingCorrectionRunner.processOne(randomUUID())) throw new Error("ENRICHMENT_PENDING_CORRECTION_FIXTURE_NOT_CLAIMED");
  const pendingCorrectionAfter = await models.SourceRow.findByPk(pendingCorrectionRow.id);
  const pendingCorrectionItem = (await jobs.listItems(pendingCorrectionJob.id, undefined, actor)).items[0];
  if (!pendingCorrectionId || pendingCorrectionAfter.effectiveRegon !== null || pendingCorrectionAfter.rowVersion !== 1
    || pendingCorrectionItem.status !== "excluded" || pendingCorrectionItem.reasonCode !== "ROW_NO_LONGER_ELIGIBLE"
    || await models.RegistryEnrichmentAudit.count({ where: { sourceRowId: pendingCorrectionRow.id } }) !== 0) {
    throw new Error("ENRICHMENT_PENDING_CORRECTION_DURING_LOOKUP_WROTE_REGISTRY_RESULT");
  }

  smokeStage = "enrichment_resolved_correction_during_lookup";
  const resolvedCorrectionRow = await addRow({ nipRaw: makeValidNip(123459902) });
  const resolvedCorrectionJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-approved-correction-race", rowNumbers: [resolvedCorrectionRow.rowNumber],
  }, actor);
  const manualCorrectionRegon = makeValidRegon(81234002);
  const { ReviewService } = require("../dist/features/review/review.service");
  const reviewService = new ReviewService(
    new (require("../dist/features/grouping/grouping.service").EntityGroupingService)(),
    createAuditService(),
  );
  let approvedCorrectionId = null;
  const resolvedCorrectionRunner = new RegistryEnrichmentJobRunner({
    async lookupByNip(nip) {
      const correction = await models.RegonCorrection.create({
        correctionId: randomUUID(), sourceRowId: resolvedCorrectionRow.id, authorRef: actor.userId,
        reason: "Synthetic correction approved during registry request", previousRegon: null,
        proposedRegon: manualCorrectionRegon, status: "pending", reviewerRef: null, reviewedAt: null,
        reviewReason: null, createdAt: new Date(),
      });
      approvedCorrectionId = correction.correctionId;
      await reviewService.decideCorrection(correction.correctionId, actor, {
        decision: "approved", expectedRowVersion: 1, reasonCode: "REGISTRY_MATCH_VERIFIED",
      });
      return { providerName: "synthetic-registry", providerVersion: "correction-race-2", dataVersion: "synthetic",
        fetchedAt: new Date(), candidates: [{ nip, regon: "987654321", name: "Synthetic Enrichment Company" }] };
    },
  });
  if (!await resolvedCorrectionRunner.processOne(randomUUID())) throw new Error("ENRICHMENT_APPROVED_CORRECTION_FIXTURE_NOT_CLAIMED");
  const resolvedCorrectionAfter = await models.SourceRow.findByPk(resolvedCorrectionRow.id);
  const approvedCorrection = await models.RegonCorrection.findByPk(approvedCorrectionId);
  const resolvedCorrectionItem = (await jobs.listItems(resolvedCorrectionJob.id, undefined, actor)).items[0];
  if (approvedCorrection?.status !== "approved" || resolvedCorrectionAfter.effectiveRegon !== manualCorrectionRegon
    || resolvedCorrectionAfter.rowVersion < 2 || resolvedCorrectionItem.status !== "excluded"
    || resolvedCorrectionItem.reasonCode !== "ROW_NO_LONGER_ELIGIBLE"
    || await models.RegistryEnrichmentAudit.count({ where: { sourceRowId: resolvedCorrectionRow.id } }) !== 0) {
    throw new Error("ENRICHMENT_APPROVED_CORRECTION_DURING_LOOKUP_WAS_OVERWRITTEN");
  }
  console.log("ENRICHMENT_CORRECTION_RACE_PASS pendingCorrectionDuringLookupExcluded=true approvedCorrectionDuringLookupPreserved=true registryAuditWrites=0");

  const capacityRows = [];
  const capacityNames = new Map();
  const capacityJobs = [];
  for (let index = 0; index < 4; index += 1) {
    const nip = makeValidNip(123450000 + index);
    const companyName = `Synthetic Capacity Company ${index}`;
    const row = await addRow({ companyName, nipRaw: nip });
    capacityRows.push(row);
    capacityNames.set(nip, companyName);
    capacityJobs.push(await jobs.start(tenantScopeSeed.goldis.batchId, {
      idempotencyKey: `synthetic-enrichment-capacity-${index}`, rowNumbers: [row.rowNumber],
    }, actor));
  }
  let activeLookups = 0;
  let maxActiveLookups = 0;
  let capacityCalls = 0;
  const capacityProvider = {
    async lookupByNip(nip) {
      activeLookups += 1;
      capacityCalls += 1;
      const requestNumber = capacityCalls;
      maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
      await new Promise((resolve) => setTimeout(resolve, 80));
      activeLookups -= 1;
      return {
        providerName: "synthetic-registry", providerVersion: "fixture-1", dataVersion: "synthetic-release-1",
        fetchedAt: new Date(), candidates: [{ nip, regon: `98765${String(requestNumber).padStart(4, "0")}`, name: capacityNames.get(nip) }],
      };
    },
  };
  const capacityWorkers = capacityJobs.map(() => new RegistryEnrichmentJobRunner(capacityProvider));
  const capacityWorkerIds = capacityJobs.map(() => randomUUID());
  const firstWave = await Promise.all(capacityWorkers.map((runner, index) => runner.processOne(capacityWorkerIds[index])));
  if (maxActiveLookups > 3 || firstWave.filter(Boolean).length > 3 || capacityCalls > 4) {
    throw new Error("ENRICHMENT_GLOBAL_WORKER_LIMIT_EXCEEDED");
  }
  for (let pass = 0; pass < 3; pass += 1) {
    await Promise.all(capacityWorkers.map((runner, index) => runner.processOne(capacityWorkerIds[index])));
  }
  const capacityStates = await Promise.all(capacityJobs.map((job) => jobs.get(job.id, actor)));
  if (maxActiveLookups > 3 || capacityStates.some((job) => job.status !== "completed")) {
    throw new Error(`ENRICHMENT_GLOBAL_WORKER_LEASE_OR_RECOVERY_MISMATCH active=${maxActiveLookups} firstWave=${firstWave.filter(Boolean).length} calls=${capacityCalls} states=${capacityStates.map((job) => job.status).join(",")}`);
  }

  const retryRow = await addRow({ nipRaw: makeValidNip(123460001) });
  const retryJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-job-retries", rowNumbers: [retryRow.rowNumber],
  }, actor);
  const { RegistryProviderError } = require("../dist/features/enrichment/public");
  let retryCalls = 0;
  const retryRunner = new RegistryEnrichmentJobRunner({
    async lookupByNip() { retryCalls += 1; throw new RegistryProviderError("RATE_LIMITED", "synthetic throttle", 3_600); },
  });
  const retryWorkerId = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!await retryRunner.processOne(retryWorkerId)) throw new Error("ENRICHMENT_RETRY_ITEM_NOT_CLAIMED");
    if (attempt < 2) {
      await models.EnrichmentJobItem.update({ nextAttemptAt: new Date(Date.now() - 1) }, { where: { jobId: retryJob.id } });
    }
  }
  const cooldownClaimed = await retryRunner.processOne(retryWorkerId);
  const retryState = await jobs.get(retryJob.id, actor);
  const retryItems = await jobs.listItems(retryJob.id, undefined, actor);
  if (cooldownClaimed || retryCalls !== 3 || retryState.status !== "processing" || retryItems.items[0]?.status !== "pending"
    || retryItems.items[0]?.attemptCount !== 3 || retryItems.items[0]?.errorCode !== "RATE_LIMITED"
    || !(retryItems.items[0]?.nextAttemptAt instanceof Date)) {
    throw new Error(`ENRICHMENT_PROVIDER_RETRY_BOUND_MISMATCH calls=${retryCalls} status=${retryState.status} itemStatus=${retryItems.items[0]?.status} attempts=${retryItems.items[0]?.attemptCount} error=${retryItems.items[0]?.errorCode} next=${retryItems.items[0]?.nextAttemptAt?.toISOString?.() ?? String(retryItems.items[0]?.nextAttemptAt)}`);
  }

  const noProviderRow = await addRow();
  const noProviderJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-job-no-provider", rowNumbers: [noProviderRow.rowNumber],
  }, actor);
  const noProviderRunner = new RegistryEnrichmentJobRunner(null);
  if (await noProviderRunner.processOne(randomUUID())) throw new Error("ENRICHMENT_DISABLED_PROVIDER_CLAIMED_JOB");
  const noProviderState = await jobs.get(noProviderJob.id, actor);
  const noProviderItems = await jobs.listItems(noProviderJob.id, undefined, actor);
  if (noProviderState.status !== "queued" || noProviderItems.items[0]?.status !== "pending" || noProviderItems.items[0]?.errorCode !== null) {
    throw new Error("ENRICHMENT_DISABLED_PROVIDER_DID_NOT_LEAVE_JOB_QUEUED");
  }
  await jobs.cancel(noProviderJob.id, { expectedVersion: noProviderState.version }, actor);

  smokeStage = "enrichment_live_authorization_fence";
  const operatorId = randomUUID();
  const operatorName = `Synthetic.Registry.Operator.${operatorId.slice(0, 8)}`;
  const authNow = new Date();
  const batch = await models.ImportBatch.findByPk(tenantScopeSeed.goldis.batchId);
  if (!batch) throw new Error("ENRICHMENT_AUTHORIZATION_FIXTURE_BATCH_MISSING");
  await models.User.create({
    userId: operatorId, username: operatorName, usernameNormalized: operatorName.toLowerCase(),
    passwordHash: "synthetic-password-hash-0123456789abcdef", status: "active", createdAt: authNow, updatedAt: authNow,
    lastLoginAt: null, mustChangePassword: false,
  });
  await models.TenantMembership.create({
    tenantId: tenantScopeSeed.goldisTenantId, userId: operatorId, role: "operator", status: "active", createdAt: authNow, updatedAt: authNow,
  });
  await models.ToolGrant.create({
    tenantId: tenantScopeSeed.goldisTenantId, toolId: batch.toolId, userId: operatorId,
    canDiscover: true, canExecute: true, canViewResults: false, canDownloadResults: false,
    grantedBy: tenantScopeSeed.goldisActorId, createdAt: authNow, updatedAt: authNow, version: 1,
  });
  await models.ImportBatch.update({ ownerUserId: operatorId }, { where: { id: batch.id } });
  const operator = { tenantId: tenantScopeSeed.goldisTenantId, userId: operatorId, role: "operator" };
  const revokeBeforeRow = await addRow({ nipRaw: makeValidNip(124010001) });
  const revokeBeforeJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-grant-revoked-before-claim", rowNumbers: [revokeBeforeRow.rowNumber],
  }, operator);
  await models.ToolGrant.update({ canExecute: false, version: 2, updatedAt: new Date() }, {
    where: { tenantId: operator.tenantId, userId: operator.userId, toolId: batch.toolId },
  });
  let revokedBeforeProviderCalls = 0;
  const revokedBeforeRunner = new RegistryEnrichmentJobRunner({
    async lookupByNip() { revokedBeforeProviderCalls += 1; throw new Error("REVOKED_JOB_MUST_NOT_LOOKUP"); },
  });
  if (await revokedBeforeRunner.processOne(randomUUID())) throw new Error("ENRICHMENT_REVOKED_JOB_WAS_CLAIMED");
  const revokedBeforeState = await jobs.get(revokeBeforeJob.id, actor);
  const revokedBeforeItems = await jobs.listItems(revokeBeforeJob.id, undefined, actor);
  const revokedBeforeSource = await models.SourceRow.findByPk(revokeBeforeRow.id);
  if (revokedBeforeProviderCalls !== 0 || revokedBeforeState.status !== "completed"
    || revokedBeforeState.errorCode !== "EXECUTION_PERMISSION_REVOKED"
    || revokedBeforeItems.items[0]?.reasonCode !== "EXECUTION_PERMISSION_REVOKED"
    || revokedBeforeSource?.effectiveRegon !== null) {
    throw new Error("ENRICHMENT_REVOKED_BEFORE_CLAIM_DID_NOT_FAIL_CLOSED");
  }

  await models.ToolGrant.update({ canExecute: true, version: 3, updatedAt: new Date() }, {
    where: { tenantId: operator.tenantId, userId: operator.userId, toolId: batch.toolId },
  });
  const revokeDuringRow = await addRow({ nipRaw: makeValidNip(124010002) });
  const revokeDuringJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-grant-revoked-in-flight", rowNumbers: [revokeDuringRow.rowNumber],
  }, operator);
  let revokedDuringProviderCalls = 0;
  const revokeDuringRunner = new RegistryEnrichmentJobRunner({
    async lookupByNip(nip) {
      revokedDuringProviderCalls += 1;
      await models.ToolGrant.update({ canExecute: false, version: 4, updatedAt: new Date() }, {
        where: { tenantId: operator.tenantId, userId: operator.userId, toolId: batch.toolId },
      });
      return {
        providerName: "synthetic-registry", providerVersion: "fixture-auth-fence-1", dataVersion: "synthetic-release-1",
        fetchedAt: new Date(), candidates: [{ nip, regon: "987654321", name: "Synthetic Enrichment Company" }],
      };
    },
  });
  if (!await revokeDuringRunner.processOne(randomUUID())) throw new Error("ENRICHMENT_IN_FLIGHT_AUTH_FIXTURE_NOT_CLAIMED");
  const revokedDuringState = await jobs.get(revokeDuringJob.id, actor);
  const revokedDuringItems = await jobs.listItems(revokeDuringJob.id, undefined, actor);
  const revokedDuringSource = await models.SourceRow.findByPk(revokeDuringRow.id);
  if (revokedDuringProviderCalls !== 1 || revokedDuringState.status !== "completed"
    || revokedDuringItems.items[0]?.reasonCode !== "EXECUTION_PERMISSION_REVOKED"
    || revokedDuringSource?.effectiveRegon !== null || revokedDuringSource?.rowVersion !== 1) {
    throw new Error("ENRICHMENT_REVOKED_DURING_LOOKUP_WROTE_RESULT");
  }
  await models.ToolGrant.update({ canExecute: true, version: 5, updatedAt: new Date() }, {
    where: { tenantId: operator.tenantId, userId: operator.userId, toolId: batch.toolId },
  });

  const disabledUserRow = await addRow({ nipRaw: makeValidNip(124010003) });
  const disabledUserJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-account-disabled-before-claim", rowNumbers: [disabledUserRow.rowNumber],
  }, operator);
  await models.User.update({ status: "disabled", updatedAt: new Date() }, { where: { userId: operatorId } });
  let disabledUserProviderCalls = 0;
  const disabledUserRunner = new RegistryEnrichmentJobRunner({
    async lookupByNip() { disabledUserProviderCalls += 1; throw new Error("DISABLED_ACCOUNT_MUST_NOT_LOOKUP"); },
  });
  if (await disabledUserRunner.processOne(randomUUID())) throw new Error("ENRICHMENT_DISABLED_ACCOUNT_WAS_CLAIMED");
  const disabledUserState = await jobs.get(disabledUserJob.id, actor);
  const disabledUserItems = await jobs.listItems(disabledUserJob.id, undefined, actor);
  if (disabledUserProviderCalls !== 0 || disabledUserState.errorCode !== "EXECUTION_PERMISSION_REVOKED"
    || disabledUserItems.items[0]?.reasonCode !== "EXECUTION_PERMISSION_REVOKED") {
    throw new Error("ENRICHMENT_DISABLED_ACCOUNT_DID_NOT_FAIL_CLOSED");
  }
  await models.User.update({ status: "active", updatedAt: new Date() }, { where: { userId: operatorId } });

  smokeStage = "enrichment_competing_worker_and_expired_lease_fence";
  const concurrentRow = await addRow({ nipRaw: makeValidNip(124010004) });
  const concurrentJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-same-job-competing-workers", rowNumbers: [concurrentRow.rowNumber],
  }, actor);
  let concurrentProviderCalls = 0;
  const concurrentRunner = new RegistryEnrichmentJobRunner({
    async lookupByNip(nip) {
      concurrentProviderCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { providerName: "synthetic-registry", providerVersion: "fixture-race-1", dataVersion: "synthetic-race",
        fetchedAt: new Date(), candidates: [{ nip, name: "Synthetic Enrichment Company", regon: "987654321" }] };
    },
  });
  const concurrentWorkerIds = [randomUUID(), randomUUID()];
  const concurrentResults = await Promise.all(concurrentWorkerIds.map((id) => concurrentRunner.processOne(id)));
  const concurrentAfter = await models.SourceRow.findByPk(concurrentRow.id);
  if (concurrentResults.filter(Boolean).length !== 1 || concurrentProviderCalls !== 1
    || (await jobs.get(concurrentJob.id, actor)).status !== "completed"
    || concurrentAfter?.rowVersion !== 2) {
    throw new Error("ENRICHMENT_COMPETING_WORKERS_PROCESSED_ITEM_MORE_THAN_ONCE");
  }

  const staleRow = await addRow({ nipRaw: makeValidNip(124010005) });
  const staleJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-expired-lease-fence", rowNumbers: [staleRow.rowNumber],
  }, actor);
  let staleProviderCalls = 0;
  let markFirstLookupEntered;
  let releaseFirstLookup;
  const firstLookupEntered = new Promise((resolve) => { markFirstLookupEntered = resolve; });
  const firstLookupResult = new Promise((resolve) => { releaseFirstLookup = resolve; });
  const firstRegon = makeValidRegon(81234567);
  const recoveredRegon = makeValidRegon(81234568);
  const staleLeaseProvider = {
    async lookupByNip(nip) {
      staleProviderCalls += 1;
      if (staleProviderCalls === 1) {
        markFirstLookupEntered();
        return firstLookupResult;
      }
      return { providerName: "synthetic-registry", providerVersion: "fixture-fence-2", dataVersion: "synthetic-fence",
        fetchedAt: new Date(), candidates: [{ nip, name: "Synthetic Enrichment Company", regon: recoveredRegon }] };
    },
  };
  const staleLeaseRunnerOne = new RegistryEnrichmentJobRunner(staleLeaseProvider);
  const staleLeaseRunnerTwo = new RegistryEnrichmentJobRunner(staleLeaseProvider);
  const staleWorkerId = randomUUID();
  const staleWorkerTask = staleLeaseRunnerOne.processOne(staleWorkerId);
  await firstLookupEntered;
  await models.EnrichmentJob.update({ leaseExpiresAt: new Date(Date.now() - 1_000) }, { where: { jobId: staleJob.id } });
  const recoveryWorkerId = randomUUID();
  if (!await staleLeaseRunnerTwo.processOne(recoveryWorkerId)) throw new Error("ENRICHMENT_EXPIRED_LEASE_NOT_RECLAIMED");
  releaseFirstLookup({ providerName: "synthetic-registry", providerVersion: "fixture-fence-1", dataVersion: "synthetic-fence",
    fetchedAt: new Date(), candidates: [{ nip: staleRow.nipRaw, name: "Synthetic Enrichment Company", regon: firstRegon }] });
  await staleWorkerTask;
  const staleAfter = await models.SourceRow.findByPk(staleRow.id);
  const staleAudits = await models.RegistryEnrichmentAudit.count({ where: { sourceRowId: staleRow.id } });
  if (staleProviderCalls !== 2 || staleAfter?.effectiveRegon !== recoveredRegon || staleAfter.rowVersion !== 2 || staleAudits !== 1
    || (await jobs.get(staleJob.id, actor)).status !== "completed") {
    throw new Error("ENRICHMENT_EXPIRED_LEASE_STALE_RESULT_WROTE_OR_RECOVERY_FAILED");
  }
  console.log("ENRICHMENT_AUTHORIZATION_AND_FENCING_PASS grantRevokedBeforeClaim=true grantRevokedDuringLookup=true accountDisabled=true competingWorkers=1 staleLeaseRecovery=true staleResultWrites=0");

  smokeStage = "enrichment_real_batch_claim_and_nip_mapping";
  const batchRows = [];
  const expectedByNip = new Map();
  const usedBatchNips = new Set();
  for (let index = 0, seed = 124000000; index < 31; seed += 1) {
    const nip = makeValidNip(seed);
    if (usedBatchNips.has(nip)) continue;
    usedBatchNips.add(nip);
    const companyName = `Synthetic Batch Company ${index}`;
    const regon = makeValidRegon(81000000 + index);
    const row = await addRow({ nipRaw: nip, companyName });
    batchRows.push(row);
    expectedByNip.set(nip, { companyName, regon });
    index += 1;
  }
  const batchJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-real-batch-31", rowNumbers: batchRows.map((row) => row.rowNumber),
  }, actor);
  const actualBatches = [];
  const batchProvider = {
    async lookupByNip() { throw new Error("ENRICHMENT_BATCH_FELL_BACK_TO_SINGLE_LOOKUP"); },
    async lookupManyByNip(nips) {
      actualBatches.push([...nips]);
      return new Map([...nips].reverse().map((nip) => {
        const expected = expectedByNip.get(nip);
        if (!expected) throw new Error("ENRICHMENT_BATCH_RETURNED_UNREQUESTED_NIP");
        return [nip, { kind: "result", result: {
          providerName: "synthetic-registry", providerVersion: "fixture-batch-1", dataVersion: "synthetic-batch-release",
          fetchedAt: new Date("2026-10-07T12:00:00Z"), candidates: [{ nip, name: expected.companyName, regon: expected.regon }],
        } }];
      }));
    },
  };
  const batchRunner = new RegistryEnrichmentJobRunner(batchProvider);
  const batchWorkerId = randomUUID();
  if (!await batchRunner.processOne(batchWorkerId) || !await batchRunner.processOne(batchWorkerId)
    || await batchRunner.processOne(batchWorkerId)) throw new Error("ENRICHMENT_BATCH_RUNNER_DRAIN_MISMATCH");
  const batchState = await jobs.get(batchJob.id, actor);
  const batchItems = await jobs.listItems(batchJob.id, undefined, actor);
  const batchRowsAfter = await models.SourceRow.findAll({ where: { id: batchRows.map((row) => row.id) } });
  const batchSizes = actualBatches.map((items) => items.length).sort((left, right) => right - left);
  if (actualBatches.length !== 2 || batchSizes[0] !== 30 || batchSizes[1] !== 1
    || new Set(actualBatches.flat()).size !== 31
    || batchState.status !== "completed" || batchState.completedCount !== 31
    || batchItems.items.length !== 31 || batchItems.items.some((item) => item.status !== "matched")
    || batchRowsAfter.length !== 31 || batchRowsAfter.some((row) => row.effectiveRegon !== expectedByNip.get(row.nipRaw)?.regon)) {
    const returnedNips = new Set(actualBatches.flat());
    const missingNips = [...expectedByNip.keys()].filter((nip) => !returnedNips.has(nip));
    const itemProblems = batchItems.items.filter((item) => item.status !== "matched").map((item) => ({
      rowNumber: item.rowNumber, status: item.status, reasonCode: item.reasonCode, errorCode: item.errorCode,
    }));
    const rowProblems = batchRowsAfter.filter((row) => row.effectiveRegon !== expectedByNip.get(row.nipRaw)?.regon)
      .map((row) => ({ rowNumber: row.rowNumber, nip: row.nipRaw, expectedRegon: expectedByNip.get(row.nipRaw)?.regon ?? null, actualRegon: row.effectiveRegon }));
    throw new Error(`ENRICHMENT_BATCH_SIZE_MAPPING_OR_APPLICATION_MISMATCH requests=${actualBatches.length} sizes=${batchSizes.join(",")} uniqueNips=${returnedNips.size} status=${batchState.status} completed=${batchState.completedCount} items=${batchItems.items.length} itemStatuses=${new Set(batchItems.items.map((item) => item.status)).size} rows=${batchRowsAfter.length} missingNips=${JSON.stringify(missingNips)} itemProblems=${JSON.stringify(itemProblems)} rowProblems=${JSON.stringify(rowProblems)}`);
  }

  smokeStage = "enrichment_persistent_cache_hmac_and_restart";
  const { PersistentRegistryCacheProvider, PostgresRegistryResultCache } = require("../dist/features/enrichment/public");
  const cacheNips = batchRows.slice(0, 2).map((row) => row.nipRaw);
  const cacheKey = "ab".repeat(32);
  let cacheProviderCalls = 0;
  const cacheSourceProvider = {
    cacheNamespace: "synthetic-registry",
    async lookupByNip() { throw new Error("CACHE_TEST_EXPECTED_BATCH_LOOKUP"); },
    async lookupManyByNip(nips) {
      cacheProviderCalls += 1;
      return new Map(nips.map((nip) => {
        const expected = expectedByNip.get(nip);
        return [nip, { kind: "result", result: {
          providerName: "synthetic-registry", providerVersion: "fixture-cache-1", dataVersion: "synthetic-cache-release",
          fetchedAt: new Date(), candidates: [{ nip, name: expected.companyName, regon: expected.regon, unnecessaryRawField: "must-not-persist" }],
        } }];
      }));
    },
  };
  const persistentCache = new PostgresRegistryResultCache(cacheKey);
  const firstCacheProvider = new PersistentRegistryCacheProvider(cacheSourceProvider, persistentCache);
  const firstCacheResults = await firstCacheProvider.lookupManyByNip(cacheNips);
  if (cacheProviderCalls !== 1 || cacheNips.some((nip) => firstCacheResults.get(nip)?.kind !== "result")) {
    throw new Error("ENRICHMENT_PERSISTENT_CACHE_INITIAL_LOOKUP_MISMATCH");
  }
  const cacheRows = await sequelize.query(
    "SELECT nip_hash, result_payload FROM registry_result_cache WHERE provider_name = $1 AND data_day = $2",
    { bind: ["synthetic-registry", require("../dist/shared/warsaw-time").dateStringInWarsaw(new Date())] },
  );
  const cacheRecords = cacheRows[0];
  const cacheRawNipFound = cacheRecords.some((record) => cacheNips.some((nip) =>
    record.nip_hash === nip || JSON.stringify(record.result_payload).includes(nip)));
  const cacheExtraFieldFound = cacheRecords.some((record) => JSON.stringify(record.result_payload).includes("unnecessaryRawField"));
  if (cacheRecords.length !== cacheNips.length || cacheRawNipFound || cacheExtraFieldFound) {
    throw new Error(`ENRICHMENT_PERSISTENT_CACHE_STORED_RAW_OR_UNMINIMIZED_DATA rows=${cacheRecords.length} expected=${cacheNips.length} rawNip=${cacheRawNipFound} extraField=${cacheExtraFieldFound} payloadKeys=${JSON.stringify(cacheRecords.slice(0, 1).map((record) => Object.keys(record.result_payload ?? {})))}`);
  }
  const restartProvider = {
    cacheNamespace: "synthetic-registry",
    async lookupByNip() { throw new Error("ENRICHMENT_PERSISTENT_CACHE_RESTART_MISSED"); },
    async lookupManyByNip() { cacheProviderCalls += 1; throw new Error("ENRICHMENT_PERSISTENT_CACHE_RESTART_MISSED"); },
  };
  const afterRestart = new PersistentRegistryCacheProvider(restartProvider, new PostgresRegistryResultCache(cacheKey));
  const restartResults = await afterRestart.lookupManyByNip(cacheNips);
  if (cacheProviderCalls !== 1 || cacheNips.some((nip) => restartResults.get(nip)?.kind !== "result"
    || restartResults.get(nip).result.candidates[0]?.nip !== nip)) {
    throw new Error("ENRICHMENT_PERSISTENT_CACHE_RESTART_REUSE_MISMATCH");
  }

  const cancelRow = await addRow();
  const cancelJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-job-cancel", rowNumbers: [cancelRow.rowNumber],
  }, actor);
  let staleCancelStatus = null;
  try { await jobs.cancel(cancelJob.id, { expectedVersion: cancelJob.version + 1 }, actor); }
  catch (error) { staleCancelStatus = error?.getStatus?.() ?? null; }
  const cancelled = await jobs.cancel(cancelJob.id, { expectedVersion: cancelJob.version }, actor);
  if (staleCancelStatus !== 409 || cancelled.status !== "cancelled" || cancelled.cancelledCount !== 1
    || await noProviderRunner.processOne(randomUUID())) {
    throw new Error("ENRICHMENT_JOB_CANCEL_CAS_MISMATCH");
  }

  const runRow = await addRow({ rowNumber: 18350 });
  await models.AutomationRun.create({
    id: randomUUID(), batchId: tenantScopeSeed.goldis.batchId, sourceRowId: runRow.id, rowNumber: runRow.rowNumber,
    toolId: "oc-policy-verification", status: "failed", currentStep: "failed", referenceDate: "2026-09-30",
    inputSnapshot: { schemaVersion: 1, sourceRowId: runRow.id, rowNumber: runRow.rowNumber, rowVersion: runRow.rowVersion,
      companyName: runRow.companyName, decisionMakerName: runRow.decisionMakerName, nipRaw: runRow.nipRaw,
      address: runRow.address, postalCode: runRow.postalCode, city: runRow.city, countyCode: null,
      regonRaw: runRow.regonRaw, regon: runRow.regon, effectiveRegon: runRow.effectiveRegon, issues: runRow.issues },
    errorCode: null, createdAt: new Date(), updatedAt: new Date(),
  });
  const blockedJob = await jobs.start(tenantScopeSeed.goldis.batchId, {
    idempotencyKey: "synthetic-enrichment-job-run-block", rowNumbers: [runRow.rowNumber],
  }, actor);
  const blockedItems = await jobs.listItems(blockedJob.id, undefined, actor);
  if (blockedItems.items[0]?.status !== "excluded" || blockedItems.items[0]?.reasonCode !== "RUN_EXISTS") {
    throw new Error("ENRICHMENT_JOB_RUN_IDENTITY_WAS_NOT_BLOCKED");
  }

  const jobRows = await models.EnrichmentJob.findAll({ where: { jobId: [created.id, noProviderJob.id, cancelJob.id] } });
  const itemRows = await models.EnrichmentJobItem.findAll({ where: { jobId: [created.id, noProviderJob.id, cancelJob.id] } });
  const durablePayload = JSON.stringify({ jobs: jobRows.map((job) => job.toJSON()), items: itemRows.map((item) => item.toJSON()) });
  if (durablePayload.includes("1234563218") || durablePayload.includes("Synthetic Enrichment Company") || durablePayload.includes("candidates")) {
    throw new Error("ENRICHMENT_JOB_PERSISTED_RAW_SOURCE_OR_PROVIDER_DATA");
  }
  console.log("ENRICHMENT_JOB_SMOKE_PASS idempotency=true tenantRead=404 sameNipLookupDedup=true grouping=true rateLimitCooldown=true batchSizes=30,1 mappingByNip=true persistentCacheRestart=true rawNipStored=false cachePayloadMinimal=true disabledProviderLeavesQueued=true cancelCAS=true runIdentity=blocked rawQueueScan=clean");
}

async function verifyRunSubmissionFlows() {
  smokeStage = "run_submission_preview_persistence_dispatch";
  const models = require("../dist/infrastructure/database/db");
  const { RunSubmissionService } = require("../dist/features/submissions/run-submissions.service");
  const { RunSubmissionAdmissionService } = require("../dist/features/submissions/run-submission-admission.service");
  const { RunSubmissionAdmissionRepository } = require("../dist/features/submissions/run-submission-admission.repository");
  const { RunSubmissionCancellationRepository } = require("../dist/features/submissions/run-submission-cancellation.repository");
  const { RunSubmissionReadRepository } = require("../dist/features/submissions/run-submission-read.repository");
  const { RunSubmissionPreviewRepository } = require("../dist/features/submissions/run-submission-preview.repository");
  const { RunSubmissionAccessRepository } = require("../dist/features/submissions/run-submission-access.repository");
  const { RunSubmissionCreateRepository } = require("../dist/features/submissions/run-submission-create.repository");
  const { EntityGroupingService } = require("../dist/features/grouping/grouping.service");
  const { CanonicalRunService } = require("../dist/features/runs/canonical-run-service");
  const { ImportPreparationService } = require("../dist/features/preparations/index");
  const { ImportPreparationsRepository } = require("../dist/features/preparations/preparations.repository");
  const actor = { tenantId: tenantScopeSeed.goldisTenantId, actorUserId: tenantScopeSeed.goldisActorId };
  const grouping = new EntityGroupingService();
  const canonicalRuns = new CanonicalRunService();
  const runDispatch = {
    async ensureDispatchForAdmission(runId, transaction) {
      const unresolved = await models.RunDispatchOutbox.findOne({ where: { runId, status: ["pending", "publishing", "published"] }, transaction });
      if (unresolved) return unresolved;
      const now = new Date();
      return models.RunDispatchOutbox.create({ dispatchId: randomUUID(), runId, intentType: "create", status: "pending",
        attemptCount: 0, nextAttemptAt: now, claimedAt: null, claimedBy: null, lastErrorCode: null, createdAt: now, updatedAt: now }, { transaction });
    },
  };
  const admissionService = new RunSubmissionAdmissionService(
    canonicalRuns,
    runDispatch,
    new RunSubmissionAdmissionRepository(),
  );
  const service = new RunSubmissionService(
    grouping,
    new RunSubmissionReadRepository(),
    new RunSubmissionCancellationRepository(),
    new RunSubmissionPreviewRepository(),
    new RunSubmissionAccessRepository(),
    new RunSubmissionCreateRepository(),
  );
  const preparationService = new ImportPreparationService(
    createAuditService(),
    new ImportPreparationsRepository(models.sequelize),
  );
  let preparationSequence = 0;
  const prepareCurrentBatch = async () => {
    const totalRows = await models.SourceRow.count({ where: { batchId: tenantScopeSeed.goldis.batchId } });
    await models.ImportBatch.update({ totalRows }, { where: { id: tenantScopeSeed.goldis.batchId } });
    const preparation = await preparationService.start(tenantScopeSeed.goldis.batchId, {
      idempotencyKey: `synthetic-submission-prep-${String(++preparationSequence).padStart(4, "0")}`,
    }, { tenantId: actor.tenantId, userId: actor.actorUserId, role: "admin" });
    if (preparation.status === "queued" && !await preparationService.processOne()) {
      throw new Error("RUN_SUBMISSION_FIXTURE_PREPARATION_DID_NOT_RUN");
    }
    const result = await preparationService.get(tenantScopeSeed.goldis.batchId, preparation.preparationId,
      { tenantId: actor.tenantId, userId: actor.actorUserId, role: "admin" });
    if (!result.sealedAt || !["completed", "completed_with_attention"].includes(result.status)) {
      throw new Error(`RUN_SUBMISSION_FIXTURE_PREPARATION_NOT_SEALED_${result.status}`);
    }
    return result;
  };
  let rowNumber = 18400;
  const makeValidNip = (value) => {
    const prefix = String(value).padStart(9, "0").slice(-9);
    const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11;
    return checksum === 10 ? makeValidNip(value + 1) : `${prefix}${checksum}`;
  };
  const makeValidRegon = (seed) => {
    const weights = [8, 9, 2, 3, 4, 5, 6, 7];
    for (let candidate = seed; ; candidate += 1) {
      const prefix = String(candidate).padStart(8, "0").slice(-8);
      const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11 % 10;
      const regon = `${prefix}${checksum}`;
      if (require("@goldis/core").normalizeRegon(regon).normalized === regon) return regon;
    }
  };
  const addRow = async (overrides = {}) => models.SourceRow.create({
    id: randomUUID(), batchId: tenantScopeSeed.goldis.batchId, rowNumber: rowNumber++,
    companyName: "Synthetic Submission Company", decisionMakerName: "Synthetic Decision Maker", nipRaw: makeValidNip(526025000),
    address: "Synthetic", postalCode: "00-000", city: "Test City", regonRaw: "876543210", regon: "876543210",
    effectiveRegon: "876543210", rowVersion: 1, issues: [], ...overrides,
  });
  const first = await addRow();
  const duplicate = await addRow();
  const secondPerson = await addRow({ decisionMakerName: "Another Synthetic Decision Maker" });
  const reviewRow = await addRow({ companyName: "Synthetic Review Company", nipRaw: makeValidNip(526025099),
    regonRaw: "012345678", regon: "012345678", effectiveRegon: "012345678", decisionMakerName: null });
  await models.RegonCorrection.create({ correctionId: randomUUID(), sourceRowId: reviewRow.id, authorRef: "fixture-operator",
    reason: "Synthetic review fixture", previousRegon: null, proposedRegon: "012345678", status: "pending",
    reviewerRef: null, reviewedAt: null, reviewReason: null, createdAt: new Date() });
  const excluded = await addRow({ companyName: "Synthetic Excluded Company", nipRaw: makeValidNip(526025200),
    regonRaw: "", regon: null, effectiveRegon: null, issues: ["REGON_EMPTY"], decisionMakerName: null });
  const selection = { fromRow: first.rowNumber, toRow: excluded.rowNumber };
  const fixtureBatch = await models.ImportBatch.findByPk(tenantScopeSeed.goldis.batchId);
  if (!fixtureBatch || fixtureBatch.tenantId !== actor.tenantId || fixtureBatch.toolId !== "oc-policy-verification") {
    throw new Error(`RUN_SUBMISSION_FIXTURE_BATCH_SCOPE_MISMATCH_${JSON.stringify({
      batchId: tenantScopeSeed.goldis.batchId, batch: fixtureBatch?.toJSON() ?? null, actor,
    })}`);
  }
  const beforePreview = await models.SourceEntityLink.count({ where: { sourceRowId: [first.id, duplicate.id, secondPerson.id, reviewRow.id, excluded.id] } });
  smokeStage = "run_submission_initial_preview";
  await prepareCurrentBatch();
  const preview = await service.preview(tenantScopeSeed.goldis.batchId, selection, actor, "admin");
  const afterPreview = await models.SourceEntityLink.count({ where: { sourceRowId: [first.id, duplicate.id, secondPerson.id, reviewRow.id, excluded.id] } });
  if (beforePreview !== 0 || afterPreview !== 0 || preview.counts.selected !== 5 || preview.counts.ready !== 2
    || preview.counts.needsReview !== 1 || preview.counts.excluded !== 2 || preview.counts.uniqueGroups !== 2) {
    throw new Error(`RUN_SUBMISSION_PREVIEW_CLASSIFICATION_OR_READ_ONLY_MISMATCH_${JSON.stringify({ beforePreview, afterPreview, counts: preview.counts, states: preview.items.map((item) => [item.rowNumber, item.state, item.reasonCode]) })}`);
  }
  await models.SourceRow.update({ rowVersion: 2 }, { where: { id: first.id } });
  let stalePreviewStatus = null;
  smokeStage = "run_submission_stale_preview";
  try {
    await service.create(tenantScopeSeed.goldis.batchId, { ...selection, selectionFingerprint: preview.selectionFingerprint,
      idempotencyKey: "synthetic-submission-stale-preview" }, actor, "admin");
  } catch (error) { stalePreviewStatus = error?.getStatus?.() ?? null; }
  if (stalePreviewStatus !== 409 || await models.RunSubmission.count({ where: { idempotencyKey: "synthetic-submission-stale-preview" } })) {
    throw new Error("RUN_SUBMISSION_STALE_PREVIEW_WAS_NOT_REJECTED_ATOMICALLY");
  }
  smokeStage = "run_submission_current_preview";
  await prepareCurrentBatch();
  const currentPreview = await service.preview(tenantScopeSeed.goldis.batchId, selection, actor, "admin");
  const input = { ...selection, selectionFingerprint: currentPreview.selectionFingerprint,
    idempotencyKey: "synthetic-submission-main-key-01" };
  smokeStage = "run_submission_persisted_create";
  const created = await service.create(tenantScopeSeed.goldis.batchId, input, actor, "admin");
  const persistedSubmission = await models.RunSubmission.findByPk(created.submissionId);
  const persistedBatch = persistedSubmission ? await models.ImportBatch.findByPk(persistedSubmission.importBatchId) : null;
  if (!persistedSubmission || !persistedBatch || persistedSubmission.tenantId !== actor.tenantId
    || persistedSubmission.importBatchId !== tenantScopeSeed.goldis.batchId
    || persistedBatch.tenantId !== actor.tenantId || persistedBatch.toolId !== "oc-policy-verification") {
    throw new Error(`RUN_SUBMISSION_FIXTURE_PERSISTED_SCOPE_MISMATCH_${JSON.stringify({
      submission: persistedSubmission?.toJSON() ?? null, batch: persistedBatch?.toJSON() ?? null, actor,
    })}`);
  }
  smokeStage = "run_submission_direct_get_after_create";
  await service.get(created.submissionId, actor, "admin");
  smokeStage = "run_submission_idempotency_replay";
  const replay = await service.create(tenantScopeSeed.goldis.batchId, input, actor, "admin");
  smokeStage = "run_submission_post_replay_contracts";
  let changedKeyStatus = null;
  try { await service.create(tenantScopeSeed.goldis.batchId, { rowNumbers: [first.rowNumber], selectionFingerprint: currentPreview.selectionFingerprint,
    idempotencyKey: input.idempotencyKey }, actor, "admin"); }
  catch (error) { changedKeyStatus = error?.getStatus?.() ?? null; }
  let crossTenantStatus = null;
  try { await service.get(created.submissionId, { tenantId: tenantScopeSeed.otherTenantId, actorUserId: tenantScopeSeed.otherActorId }, "admin"); }
  catch (error) { crossTenantStatus = error?.getStatus?.() ?? null; }
  const items = await service.listItems(created.submissionId, undefined, actor, "admin");
  const storedItems = await models.RunSubmissionItem.findAll({ where: { submissionId: created.submissionId } });
  const storedGroups = await models.RunSubmissionGroup.findAll({ where: { submissionId: created.submissionId } });
  if (created.submissionId !== replay.submissionId || changedKeyStatus !== 409 || crossTenantStatus !== 404
    || items.items.length !== 5 || storedItems.length !== 5 || storedGroups.length !== 2
    || storedItems.filter((item) => item.preparationState === "ready").length !== 2
    || storedItems.filter((item) => item.preparationState === "review").length !== 1
    || storedItems.filter((item) => item.preparationState === "excluded").length !== 2) {
    throw new Error("RUN_SUBMISSION_IDEMPOTENCY_SCOPE_OR_PERSISTENCE_MISMATCH");
  }

  const settings = await models.ToolSettings.findOne({ where: { tenantId: actor.tenantId, toolId: "oc-policy-verification" } });
  if (!settings) throw new Error("RUN_SUBMISSION_SETTINGS_MISSING");
  const [baselineRows] = await sequelize.query(
    `SELECT count(*)::int AS count FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
      WHERE b.tenant_id = $1 AND b.tool_id = 'oc-policy-verification' AND r.created_at >= now() - interval '60 minutes'`,
    { bind: [actor.tenantId] },
  );
  const baseline = baselineRows[0].count;
  await models.ToolSettings.update({ maxNewRunsPerHour: baseline + 1, enabledForNewRuns: true }, {
    where: { tenantId: actor.tenantId, toolId: settings.toolId },
  });
  smokeStage = "run_submission_first_dispatch";
  await admissionService.dispatchPendingOnce();
  smokeStage = "run_submission_dispatch_retry";
  await admissionService.dispatchPendingOnce();
  let accepted = await models.RunSubmissionGroup.findAll({ where: { submissionId: created.submissionId, admissionState: "accepted" } });
  let waiting = await models.RunSubmissionGroup.findAll({ where: { submissionId: created.submissionId, admissionState: "waiting_capacity" } });
  if (accepted.length !== 1 || waiting.length !== 1 || !accepted[0].runId) {
    const allGroups = await models.RunSubmissionGroup.findAll({ where: { submissionId: created.submissionId },
      attributes: ["groupId", "admissionState", "reasonCode", "runId", "nextAttemptAt", "leaseOwner"] });
    const currentSettings = await models.ToolSettings.findOne({ where: { tenantId: actor.tenantId, toolId: settings.toolId } });
    throw new Error(`RUN_SUBMISSION_SHARED_HOURLY_LIMIT_NOT_ENFORCED_${JSON.stringify({ accepted: accepted.length, waiting: waiting.length,
      groups: allGroups.map((group) => group.toJSON()), limit: currentSettings?.maxNewRunsPerHour, baseline, now: new Date().toISOString() })}`);
  }
  const acceptedRunId = accepted[0].runId;
  const outbox = await models.RunDispatchOutbox.findAll({ where: { runId: acceptedRunId, intentType: "create" } });
  const sourceLinks = await models.RunSourceRow.findAll({ where: { runId: acceptedRunId } });
  const acceptedItems = await models.RunSubmissionItem.findAll({ where: { groupId: accepted[0].groupId } });
  const linkedSourceIds = new Set(sourceLinks.map((row) => row.sourceRowId));
  if (outbox.length !== 1 || acceptedItems.length < 1 || sourceLinks.length < acceptedItems.length
    || acceptedItems.some((item) => !linkedSourceIds.has(item.sourceRowId))) {
    throw new Error(`RUN_SUBMISSION_ADMISSION_OUTBOX_OR_MEMBER_ROWS_MISMATCH_${JSON.stringify({
      outboxCount: outbox.length, acceptedItemCount: acceptedItems.length, runMemberCount: sourceLinks.length,
      acceptedItemsLinked: acceptedItems.every((item) => linkedSourceIds.has(item.sourceRowId)),
    })}`);
  }
  await models.ToolSettings.update({ maxNewRunsPerHour: baseline + 2 }, { where: { tenantId: actor.tenantId, toolId: settings.toolId } });
  await models.RunSubmissionGroup.update({ nextAttemptAt: new Date(Date.now() - 1) }, { where: { groupId: waiting[0].groupId } });
  smokeStage = "run_submission_terminal_replay";
  await admissionService.dispatchPendingOnce();
  accepted = await models.RunSubmissionGroup.findAll({ where: { submissionId: created.submissionId, admissionState: "accepted" } });
  if (accepted.length !== 2 || accepted.some((group) => !group.runId)) throw new Error("RUN_SUBMISSION_CAPACITY_RETRY_MISMATCH");
  await models.AutomationRun.update({ status: "failed", currentStep: "failed", errorCode: "SYNTHETIC_TERMINAL" }, { where: { id: acceptedRunId } });
  const runCountBeforeTerminalReplay = await models.AutomationRun.count({ where: { batchId: tenantScopeSeed.goldis.batchId,
    canonicalEntityId: accepted[0].canonicalEntityId } });
  await admissionService.dispatchPendingOnce();
  const acceptedAfterTerminal = await models.RunSubmissionGroup.findByPk(accepted[0].groupId);
  const runCountAfterTerminalReplay = await models.AutomationRun.count({ where: { batchId: tenantScopeSeed.goldis.batchId,
    canonicalEntityId: accepted[0].canonicalEntityId } });
  if (acceptedAfterTerminal?.runId !== acceptedRunId || runCountAfterTerminalReplay !== runCountBeforeTerminalReplay) {
    throw new Error("RUN_SUBMISSION_TERMINAL_REPLAY_CREATED_NEW_RUN");
  }
  smokeStage = "run_submission_summary";
  const summary = await service.get(created.submissionId, actor, "admin");
  if (summary.counts.selectedRows !== 5 || summary.counts.uniqueGroups !== 2
    || Object.values(summary.counts.items).reduce((total, count) => total + count, 0) !== 5) {
    throw new Error("RUN_SUBMISSION_ITEM_COUNTS_DO_NOT_RECONCILE");
  }

  const cancelRow = await addRow({ companyName: "Synthetic Cancel Company", nipRaw: makeValidNip(526025300), regonRaw: "543210987",
    regon: "543210987", effectiveRegon: "543210987", decisionMakerName: null });
  const cancelSelection = { rowNumbers: [cancelRow.rowNumber] };
  smokeStage = "run_submission_cancel_preview";
  await prepareCurrentBatch();
  const cancelPreview = await service.preview(tenantScopeSeed.goldis.batchId, cancelSelection, actor, "admin");
  smokeStage = "run_submission_cancel_create";
  const cancellable = await service.create(tenantScopeSeed.goldis.batchId, { ...cancelSelection,
    selectionFingerprint: cancelPreview.selectionFingerprint, idempotencyKey: "synthetic-submission-cancel-key" }, actor, "admin");
  let staleCancelStatus = null;
  smokeStage = "run_submission_cancel_stale_version";
  try { await service.cancel(cancellable.submissionId, cancellable.version + 1, actor, "admin"); }
  catch (error) { staleCancelStatus = error?.getStatus?.() ?? null; }
  smokeStage = "run_submission_cancel_commit";
  const cancelled = await service.cancel(cancellable.submissionId, cancellable.version, actor, "admin");
  const cancelledGroups = await models.RunSubmissionGroup.findAll({ where: { submissionId: cancellable.submissionId } });
  if (staleCancelStatus !== 409 || cancelled.status !== "cancelled" || cancelledGroups.length !== 1
    || cancelledGroups[0].admissionState !== "cancelled" || cancelledGroups[0].runId !== null) {
    throw new Error("RUN_SUBMISSION_CANCEL_CAS_OR_UNADMITTED_GROUP_MISMATCH");
  }

  const capacityRow = await addRow({ companyName: "Synthetic Single Run Company", nipRaw: makeValidNip(526025400), regonRaw: "432109876",
    regon: "432109876", effectiveRegon: "432109876", decisionMakerName: null });
  await prepareCurrentBatch();
  const outcome = await grouping.resolveRelatedRows(tenantScopeSeed.goldis.batchId, capacityRow.rowNumber);
  const selected = outcome.find((item) => item.rowNumber === capacityRow.rowNumber);
  if (!selected || selected.status !== "linked") throw new Error("RUN_SUBMISSION_SINGLE_LIMIT_FIXTURE_NOT_LINKED");
  const [singleEntity] = await models.SourceEntityLink.findAll({ where: { sourceRowId: capacityRow.id } });
  const singleCanonical = await models.CanonicalEntity.findByPk(singleEntity.canonicalEntityId);
  const singleLead = require("../dist/features/runs/canonical-run-service").createLeadIdentityKey(singleCanonical.canonicalEntityId, capacityRow.decisionMakerName);
  let singleLimitStatus = null;
  try {
    await canonicalRuns.createOrGet(tenantScopeSeed.goldis.batchId, singleCanonical.canonicalEntityId, singleLead,
      [capacityRow], actor, undefined, { referenceDate: require("@goldis/core").todayInWarsaw() });
  } catch (error) { singleLimitStatus = error?.status ?? error?.getStatus?.() ?? null; }
  if (singleLimitStatus !== 429) throw new Error("SINGLE_AND_BATCH_RUNS_DID_NOT_SHARE_HOURLY_LIMIT");

  const rollbackRow = await addRow({ companyName: "Synthetic Audit Rollback Company", nipRaw: makeValidNip(526025500), regonRaw: "321098765",
    regon: "321098765", effectiveRegon: "321098765", decisionMakerName: null });
  const rollbackSelection = { rowNumbers: [rollbackRow.rowNumber] };
  await prepareCurrentBatch();
  const rollbackPreview = await service.preview(tenantScopeSeed.goldis.batchId, rollbackSelection, actor, "admin");
  await sequelize.query(`CREATE OR REPLACE FUNCTION reject_run_submission_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'run.submission.created' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
  await sequelize.query("CREATE TRIGGER reject_run_submission_audit_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_run_submission_audit()");
  let auditFailureObserved = false;
  try { await service.create(tenantScopeSeed.goldis.batchId, { ...rollbackSelection, selectionFingerprint: rollbackPreview.selectionFingerprint,
    idempotencyKey: "synthetic-submission-audit-rollback" }, actor, "admin"); }
  catch { auditFailureObserved = true; }
  finally {
    await sequelize.query("DROP TRIGGER IF EXISTS reject_run_submission_audit_trigger ON audit_events");
    await sequelize.query("DROP FUNCTION IF EXISTS reject_run_submission_audit()");
  }
  if (!auditFailureObserved || await models.RunSubmission.count({ where: { idempotencyKey: "synthetic-submission-audit-rollback" } })
    || await models.SourceEntityLink.findByPk(rollbackRow.id)) throw new Error("RUN_SUBMISSION_AUDIT_FAILURE_DID_NOT_ROLL_BACK_ATOMICALLY");

  smokeStage = "run_submission_manager_grant_revoked_before_dispatch";
  const { hashPassword } = require("../dist/features/auth/index");
  const managerId = randomUUID();
  const managerUsername = `Synthetic.Manager.Revocation.${randomUUID().slice(0, 8)}`;
  const managerNow = new Date();
  await models.User.create({ userId: managerId, username: managerUsername, usernameNormalized: managerUsername.toLowerCase(),
    passwordHash: await hashPassword("Synthetic-only manager revocation password!"), status: "active",
    createdAt: managerNow, updatedAt: managerNow, lastLoginAt: null });
  await models.TenantMembership.create({ tenantId: actor.tenantId, userId: managerId, role: "manager", status: "active",
    createdAt: managerNow, updatedAt: managerNow });
  const managerGrant = await models.ToolGrant.create({ tenantId: actor.tenantId, toolId: "oc-policy-verification", userId: managerId,
    canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false,
    grantedBy: actor.actorUserId, createdAt: managerNow, updatedAt: managerNow, version: 1 });
  const managerActor = { tenantId: actor.tenantId, actorUserId: managerId };
  const revokedGrantRegon = makeValidRegon(76543210);
  const revokedGrantRow = await addRow({ companyName: "Synthetic Revoked Manager Grant Company",
    decisionMakerName: "Revoked Grant Contact", nipRaw: makeValidNip(526026000), regonRaw: revokedGrantRegon,
    regon: revokedGrantRegon, effectiveRegon: revokedGrantRegon });
  await prepareCurrentBatch();
  const managerPreview = await service.preview(tenantScopeSeed.goldis.batchId, { rowNumbers: [revokedGrantRow.rowNumber] }, managerActor, "manager");
  if (managerPreview.counts.ready !== 1) throw new Error("MANAGER_REVOCATION_FIXTURE_ROW_NOT_READY");
  const managerSubmission = await service.create(tenantScopeSeed.goldis.batchId, {
    rowNumbers: [revokedGrantRow.rowNumber], selectionFingerprint: managerPreview.selectionFingerprint,
    idempotencyKey: `synthetic-manager-revoke-${randomUUID().slice(0, 12)}`,
  }, managerActor, "manager");
  const managerGroup = await models.RunSubmissionGroup.findOne({ where: { submissionId: managerSubmission.submissionId } });
  if (!managerGroup || managerGroup.admissionState !== "pending" || managerGroup.runId) {
    throw new Error("MANAGER_REVOCATION_FIXTURE_GROUP_NOT_PENDING");
  }
  const leasedGroupId = await admissionService.admissionRepository.claim(admissionService.dispatcherId);
  if (leasedGroupId !== managerGroup.groupId) throw new Error("MANAGER_REVOCATION_FIXTURE_DISPATCH_LEASE_MISMATCH");
  await managerGrant.update({ canExecute: false, version: managerGrant.version + 1, updatedAt: new Date() });
  await admissionService.admit(leasedGroupId);
  const revokedGroup = await models.RunSubmissionGroup.findByPk(managerGroup.groupId);
  const revokedSubmissionRunCount = await models.AutomationRun.count({ where: {
    batchId: tenantScopeSeed.goldis.batchId, canonicalEntityId: managerGroup.canonicalEntityId,
  } });
  const revokedSubmissionOutboxCount = await sequelize.query(
    `SELECT count(*)::int AS count FROM run_dispatch_outbox dispatch
       JOIN automation_runs run ON run.id = dispatch.run_id
      WHERE run.batch_id = :batchId AND run.canonical_entity_id = :canonicalEntityId`,
    { replacements: { batchId: tenantScopeSeed.goldis.batchId, canonicalEntityId: managerGroup.canonicalEntityId }, type: QueryTypes.SELECT },
  );
  if (revokedGroup?.admissionState !== "blocked" || revokedGroup.reasonCode !== "EXECUTE_ACCESS_REVOKED"
    || revokedGroup.runId !== null || revokedGroup.leaseOwner !== null || revokedGroup.leaseExpiresAt !== null
    || revokedSubmissionRunCount !== 0 || Number(revokedSubmissionOutboxCount[0]?.count ?? 0) !== 0) {
    throw new Error(`MANAGER_GRANT_REVOCATION_DID_NOT_BLOCK_PENDING_DISPATCH_${JSON.stringify({
      state: revokedGroup?.admissionState, reason: revokedGroup?.reasonCode, runId: revokedGroup?.runId,
      runCount: revokedSubmissionRunCount, outboxCount: revokedSubmissionOutboxCount[0]?.count,
    })}`);
  }
  await managerGrant.update({ canExecute: true, version: managerGrant.version + 1, updatedAt: new Date() });
  await admissionService.dispatchPendingOnce();
  const stillBlocked = await models.RunSubmissionGroup.findByPk(managerGroup.groupId);
  if (stillBlocked?.admissionState !== "blocked" || stillBlocked.runId !== null) {
    throw new Error("MANAGER_GRANT_REENABLE_MUST_NOT_SILENTLY_RESUME_BLOCKED_SUBMISSION");
  }
  const rawRows = await models.RunSubmissionItem.findAll({ where: { submissionId: created.submissionId } });
  const rawGroups = await models.RunSubmissionGroup.findAll({ where: { submissionId: created.submissionId } });
  const durablePayload = JSON.stringify({ items: rawRows.map((item) => item.toJSON()), groups: rawGroups.map((group) => group.toJSON()) });
  if (durablePayload.includes("1234563218") || durablePayload.includes("Synthetic Submission Company") || durablePayload.includes("Synthetic Decision Maker")) {
    throw new Error("RUN_SUBMISSION_QUEUE_PERSISTED_SOURCE_DATA");
  }
  console.log("RUN_SUBMISSION_SMOKE_PASS previewReadOnly=true fingerprintCAS=true mixedRows=true idempotency=true tenantRead=404 sharedRunLimit=true pauseAndCapacityReady=true outboxAtomic=true cancelCAS=true terminalNoReplay=true auditRollback=true managerGrantRevokedAfterLeaseBlocksAdmission=true noRunOrOutboxOnRevocation=true regrantDoesNotAutoResume=true rawQueueScan=clean");
}

async function verifyPreparedSetExecutionFlows() {
  smokeStage = "prepared_set_chunk_orchestration";
  const models = require("../dist/infrastructure/database/db");
  const { ImportPreparationService } = require("../dist/features/preparations/index");
  const { ImportPreparationsRepository } = require("../dist/features/preparations/preparations.repository");
  const { PreparedSetExecutionService } = require("../dist/features/submissions/prepared-set-executions.service");
  const { PreparedSetExecutionRepository } = require("../dist/features/submissions/prepared-set-execution.repository");
  const { PreparedSetExecutionControlRepository } = require("../dist/features/submissions/prepared-set-execution-control.repository");
  const actor = { tenantId: tenantScopeSeed.goldisTenantId, userId: tenantScopeSeed.goldisActorId, role: "admin" };
  const batchId = randomUUID();
  const startRowNumber = 2;
  await models.ImportBatch.create({ id: batchId, tenantId: actor.tenantId, ownerUserId: actor.userId,
    toolId: "oc-policy-verification", fileName: "synthetic-prepared-set-1201.xlsx", sha256: "c".repeat(64),
    totalRows: 1201, invalidRows: 0, createdAt: new Date() });
  const rows = Array.from({ length: 1201 }, (_, index) => {
    let nipValue = 720_000_000 + index * 10;
    let nipPrefix = "";
    let nipChecksum = 10;
    const nipWeights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    while (nipChecksum === 10) {
      nipPrefix = String(nipValue).padStart(9, "0").slice(-9);
      nipChecksum = nipWeights.reduce((sum, weight, digit) => sum + weight * Number(nipPrefix[digit]), 0) % 11;
      if (nipChecksum === 10) nipValue += 1;
    }
    const nip = `${nipPrefix}${nipChecksum}`;
    const regonPrefix = String(620_000_000 + index).padStart(8, "0").slice(-8);
    const regonWeights = [8, 9, 2, 3, 4, 5, 6, 7];
    const regonSum = regonWeights.reduce((sum, weight, digit) => sum + weight * Number(regonPrefix[digit]), 0) % 11;
    const regon = `${regonPrefix}${regonSum === 10 ? 0 : regonSum}`;
    return { id: randomUUID(), batchId, rowNumber: startRowNumber + index, companyName: `Synthetic Set Company ${index + 1}`,
      decisionMakerName: "Synthetic Set Lead", nipRaw: nip, address: "Synthetic Street 1", postalCode: "00-001", city: "Synthetic City",
      regonRaw: regon, regon, effectiveRegon: regon, rowVersion: 1, issues: [] };
  });
  await models.SourceRow.bulkCreate(rows);

  const preparations = new ImportPreparationService(
    createAuditService(),
    new ImportPreparationsRepository(models.sequelize),
  );
  const preparationStart = await preparations.start(batchId, { idempotencyKey: "synthetic-prepared-set-prep-1201" }, actor);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await preparations.get(batchId, preparationStart.preparationId, actor);
    if (state.sealedAt) break;
    if (!await preparations.processOne()) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  const preparation = await preparations.get(batchId, preparationStart.preparationId, actor);
  if (!preparation.sealedAt || preparation.readyCount < 1201) throw new Error("PREPARED_SET_FIXTURE_PREPARATION_NOT_READY");

  const childSizes = [];
  const fakeSubmissions = {
    async createPreparedSetChunk(input) {
      childSizes.push(input.rowNumbers.length);
      const submissionId = randomUUID();
      const now = new Date();
      await models.RunSubmission.create({ submissionId, importBatchId: batchId, tenantId: actor.tenantId,
        toolId: "oc-policy-verification", actorUserId: actor.userId, idempotencyKey: input.idempotencyKey,
        requestHash: "a".repeat(64), referenceDate: input.referenceDate, status: "completed", version: 1,
        createdAt: now, updatedAt: now });
      return { submissionId };
    },
    async get(submissionId) { return { submissionId, status: "completed" }; },
    async cancel() { return { status: "cancelled" }; },
  };
  const executions = new PreparedSetExecutionService(
    preparations,
    fakeSubmissions,
    new PreparedSetExecutionRepository(),
    new PreparedSetExecutionControlRepository(),
  );
  const started = await executions.start(batchId, { idempotencyKey: "synthetic-whole-set-1201-01",
    preparationId: preparation.preparationId, snapshotFingerprint: preparation.sourceFingerprint }, actor);
  const mismatchedPreviewStatus = await executions.start(batchId, { idempotencyKey: "synthetic-whole-set-stale-01",
    preparationId: randomUUID(), snapshotFingerprint: "b".repeat(64) }, actor).then(() => null, (error) => error?.getStatus?.() ?? null);
  if (mismatchedPreviewStatus !== 409) throw new Error("PREPARED_SET_STALE_PREVIEW_NOT_REJECTED");

  let finished = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await models.PreparedSetExecution.findByPk(started.executionId);
    if (current?.status === "completed") { finished = true; break; }
    if (current && !current.leaseOwner) await models.PreparedSetExecution.update({ nextAttemptAt: new Date(Date.now() - 1000) }, { where: { executionId: current.executionId } });
    await executions.processOne();
  }
  const final = await models.PreparedSetExecution.findByPk(started.executionId);
  const chunks = await models.PreparedSetChunk.findAll({ where: { executionId: started.executionId }, order: [["ordinal", "ASC"]] });
  const flattened = chunks.flatMap((chunk) => chunk.rowNumbers);
  const replay = await executions.start(batchId, { idempotencyKey: "synthetic-whole-set-1201-01",
    preparationId: preparation.preparationId, snapshotFingerprint: preparation.sourceFingerprint }, actor);
  const laterPage = await executions.get(batchId, started.executionId, actor, "1");
  const invalidCursorStatus = await executions.get(batchId, started.executionId, actor, "-1")
    .then(() => null, (error) => error?.getStatus?.() ?? null);
  if (!finished || final?.status !== "completed" || final.chunkCount !== 3 || childSizes.join(",") !== "500,500,201"
    || chunks.some((chunk, index) => chunk.ordinal !== index + 1 || chunk.status !== "completed" || chunk.rowNumbers.length > 500)
    || flattened.length !== 1201 || new Set(flattened).size !== 1201 || replay.executionId !== started.executionId || replay.replayed !== true
    || laterPage.chunks.map((chunk) => chunk.ordinal).join(",") !== "2,3"
    || laterPage.progress.generatedChunks !== 3 || laterPage.progress.completedChunks !== 3 || invalidCursorStatus !== 400) {
    throw new Error(`PREPARED_SET_CHUNK_ORCHESTRATION_MISMATCH_${JSON.stringify({ status: final?.status, chunks: childSizes, rows: flattened.length, replay: replay.executionId, laterPage: laterPage.chunks.map((chunk) => chunk.ordinal), invalidCursorStatus })}`);
  }
  const cancellable = await executions.start(batchId, { idempotencyKey: "synthetic-whole-set-cancel-01",
    preparationId: preparation.preparationId, snapshotFingerprint: preparation.sourceFingerprint }, actor);
  const staleCancel = await executions.cancel(batchId, cancellable.executionId, { expectedVersion: cancellable.version + 1 }, actor)
    .then(() => null, (error) => error?.getStatus?.() ?? null);
  const cancelled = await executions.cancel(batchId, cancellable.executionId, { expectedVersion: cancellable.version }, actor);
  if (staleCancel !== 409 || cancelled.status !== "cancelled") throw new Error("PREPARED_SET_CANCEL_CAS_MISMATCH");
  const pausable = await executions.start(batchId, { idempotencyKey: "synthetic-whole-set-pause-01",
    preparationId: preparation.preparationId, snapshotFingerprint: preparation.sourceFingerprint }, actor);
  const pauseRequested = await executions.pause(batchId, pausable.executionId, { expectedVersion: pausable.version }, actor);
  await executions.processOne();
  const paused = await executions.get(batchId, pausable.executionId, actor);
  const staleResumeStatus = await executions.resume(batchId, pausable.executionId, { expectedVersion: pausable.version }, actor)
    .then(() => null, (error) => error?.getStatus?.() ?? null);
  const resumed = await executions.resume(batchId, pausable.executionId, { expectedVersion: paused.version }, actor);
  const stoppedAfterResume = await executions.cancel(batchId, pausable.executionId, { expectedVersion: resumed.version }, actor);
  if (pauseRequested.status !== "pause_requested" || paused.status !== "paused" || staleResumeStatus !== 409
    || resumed.status !== "queued" || stoppedAfterResume.status !== "cancelled") throw new Error("PREPARED_SET_PAUSE_RESUME_CAS_MISMATCH");
  const originalSubmission = await models.RunSubmission.findOne({ where: { idempotencyKey: "synthetic-submission-main-key-01" } });
  const originalGroups = originalSubmission ? await models.RunSubmissionGroup.findAll({ where: { submissionId: originalSubmission.submissionId } }) : [];
  const originalRunId = originalGroups.find((group) => group.runId)?.runId;
  const admittedRun = originalRunId ? await models.AutomationRun.findByPk(originalRunId) : null;
  const primarySource = admittedRun ? await models.SourceRow.findByPk(admittedRun.sourceRowId) : null;
  const [snapshotRows] = originalRunId ? await sequelize.query("SELECT input_snapshot FROM automation_runs WHERE id = $1", { bind: [originalRunId] }) : [[]];
  const frozenCompanyName = snapshotRows[0]?.input_snapshot?.companyName;
  if (!admittedRun || !primarySource || typeof frozenCompanyName !== "string") throw new Error("RUN_INPUT_SNAPSHOT_NOT_CREATED");

  const { encryptIdentityForPersistence } = require("../dist/features/results/pesel-crypto");
  const { exportRunWorkbook } = require("../dist/features/results/run-export");
  const encryptionKey = Buffer.alloc(32, 6).toString("base64");
  process.env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
  process.env.PESEL_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({ "1": encryptionKey }), "utf8").toString("base64");
  const exportRunId = randomUUID();
  const exportSnapshot = { schemaVersion: 1, sourceRowId: primarySource.id, rowNumber: primarySource.rowNumber,
    rowVersion: primarySource.rowVersion, companyName: primarySource.companyName, decisionMakerName: primarySource.decisionMakerName,
    nipRaw: primarySource.nipRaw, address: primarySource.address, postalCode: primarySource.postalCode, city: primarySource.city,
    countyCode: null, regonRaw: primarySource.regonRaw, regon: primarySource.regon,
    effectiveRegon: primarySource.effectiveRegon, issues: [] };
  const decisionMakerWords = String(primarySource.decisionMakerName ?? "Synthetic Decision Maker").trim().split(/\s+/).filter(Boolean);
  const identityFirstName = decisionMakerWords.shift() ?? "Synthetic";
  const identityLastName = decisionMakerWords.join(" ") || "Decision Maker";
  await models.AutomationRun.create({ id: exportRunId, batchId, sourceRowId: primarySource.id,
    canonicalEntityId: null, leadIdentityKey: null, rowNumber: primarySource.rowNumber,
    toolId: "oc-policy-verification", status: "export_ready", currentStep: "export_ready", referenceDate: "2026-10-08",
    inputSnapshot: exportSnapshot,
    errorCode: null, createdAt: new Date(), updatedAt: new Date() });
  await sequelize.query("UPDATE automation_runs SET input_snapshot = $1::jsonb WHERE id = $2", {
    bind: [JSON.stringify(exportSnapshot), exportRunId],
  });
  const identityInput = { schemaVersion: 1, sourceRowId: primarySource.id, regon: primarySource.effectiveRegon,
    companyName: primarySource.companyName, firstName: identityFirstName, lastName: identityLastName, pesel: "90010100016",
    matchMethod: "regon_company_name_decision_maker", adapterVersion: "fixture-v1" };
  await models.RunIdentity.create({ ...encryptIdentityForPersistence(identityInput, exportRunId), createdAt: new Date() });
  await models.OcSnapshot.create({ runId: exportRunId, totalCount: 1, capturedAt: new Date(), parserVersion: "fixture-v1" });
  await models.OcPolicyRecord.create({ runId: exportRunId, sourceOrdinal: 1, insuredName: null,
    policyTypeAndNumber: "SYNTHETIC-EXPORT-1", contractType: "OC", insuredClaimCount: 0,
    vehicleRegistration: "TEST0001", vehicleGroup: "Synthetic", vehicleMake: "Synthetic", vehicleModel: "Test",
    insurer: "Synthetic Insurer", coverageFrom: "2026-01-01", coverageTo: "2099-12-31" });
  await models.SourceRow.update({ companyName: "Synthetic Post-Admission Edit", rowVersion: primarySource.rowVersion + 1 }, { where: { id: primarySource.id } });
  const [reloadedSnapshots] = await sequelize.query("SELECT input_snapshot FROM automation_runs WHERE id = $1", { bind: [originalRunId] });
  if (reloadedSnapshots[0]?.input_snapshot?.companyName !== frozenCompanyName) throw new Error("RUN_INPUT_SNAPSHOT_CHANGED_AFTER_SOURCE_EDIT");
  const exported = await exportRunWorkbook(exportRunId);
  const expectedFileName = `${primarySource.companyName}_${primarySource.effectiveRegon}.xlsx`;
  if (!exported || exported.fileName !== expectedFileName) throw new Error(`EXPORT_IGNORED_IMMUTABLE_INPUT_SNAPSHOT_${exported?.fileName ?? "none"}`);
  const exportSource = await models.SourceRow.findOne({ where: { batchId }, order: [["rowNumber", "ASC"]] });
  if (!exportSource) throw new Error("PREPARATION_EXPORT_SOURCE_MISSING");
  const exportSourceCompany = exportSource.companyName;
  await models.SourceRow.update({ companyName: "Synthetic Post-Preparation Edit", rowVersion: exportSource.rowVersion + 1 }, { where: { id: exportSource.id } });
  const preparedWorkbook = await preparations.exportWorkbook(batchId, preparation.preparationId, actor);
  const ExcelJS = require("exceljs");
  const parsedPreparedWorkbook = new ExcelJS.Workbook();
  await parsedPreparedWorkbook.xlsx.load(preparedWorkbook.bytes);
  const workingSetSheet = parsedPreparedWorkbook.getWorksheet("Zestaw roboczy");
  const decisionMapSheet = parsedPreparedWorkbook.getWorksheet("Mapa i uwagi");
  if (preparedWorkbook.rowCount !== 1201 || preparedWorkbook.includedCount !== 1201
    || workingSetSheet?.rowCount !== 1202 || decisionMapSheet?.rowCount !== 1202
    || decisionMapSheet.getRow(2).getCell(8).value !== exportSourceCompany
    || decisionMapSheet.getRow(2).getCell(3).value !== "Gotowy — w zestawie roboczym") {
    throw new Error("PREPARATION_EXPORT_DID_NOT_USE_SEALED_SNAPSHOT");
  }
  console.log("PREPARED_SET_SMOKE_PASS wholeSet=true rows=1201 chunks=500,500,201 idempotentReplay=true stalePreview409=true chunkPagination=true pauseResumeCAS=true cancelCAS=true immutableWorkerInput=true snapshotDrivenExport=true preparationWorkbook=true sourceEditStable=true portalActions=0");
}

function runTestPostgresDocker(args, timeout = 120_000) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout });
  if (result.error || result.status !== 0) {
    const code = result.error?.code ?? result.status ?? "UNKNOWN";
    throw new Error(`BACKUP_RESTORE_DOCKER_STEP_FAILED_${code}`);
  }
  return result.stdout.trim();
}

async function verifyDisposableBackupRestore(sourceDatabase) {
  smokeStage = "backup_restore_fixture_ownership";
  const container = process.env.GOLDIS_TEST_POSTGRES_CONTAINER;
  const owner = process.env.GOLDIS_TEST_POSTGRES_OWNER;
  if (!container || !/^goldis-db-smoke-[a-f0-9]{32}$/.test(container)
    || !owner || !/^[a-f0-9]{32}$/.test(owner)
    || !/^goldis_migration_smoke_[a-z0-9_]+$/.test(sourceDatabase)) {
    throw new Error("BACKUP_RESTORE_DISPOSABLE_CONTAINER_REQUIRED");
  }
  const inspection = runTestPostgresDocker(["inspect", "--format", "{{index .Config.Labels \"goldis.test.owner\"}}|{{.Config.Image}}|{{.State.Running}}", container]);
  if (inspection !== `${owner}|postgres:17-alpine|true`) throw new Error("BACKUP_RESTORE_TEST_CONTAINER_OWNERSHIP_MISMATCH");

  const suffix = randomUUID().replaceAll("-", "");
  const restoreDatabase = `goldis_backup_restore_${suffix}`;
  const dumpPath = `/tmp/goldis-backup-${suffix}.dump`;
  const exportSourceDir = `/tmp/goldis-export-source-${suffix}`;
  const exportRestoreDir = `/tmp/goldis-export-restored-${suffix}`;
  const exportArchive = `/tmp/goldis-export-${suffix}.tar.gz`;
  const sentinel = `synthetic-backup-restore-${suffix}`;
  let targetCreated = false;
  const startedAt = performance.now();
  try {
    await sequelize.query("CREATE TABLE backup_restore_sentinel (sentinel_id integer PRIMARY KEY, marker text NOT NULL)");
    await sequelize.query("INSERT INTO backup_restore_sentinel (sentinel_id, marker) VALUES (1, $1)", { bind: [sentinel] });
    const dumpStartedAt = performance.now();
    runTestPostgresDocker(["exec", container, "pg_dump", "-U", "postgres", "-d", sourceDatabase, "--format=custom", "--file", dumpPath]);
    const dumpMs = Math.round(performance.now() - dumpStartedAt);
    runTestPostgresDocker(["exec", container, "createdb", "-U", "postgres", restoreDatabase]);
    targetCreated = true;
    const restoreStartedAt = performance.now();
    runTestPostgresDocker(["exec", container, "pg_restore", "-U", "postgres", "-d", restoreDatabase,
      "--exit-on-error", "--single-transaction", "--no-owner", dumpPath]);
    const restoreMs = Math.round(performance.now() - restoreStartedAt);
    const restored = runTestPostgresDocker(["exec", container, "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
      "-U", "postgres", "-d", restoreDatabase, "-c",
      "SELECT (SELECT count(*) FROM \"SequelizeMeta\")::text || '|' || (SELECT name FROM \"SequelizeMeta\" ORDER BY name DESC LIMIT 1) || '|' || (SELECT marker FROM backup_restore_sentinel WHERE sentinel_id = 1)" ]);
    const fields = restored.split("|");
    if (fields.length !== 3 || Number(fields[0]) !== latestMigration
      || !fields[1]?.startsWith(`${String(latestMigration).padStart(3, "0")}-`) || fields[2] !== sentinel) {
      throw new Error("BACKUP_RESTORE_SCHEMA_OR_SENTINEL_MISMATCH");
    }
    runTestPostgresDocker(["exec", container, "sh", "-c",
      `mkdir -p '${exportSourceDir}' '${exportRestoreDir}' && printf '%s' '${sentinel}' > '${exportSourceDir}/report.xlsx' && tar -czf '${exportArchive}' -C '${exportSourceDir}' .`]);
    const archiveEntries = runTestPostgresDocker(["exec", container, "tar", "-tzf", exportArchive]).split(/\r?\n/).filter(Boolean);
    const exportFiles = archiveEntries.filter((entry) => entry !== "./");
    if (exportFiles.length !== 1 || exportFiles[0] !== "./report.xlsx"
      || archiveEntries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      throw new Error("BACKUP_RESTORE_EXPORT_ARCHIVE_PATH_INVALID");
    }
    runTestPostgresDocker(["exec", container, "tar", "-xzf", exportArchive, "-C", exportRestoreDir]);
    const exportHashes = runTestPostgresDocker(["exec", container, "sha256sum",
      `${exportSourceDir}/report.xlsx`, `${exportRestoreDir}/report.xlsx`])
      .split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]);
    if (exportHashes.length !== 2 || exportHashes[0] !== exportHashes[1]) {
      throw new Error("BACKUP_RESTORE_EXPORT_CHECKSUM_MISMATCH");
    }
    console.log(`BACKUP_RESTORE_DISPOSABLE_PASS migrations=${fields[0]} latest=${fields[1]} sentinel=true exportArchive=true exportChecksum=true dumpMs=${dumpMs} restoreMs=${restoreMs} externalActions=0`);
  } finally {
    if (targetCreated) runTestPostgresDocker(["exec", container, "dropdb", "-U", "postgres", "--if-exists", restoreDatabase]);
    runTestPostgresDocker(["exec", container, "sh", "-c",
      `rm -f '${dumpPath}' '${exportArchive}' '${exportSourceDir}/report.xlsx' '${exportRestoreDir}/report.xlsx' && rmdir '${exportSourceDir}' '${exportRestoreDir}' 2>/dev/null || true`]);
    await sequelize.query("DROP TABLE IF EXISTS backup_restore_sentinel");
    const totalMs = Math.round(performance.now() - startedAt);
    if (process.env.GOLDIS_TEST_VERBOSE === "1") console.log(`BACKUP_RESTORE_DISPOSABLE_CLEANUP elapsedMs=${totalMs} ownedTargetDropped=${targetCreated}`);
  }
}

async function verifyImportPreparationFlow() {
  smokeStage = "import_preparation_workflow";
  const models = require("../dist/infrastructure/database/db");
  const { ImportPreparationService } = require("../dist/features/preparations/index");
  const { ImportPreparationsRepository } = require("../dist/features/preparations/preparations.repository");
  const { ImportPreparationWorkflowsRepository } = require("../dist/features/preparations/preparation-workflows.repository");
  const { ImportPreparationWorkflowService } = require("../dist/features/preparations/index");
  const { EnrichmentJobService, RegistryEnrichmentJobRunner } = require("../dist/features/enrichment/public");
  const tenant = tenantScopeSeed?.goldisTenantId
    ? await models.Tenant.findByPk(tenantScopeSeed.goldisTenantId)
    : await models.Tenant.findOne({ where: { slug: "goldis" } });
  const owner = tenantScopeSeed?.goldisActorId
    ? await models.User.findByPk(tenantScopeSeed.goldisActorId)
    : await models.User.findOne({ where: { usernameNormalized: "synthetic.bootstrap.admin" } });
  if (!tenant || !owner) throw new Error("IMPORT_PREPARATION_FIXTURE_IDENTITY_MISSING");
  const now = new Date();
  const batch = await models.ImportBatch.create({ tenantId: tenant.tenantId, ownerUserId: owner.userId,
    toolId: "oc-policy-verification", fileName: "synthetic-preparation.xlsx", sha256: "b".repeat(64),
    totalRows: 4, invalidRows: 0, createdAt: now });
  const rows = [
    { rowNumber: 2, companyName: "Duplicate Test Company", decisionMakerName: "Anna Nowak", nipRaw: "1234563218",
      regonRaw: "001234567", regon: "001234567", effectiveRegon: "001234567", address: "", postalCode: "", city: "" },
    { rowNumber: 3, companyName: "Duplicate Test Company", decisionMakerName: "Anna Nowak", nipRaw: "1234563218",
      regonRaw: "001234567", regon: "001234567", effectiveRegon: "001234567", address: "Testowa 1", postalCode: "00-001", city: "Warszawa" },
    { rowNumber: 4, companyName: "Registry Test Company", decisionMakerName: "Jan Kowalski", nipRaw: "9876543210",
      regonRaw: "", regon: null, effectiveRegon: null, address: "", postalCode: "", city: "" },
    { rowNumber: 5, companyName: "", decisionMakerName: null, nipRaw: "", regonRaw: "", regon: null,
      effectiveRegon: null, address: "", postalCode: "", city: "" },
  ].map((row) => ({ ...row, batchId: batch.id, issues: row.regonRaw ? [] : ["REGON_EMPTY"] }));
  await models.SourceRow.bulkCreate(rows);
  const service = new ImportPreparationService(
    createAuditService(),
    new ImportPreparationsRepository(models.sequelize),
  );
  const actor = { tenantId: tenant.tenantId, userId: owner.userId, role: "admin" };
  const started = await service.start(batch.id, { idempotencyKey: "synthetic-preparation-key-123456" }, actor);
  const replay = await service.start(batch.id, { idempotencyKey: "synthetic-preparation-key-123456" }, actor);
  if (started.status !== "queued" || replay.preparationId !== started.preparationId || replay.replayed !== true) {
    throw new Error("IMPORT_PREPARATION_IDEMPOTENCY_MISMATCH");
  }
  if (!await service.processOne()) throw new Error("IMPORT_PREPARATION_WORKER_DID_NOT_CLAIM");
  const completed = await service.get(batch.id, started.preparationId, actor);
  const resultRows = await service.rows(batch.id, started.preparationId, 1, undefined, actor);
  if (completed.status !== "completed_with_attention" || completed.stage !== "sealed"
    || completed.counts.ready !== 1 || completed.counts.review !== 0
    || completed.counts.skippedNoIdentifiers !== 1 || completed.counts.duplicates !== 1
    || completed.counts.waitingRegistry !== 1 || !completed.sealedAt) {
    console.error("IMPORT_PREPARATION_FIXTURE_DIAGNOSTICS", JSON.stringify({ counts: completed.counts,
      rows: resultRows.rows.map(({ rowNumber, status, reasonCode, representativeRowNumber }) => ({ rowNumber, status, reasonCode, representativeRowNumber })) }));
    throw new Error("IMPORT_PREPARATION_RESULT_COUNTS_MISMATCH");
  }
  const duplicate = resultRows.rows.find((row) => row.rowNumber === 2);
  if (resultRows.total !== 4 || duplicate?.status !== "duplicate" || duplicate.representativeRowNumber !== 3) {
    throw new Error("IMPORT_PREPARATION_DUPLICATE_REPRESENTATIVE_MISMATCH");
  }
  const workflowService = new ImportPreparationWorkflowService(
    service,
    new EnrichmentJobService(),
    createAuditService(),
    new ImportPreparationWorkflowsRepository(models.sequelize),
  );
  const workflowStart = await workflowService.start(batch.id, started.preparationId,
    { idempotencyKey: "synthetic-preparation-workflow-123456" }, actor);
  const workflowReplay = await workflowService.start(batch.id, started.preparationId,
    { idempotencyKey: "synthetic-preparation-workflow-123456" }, actor);
  if (workflowStart.status !== "queued" || workflowReplay.workflowId !== workflowStart.workflowId || workflowReplay.replayed !== true) {
    throw new Error("IMPORT_PREPARATION_WORKFLOW_IDEMPOTENCY_MISMATCH");
  }
  if (!await workflowService.processOne()) throw new Error("IMPORT_PREPARATION_WORKFLOW_DID_NOT_CLAIM");
  let workflow = await workflowService.get(batch.id, workflowStart.workflowId, actor);
  if (workflow.status !== "waiting_registry" || workflow.registryJobs.length !== 1
    || workflow.registryJobs[0].status !== "queued" || workflow.registryJobs[0].selectedCount !== 1) {
    throw new Error("IMPORT_PREPARATION_WORKFLOW_REGISTRY_QUEUE_MISMATCH");
  }
  const provider = {
    async lookupByNip(nip) {
      if (nip !== "9876543210") throw new Error("WORKFLOW_PROVIDER_RECEIVED_UNEXPECTED_NIP");
      return { providerName: "synthetic-workflow-registry", providerVersion: "fixture-1", dataVersion: "fixture-data-1",
        fetchedAt: new Date(), candidates: [{ nip, regon: "012345675", name: "Registry Test Company" }] };
    },
  };
  const registryRunner = new RegistryEnrichmentJobRunner(provider);
  if (!await registryRunner.processOne(randomUUID())) throw new Error("IMPORT_PREPARATION_WORKFLOW_REGISTRY_JOB_DID_NOT_RUN");
  const linkedJob = await models.EnrichmentJob.findByPk(workflow.registryJobs[0].jobId);
  if (linkedJob?.status !== "completed" || linkedJob.completedCount !== 1) throw new Error("IMPORT_PREPARATION_WORKFLOW_REGISTRY_RESULT_MISMATCH");
  await models.ImportPreparationWorkflow.update({ nextAttemptAt: null }, { where: { workflowId: workflow.workflowId } });
  if (!await workflowService.processOne()) throw new Error("IMPORT_PREPARATION_WORKFLOW_REANALYSIS_DID_NOT_START");
  workflow = await workflowService.get(batch.id, workflow.workflowId, actor);
  if (workflow.status !== "waiting_reanalysis" || !workflow.reanalysisPreparationId) throw new Error("IMPORT_PREPARATION_WORKFLOW_REANALYSIS_LINK_MISSING");
  if (!await service.processOne()) throw new Error("IMPORT_PREPARATION_WORKFLOW_FOLLOWUP_PREPARATION_DID_NOT_RUN");
  await models.ImportPreparationWorkflow.update({ nextAttemptAt: null }, { where: { workflowId: workflow.workflowId } });
  if (!await workflowService.processOne()) throw new Error("IMPORT_PREPARATION_WORKFLOW_FINALIZATION_DID_NOT_RUN");
  workflow = await workflowService.get(batch.id, workflow.workflowId, actor);
  if (workflow.status !== "completed_with_attention" || workflow.reanalysis?.counts.waitingRegistry !== 0) {
    throw new Error("IMPORT_PREPARATION_WORKFLOW_FINAL_STATE_MISMATCH");
  }
  const concurrentStarts = await Promise.allSettled([
    workflowService.start(batch.id, workflow.reanalysis.preparationId,
      { idempotencyKey: "synthetic-preparation-workflow-race-a-123456" }, actor),
    workflowService.start(batch.id, workflow.reanalysis.preparationId,
      { idempotencyKey: "synthetic-preparation-workflow-race-b-123456" }, actor),
  ]);
  const acceptedStarts = concurrentStarts.filter((result) => result.status === "fulfilled");
  if (acceptedStarts.length !== 1) throw new Error("IMPORT_PREPARATION_WORKFLOW_CONCURRENT_START_MISMATCH");
  const concurrentWorkflow = acceptedStarts[0].value;
  const cancelRace = await Promise.allSettled([
    workflowService.cancel(batch.id, concurrentWorkflow.workflowId, { expectedVersion: concurrentWorkflow.version }, actor),
    workflowService.cancel(batch.id, concurrentWorkflow.workflowId, { expectedVersion: concurrentWorkflow.version }, actor),
  ]);
  if (cancelRace.filter((result) => result.status === "fulfilled").length !== 1
    || cancelRace.filter((result) => result.status === "rejected").length !== 1) {
    throw new Error("IMPORT_PREPARATION_WORKFLOW_CANCEL_CAS_MISMATCH");
  }
  const cancelledWorkflow = await models.ImportPreparationWorkflow.findByPk(concurrentWorkflow.workflowId);
  if (cancelledWorkflow?.status !== "cancelled" || cancelledWorkflow.version !== concurrentWorkflow.version + 1) {
    throw new Error("IMPORT_PREPARATION_WORKFLOW_CANCEL_MISMATCH");
  }
  const failingAudit = { async record() { throw new Error("SYNTHETIC_AUDIT_FAILURE"); } };
  const failingWorkflowService = new ImportPreparationWorkflowService(
    service,
    new EnrichmentJobService(),
    failingAudit,
    new ImportPreparationWorkflowsRepository(models.sequelize),
  );
  const rollbackWorkflow = await workflowService.start(batch.id, workflow.reanalysis.preparationId,
    { idempotencyKey: "synthetic-preparation-workflow-rollback-123456" }, actor);
  let workflowAuditFailed = false;
  try {
    await failingWorkflowService.cancel(batch.id, rollbackWorkflow.workflowId,
      { expectedVersion: rollbackWorkflow.version }, actor);
  } catch (error) {
    workflowAuditFailed = error instanceof Error && error.message === "SYNTHETIC_AUDIT_FAILURE";
  }
  const workflowAfterRollback = await models.ImportPreparationWorkflow.findByPk(rollbackWorkflow.workflowId);
  if (!workflowAuditFailed || workflowAfterRollback?.status !== "queued" || workflowAfterRollback.version !== rollbackWorkflow.version) {
    throw new Error("IMPORT_PREPARATION_WORKFLOW_AUDIT_ROLLBACK_MISMATCH");
  }
  await workflowService.cancel(batch.id, rollbackWorkflow.workflowId,
    { expectedVersion: rollbackWorkflow.version }, actor);
  const cancelled = await service.start(batch.id, { idempotencyKey: "synthetic-preparation-cancel-123456" }, actor);
  const cancellation = await service.cancel(batch.id, cancelled.preparationId, { expectedVersion: 1 }, actor);
  if (cancellation.status !== "cancelled" || cancellation.version !== 2) throw new Error("IMPORT_PREPARATION_CANCEL_MISMATCH");
  const failingPreparationService = new ImportPreparationService(
    failingAudit,
    new ImportPreparationsRepository(models.sequelize),
  );
  let preparationAuditFailed = false;
  try {
    await failingPreparationService.start(batch.id,
      { idempotencyKey: "synthetic-preparation-audit-rollback-123456" }, actor);
  } catch (error) {
    preparationAuditFailed = error instanceof Error && error.message === "SYNTHETIC_AUDIT_FAILURE";
  }
  const rolledBackPreparation = await models.ImportPreparation.findOne({
    where: { tenantId: actor.tenantId, batchId: batch.id, actorUserId: actor.userId,
      idempotencyKey: "synthetic-preparation-audit-rollback-123456" },
  });
  if (!preparationAuditFailed || rolledBackPreparation) throw new Error("IMPORT_PREPARATION_AUDIT_ROLLBACK_MISMATCH");
  console.log("IMPORT_PREPARATION_SMOKE_PASS idempotency=true snapshot=true dedupe=true noIdentifiers=true registryWait=true workflowRegistryReanalysis=true workflowRace=true cancelCAS=true workflowAuditRollback=true preparationAuditRollback=true");
}

async function run() {
  await sequelize.authenticate();
  if (mode === "from-006") {
    await upThrough("006-cancelled-runs.js");
    const seeded = await seedLegacyRun();
    await upThrough("007-run-checkpoints.js");
    const [runs] = await sequelize.query(
      `SELECT status, reference_date::text AS reference_date, schema_version, adapter_version,
              last_safe_step, external_case_ref, started_at, finished_at
       FROM automation_runs WHERE id = $1`,
      { bind: [seeded.runId] },
    );
    const [events] = await sequelize.query(
      `SELECT actor_id, metadata FROM run_events WHERE run_id = $1`,
      { bind: [seeded.runId] },
    );
    if (runs.length !== 1 || events.length !== 1
      || runs[0].status !== "awaiting_portal_adapter"
      || runs[0].reference_date !== "2026-09-30"
      || runs[0].schema_version !== 1
      || events[0].actor_id !== null
      || JSON.stringify(events[0].metadata) !== "{}") {
      throw new Error("MIGRATION_SMOKE_LEGACY_DATA_MISMATCH");
    }
  } else if (mode === "empty") {
    await umzug.up();
    const [tables] = await sequelize.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (
         'import_batches','source_rows','automation_runs','run_events',
         'run_identities','oc_snapshots','oc_policies','export_artifacts'
       )`,
    );
    if (tables[0].count !== 8) throw new Error("MIGRATION_SMOKE_EMPTY_SCHEMA_MISMATCH");
  } else if (["policies", "pesel", "snapshot", "evaluation", "export"].includes(mode)) {
    await upThrough("007-run-checkpoints.js");
    const seeded = await seedLegacyRun();
    await upThrough("008-identities-and-policies.js");
    if (["snapshot", "evaluation", "export"].includes(mode)) await upThrough("012-source-row-version.js");
    if (mode === "policies") await verifyPolicySchema(seeded);
    else if (mode === "pesel") await verifyPeselPersistence(seeded);
    else if (mode === "snapshot") await verifySnapshotPersistence();
    else if (mode === "evaluation") await verifyRunEvaluation();
    else await verifyRunExport();
  } else if (mode === "artifacts") {
    await upThrough("008-identities-and-policies.js");
    await upThrough("009-export-artifacts.js");
    await verifyArtifactSchema();
  } else if (["finalize", "download"].includes(mode)) {
    await upThrough("008-identities-and-policies.js");
    await upThrough("009-export-artifacts.js");
    await upThrough("012-source-row-version.js");
    if (mode === "finalize") await verifyFinalizedExport();
    else await verifyArtifactDownload();
  } else if (mode === "mfa") {
    await upThrough("009-export-artifacts.js");
    const seeded = await seedLegacyRun("pzu_login");
    await upThrough("012-source-row-version.js");
    await verifyAuthChallengeSchema(seeded);
  } else if (mode === "registry") {
    await upThrough("010-auth-challenges-and-interventions.js");
    const seeded = await seedLegacyRun("awaiting_portal_adapter");
    await upThrough("023-intervention-assignment.js");
    await assignSyntheticBatchToGoldis(seeded.batchId);
    await upThrough("024-canonical-entity-tenant-scope.js");
    await verifyRegistrySchema(seeded);
  } else if (mode === "corrections") {
    await upThrough("011-regon-entities.js");
    const seeded = await seedLegacyRun("awaiting_portal_adapter");
    await upThrough("023-intervention-assignment.js");
    await assignSyntheticBatchToGoldis(seeded.batchId);
    await upThrough("024-canonical-entity-tenant-scope.js");
    await verifyRegonCorrections(seeded);
  } else if (mode === "enrichment") {
    await upThrough("010-auth-challenges-and-interventions.js");
    const seeded = await seedLegacyRun("awaiting_portal_adapter");
    await upThrough("023-intervention-assignment.js");
    await assignSyntheticBatchToGoldis(seeded.batchId);
    await upThrough("024-canonical-entity-tenant-scope.js");
    await verifyRegistryEnrichment(seeded);
  } else if (mode === "groups") {
    await upThrough("013-regon-enrichment-audit.js");
    const seeded = await seedLegacyRun("failed");
    await upThrough("023-intervention-assignment.js");
    await assignSyntheticBatchToGoldis(seeded.batchId);
    await upThrough("024-canonical-entity-tenant-scope.js");
    await verifyCanonicalRunGroups(seeded);
  } else if (mode === "grouping-perf") {
    await upThrough("014-canonical-run-groups.js");
    const seeded = await seedLegacyRun("failed");
    await upThrough("023-intervention-assignment.js");
    await assignSyntheticBatchToGoldis(seeded.batchId);
    await upThrough("024-canonical-entity-tenant-scope.js");
    groupingPerfBatchId = seeded.batchId;
  } else if (mode === "users-empty") {
    await umzug.up();
    await verifyUserSchema();
    await verifyImportPreparationFlow();
    await verifyAccountRecoveryFlow();
  } else if (mode === "users") {
    await upThrough("014-canonical-run-groups.js");
    const seeded = await seedLegacyRun("failed");
    const queuedSeed = await seedLegacyRun("queued");
    await upThrough("015-users-memberships-audit.js");
    await upThrough("016-auth-cycle-and-current-challenge.js");
    await upThrough("017-run-dispatch-outbox-and-leases.js");
    await upThrough("018-intervention-read-state.js");
    await upThrough("019-run-manual-data-overrides.js");
    await upThrough("020-worker-runtime-status.js");
    const models = require("../dist/infrastructure/database/db");
    const { hashPassword } = require("../dist/features/auth/index");
    const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
    const makeLegacyMember = async (name, role, membershipStatus, password = `Synthetic-only ${name} password!`) => {
      const now = new Date();
      const normalized = name.toLowerCase();
      const userId = randomUUID();
      const passwordHash = await hashPassword(password);
      await sequelize.query(
        `INSERT INTO users (user_id, username, username_normalized, password_hash, status, created_at, updated_at, last_login_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $5, NULL)`,
        { bind: [userId, name, normalized, passwordHash, now] },
      );
      await sequelize.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        { bind: [tenant.tenantId, userId, role, membershipStatus, now] },
      );
      return userId;
    };
    const legacyGrantUsers = {
      bootstrapAdminId: await makeLegacyMember("Synthetic.Bootstrap.Admin", "admin", "active", "Synthetic-only Bootstrap Password!"),
      operatorId: await makeLegacyMember("Synthetic.Legacy.Operator", "operator", "active"),
      reviewerId: await makeLegacyMember("Synthetic.Legacy.Reviewer", "reviewer", "active"),
      disabledOperatorId: await makeLegacyMember("Synthetic.Legacy.Disabled", "operator", "disabled"),
    };
    for (const batchId of new Set([seeded.batchId, queuedSeed.batchId])) {
      await sequelize.query(
        "UPDATE import_batches SET tenant_id = $1, owner_user_id = $2 WHERE id = $3",
        { bind: [tenant.tenantId, legacyGrantUsers.bootstrapAdminId, batchId] },
      );
    }
    await upThrough("021-tools-grants-settings.js");
    await upThrough("022-user-sessions.js");
    await upThrough("023-intervention-assignment.js");
    await upThrough("024-canonical-entity-tenant-scope.js");
    await upThrough("027-persistent-run-submissions.js");
    await upThrough("028-registry-provider-daily-budget.js");
    await upThrough("029-registry-result-cache.js");
    await upThrough("030-source-row-nip-index.js");
    await upThrough("031-credential-revisions.js");
    await upThrough("032-independent-download-grants.js");
    await upThrough("033-session-idle-activity.js");
    await upThrough("034-manager-role.js");
    await upThroughLatestTenantSchema();
    const { bootstrapAdminOnce } = require("../dist/features/auth/bootstrap-admin");
    const previousBootstrapUser = process.env.GOLDIS_ADMIN_USER;
    const previousBootstrapPassword = process.env.GOLDIS_ADMIN_PASSWORD;
    process.env.GOLDIS_ADMIN_USER = "Synthetic.Bootstrap.Admin";
    process.env.GOLDIS_ADMIN_PASSWORD = "Synthetic-only Bootstrap Password!";
    try { await bootstrapAdminOnce({ username: process.env.GOLDIS_ADMIN_USER, password: process.env.GOLDIS_ADMIN_PASSWORD }); }
    finally {
      if (previousBootstrapUser === undefined) delete process.env.GOLDIS_ADMIN_USER;
      else process.env.GOLDIS_ADMIN_USER = previousBootstrapUser;
      if (previousBootstrapPassword === undefined) delete process.env.GOLDIS_ADMIN_PASSWORD;
      else process.env.GOLDIS_ADMIN_PASSWORD = previousBootstrapPassword;
    }
    await verifyUserSchema(seeded, queuedSeed, legacyGrantUsers);
    await verifyOperationalSettingsAndRunControls();
    await require("./worker-result-smoke.cjs")(seedLegacyRun);
  } else if (mode === "tenant-scope" || mode === "teams" || mode === "admin-users" || mode === "deletion" || mode === "run-control") {
    await upThrough("014-canonical-run-groups.js");
    tenantScopeSeed = {
      goldis: await seedLegacyRun("failed"),
      other: await seedLegacyRun("failed"),
    };
    await upThrough("023-intervention-assignment.js");
    const goldisAssignment = await assignSyntheticBatchToGoldis(tenantScopeSeed.goldis.batchId);
    tenantScopeSeed.goldisTenantId = goldisAssignment.tenant.tenantId;
    tenantScopeSeed.goldisActorId = goldisAssignment.userId;
    await verifyCanonicalTenantMigration();
  } else if (mode === "registry-jobs" || mode === "reports") {
    await upThrough("014-canonical-run-groups.js");
    tenantScopeSeed = {
      goldis: await seedLegacyRun("failed"),
      other: await seedLegacyRun("failed"),
    };
    await upThrough("023-intervention-assignment.js");
    const goldisAssignment = await assignSyntheticBatchToGoldis(tenantScopeSeed.goldis.batchId,
      mode === "reports" ? "Synthetic.Admin.Reports" : "Synthetic.Registry.Jobs.Admin");
    const models = require("../dist/infrastructure/database/db");
    const now = new Date();
    const otherTenantId = randomUUID();
    const otherUserId = randomUUID();
    await models.Tenant.create({ tenantId: otherTenantId, slug: `${mode}-${randomUUID().slice(0, 8)}`, displayName: "Synthetic Isolated Tenant", createdAt: now });
    const otherUsername = `Synthetic.${mode}.Other`;
    await sequelize.query(
      `INSERT INTO users (user_id, username, username_normalized, password_hash, status, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $5, NULL)`,
      { bind: [otherUserId, otherUsername, otherUsername.toLowerCase(), "synthetic-password-hash-0123456789abcdef", now] },
    );
    await sequelize.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, 'admin', 'active', $3, $3)`,
      { bind: [otherTenantId, otherUserId, now] },
    );
    await sequelize.query("UPDATE import_batches SET tenant_id = $1, owner_user_id = $2 WHERE id = $3", {
      bind: [otherTenantId, otherUserId, tenantScopeSeed.other.batchId],
    });
    tenantScopeSeed.goldisTenantId = goldisAssignment.tenant.tenantId;
    tenantScopeSeed.goldisActorId = goldisAssignment.userId;
    tenantScopeSeed.otherTenantId = otherTenantId;
    tenantScopeSeed.otherActorId = otherUserId;
  }

  if (tenantScopeModes.includes(mode)) {
    await upThrough("027-persistent-run-submissions.js");
    await upThrough("028-registry-provider-daily-budget.js");
    await upThrough("029-registry-result-cache.js");
    await upThrough("030-source-row-nip-index.js");
    await upThrough("031-credential-revisions.js");
    await upThrough("032-independent-download-grants.js");
    await upThrough("033-session-idle-activity.js");
    await upThrough("034-manager-role.js");
    await upThroughLatestTenantSchema();
    if (mode === "tenant-scope") await verifyEnrichmentJobFlows();
    if (mode === "registry-jobs") {
      await verifyEnrichmentJobFlows();
      await require("./registry-jobs-runtime-smoke.cjs")(tenantScopeSeed);
    }
    if (mode === "reports") {
      smokeStage = "admin-reports-db-smoke";
      await require("./admin-reports-db-smoke.cjs")(tenantScopeSeed);
      smokeStage = "business-leads-db-smoke";
      await require("./business-leads-db-smoke.cjs")(tenantScopeSeed);
    }
    if (mode === "deletion") {
      smokeStage = "deletion-preview-step-up";
      await require("./deletion-step-up-db-smoke.cjs")(tenantScopeSeed);
      smokeStage = "deletion-job-lifecycle";
      await require("./deletion-jobs-db-smoke.cjs")(tenantScopeSeed);
    }
    if (mode === "run-control") {
      await verifyRunPauseControl();
      await require("./run-control-db-smoke.cjs")(tenantScopeSeed);
    }
    if (mode === "teams") {
      smokeStage = "team-db-smoke";
      await require("./team-db-smoke.cjs")(tenantScopeSeed);
    }
    if (mode === "admin-users") {
      smokeStage = "admin-users-db-smoke";
      await require("./admin-users-db-smoke.cjs")(tenantScopeSeed);
    }
    if (mode === "grouping-perf") await verifyGroupingScale(groupingPerfBatchId);
    if (mode === "tenant-scope") {
      await verifyRunSubmissionFlows();
      await verifyImportPreparationFlow();
      await verifyPreparedSetExecutionFlows();
    }
    if (mode === "tenant-scope" && process.env.GOLDIS_AUTOMATION_E2E === "1") {
      await require("./run-submission-platform-smoke.cjs")();
    }
  }
  const executed = await umzug.executed();
  const expectedCount = latestMigration;
  const latestPrefix = `${String(latestMigration).padStart(3, "0")}-`;
  const expectedLatest = (await readdir(path.join(__dirname, "../dist/infrastructure/database/migrations")))
    .filter((name) => name.startsWith(latestPrefix) && name.endsWith(".js")).sort().at(-1);
  if (!expectedLatest) throw new Error("MIGRATION_SMOKE_EXPECTED_FILE_MISSING");
  if (executed.length !== expectedCount || executed.at(-1)?.name !== expectedLatest) {
    throw new Error("MIGRATION_SMOKE_HISTORY_MISMATCH");
  }
  if (latestMigration >= 34) {
    const [roleConstraint] = await sequelize.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'tenant_memberships_role_valid' AND conrelid = 'tenant_memberships'::regclass`,
    );
    if (!roleConstraint?.[0]?.definition?.includes("manager")) throw new Error("MANAGER_ROLE_CONSTRAINT_MISSING");
  }
  await umzug.up();
  if ((await umzug.executed()).length !== expectedCount) throw new Error("MIGRATION_SMOKE_RERUN_MISMATCH");
  if (latestMigration >= 41) await verifyRegistryRequestPacing();
  if (latestMigration >= 35) {
    const preparationTables = await sequelize.query(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'import_prepar%'`,
      { type: QueryTypes.SELECT },
    );
    const preparationTableNames = new Set(preparationTables.map(({ name }) => name));
    if (!preparationTableNames.has("import_preparations") || !preparationTableNames.has("import_prepared_rows")) {
      throw new Error("IMPORT_PREPARATION_TABLES_MISSING");
    }
    const constraints = await sequelize.query(
      `SELECT conname AS name FROM pg_constraint WHERE conrelid IN
         ('import_preparations'::regclass, 'import_prepared_rows'::regclass)`,
      { type: QueryTypes.SELECT },
    );
    const names = new Set(constraints.map(({ name }) => name));
    for (const constraint of ["import_preparations_status_valid", "import_preparations_sealed_shape",
      "import_preparations_batch_revision_unique", "import_prepared_rows_source_batch_fk",
      "import_prepared_rows_snapshot_object", "import_prepared_rows_status_valid"]) {
      if (!names.has(constraint)) throw new Error(`IMPORT_PREPARATION_CONSTRAINT_MISSING_${constraint}`);
    }
  }
  if (latestMigration >= 28) {
    const providerName = `migration-smoke-${randomUUID().slice(0, 8)}`;
    const reservationSql = `INSERT INTO registry_provider_daily_budgets
       (provider_name, usage_date, daily_limit, reserved_requests, created_at, updated_at)
     VALUES ($1, CURRENT_DATE, 1, 1, now(), now())
     ON CONFLICT (provider_name, usage_date) DO UPDATE SET
       reserved_requests = registry_provider_daily_budgets.reserved_requests + 1,
       updated_at = EXCLUDED.updated_at
     WHERE registry_provider_daily_budgets.reserved_requests
       < LEAST(registry_provider_daily_budgets.daily_limit, EXCLUDED.daily_limit)
     RETURNING reserved_requests`;
    try {
      const reservations = await Promise.all([
        sequelize.query(reservationSql, { bind: [providerName] }),
        sequelize.query(reservationSql, { bind: [providerName] }),
      ]);
      if (reservations.reduce((count, result) => count + result[0].length, 0) !== 1) {
        throw new Error("REGISTRY_DAILY_BUDGET_CONCURRENCY_MISMATCH");
      }
      const [count] = await sequelize.query(
        "SELECT reserved_requests FROM registry_provider_daily_budgets WHERE provider_name = $1 AND usage_date = CURRENT_DATE",
        { bind: [providerName] },
      );
      if (count.length !== 1 || Number(count[0].reserved_requests) !== 1) throw new Error("REGISTRY_DAILY_BUDGET_COUNT_MISMATCH");
    } finally {
      await sequelize.query("DELETE FROM registry_provider_daily_budgets WHERE provider_name = $1", { bind: [providerName] });
    }
  }
  if (mode === "backup-restore") await verifyDisposableBackupRestore(targetDatabase);
  console.log(`MIGRATION_SMOKE_PASS mode=${mode} applied=001-${expectedLatest.slice(0, 3)} rerun=stable`);
  if (mode === "users" && process.env.GOLDIS_AUTOMATION_E2E === "1") await require("./automation-flow-smoke.cjs")();
}

run().catch((error) => {
  const code = error?.code ?? error?.parent?.code ?? error?.name ?? "UnknownError";
  const causeCode = error?.cause?.code ?? (/^OUTCOME_[A-Z_]+$/.test(error?.cause?.message ?? "") ? error.cause.message : "");
  const causeMessage = typeof error?.cause?.message === "string" ? error.cause.message.slice(0, 120) : "";
  const message = typeof error?.message === "string" ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").slice(0, 240) : "";
  console.error("MIGRATION_SMOKE_FAILED", `stage=${smokeStage}`, code, causeCode, causeMessage, message);
  process.exitCode = 1;
}).finally(async () => {
  await sequelize.close();
  const cachedModels = require.cache[require.resolve("../dist/infrastructure/database/db")];
  if (cachedModels) await cachedModels.exports.sequelize.close();
});
