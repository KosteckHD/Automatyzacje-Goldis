const path = require("node:path");
require("reflect-metadata");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const { Sequelize } = require("sequelize");
const { SequelizeStorage, Umzug } = require("umzug");

const mode = process.argv[2];
const targetDatabase = process.argv[3];
let smokeStage = "startup";
const templateUrl = process.env.DATABASE_URL;
if (!templateUrl || !["empty", "from-006", "policies", "pesel", "snapshot", "evaluation", "artifacts", "export", "finalize", "download", "mfa", "registry", "corrections", "enrichment", "groups", "users", "users-empty"].includes(mode) || !/^goldis_migration_smoke_[a-z0-9_]+$/.test(targetDatabase ?? "")) {
  console.error("MIGRATION_SMOKE_USAGE: mode empty|from-006|policies|pesel|snapshot|evaluation|artifacts|export|finalize|download|mfa|registry|corrections|enrichment|groups|users|users-empty and a disposable goldis_migration_smoke_* database name are required");
  process.exit(2);
}

const parsedUrl = new URL(templateUrl);
parsedUrl.pathname = `/${targetDatabase}`;
const databaseUrl = parsedUrl.toString();
process.env.DATABASE_URL = databaseUrl;
const currentSourceModes = ["snapshot", "evaluation", "export", "finalize", "download", "mfa", "registry", "corrections"];
const latestMigration = ["users", "users-empty"].includes(mode) ? 23 : mode === "groups" ? 14 : mode === "enrichment" ? 13 : currentSourceModes.includes(mode) ? 12 : ["empty", "artifacts"].includes(mode) ? 9 : ["policies", "pesel"].includes(mode) ? 8 : 7;

const sequelize = new Sequelize(databaseUrl, { logging: false });
const migrationPattern = latestMigration === 23
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
  migrations: { glob: path.join(__dirname, `../dist/migrations/${migrationPattern}`).replace(/\\/g, "/") },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: undefined,
});

async function upThrough(targetName) {
  const alreadyApplied = (await umzug.executed()).some((migration) => migration.name === targetName);
  if (!alreadyApplied) await umzug.up({ to: targetName });
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

  const models = require("../dist/db");
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
  const { encryptIdentityForPersistence, decryptPesel, peselErrorCodeForLog } = require("../dist/pesel-crypto");
  const models = require("../dist/db");
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
  const { persistOcSnapshot, SnapshotPersistenceError } = require("../dist/oc-snapshot-store");
  const models = require("../dist/db");
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
  const { persistOcSnapshot } = require("../dist/oc-snapshot-store");
  const { evaluateStoredSnapshot, RunEvaluationError } = require("../dist/run-evaluation");
  const { exportRunWorkbook } = require("../dist/run-export");
  const { exportOcWorkbook } = require("../dist/export");
  const ExcelJS = require("exceljs");
  const models = require("../dist/db");
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
  const models = require("../dist/db");
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
  const models = require("../dist/db");
  const { Pool } = require("pg");
  const {
    AuthChallengeError,
    createAuthChallenge,
    invalidateStaleAuthChallenges,
    recordAuthChallengeOutcome,
  } = require("../../worker/dist/auth-challenges");
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

    const { AuthChallengeService } = require("../dist/auth-challenges");
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
    const { RunService } = require("../dist/runs");
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
  const models = require("../dist/db");
  const expectedColumns = {
    regon_corrections: [
      "correction_id", "source_row_id", "author_ref", "reason", "previous_regon", "proposed_regon",
      "status", "reviewer_ref", "reviewed_at", "review_reason", "created_at",
    ],
    registry_lookup_cache: [
      "lookup_id", "nip_normalized", "data_version", "status", "result_count", "response_fingerprint",
      "attempt_count", "error_code", "checked_at", "expires_at", "created_at", "updated_at",
    ],
    canonical_entities: ["canonical_entity_id", "nip_normalized", "regon", "business_name", "created_at", "updated_at"],
    source_entity_links: ["source_row_id", "canonical_entity_id", "match_method", "linked_at"],
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
    "registry_lookup_status_expiry_idx", "canonical_entities_nip_unique",
    "canonical_entities_regon_unique", "source_entity_links_entity_idx",
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

  const entity = await models.CanonicalEntity.create({
    canonicalEntityId: randomUUID(), nipNormalized: "0123456789", regon: "012345678",
    businessName: "Synthetic Company", createdAt: now, updatedAt: now,
  });
  const link = await models.SourceEntityLink.create({
    sourceRowId: seeded.sourceRowId, canonicalEntityId: entity.canonicalEntityId,
    matchMethod: "registry_verified", linkedAt: now,
  });
  if (link.canonicalEntityId !== entity.canonicalEntityId || link.sourceRowId !== seeded.sourceRowId) {
    throw new Error("REGISTRY_SOURCE_ENTITY_LINK_MODEL_MISMATCH");
  }

  let nipConflictRejected = false;
  try {
    await models.CanonicalEntity.create({
      canonicalEntityId: randomUUID(), nipNormalized: "0123456789", regon: "987654321",
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
      canonicalEntityId: randomUUID(), nipNormalized: "9876543210", regon: "012345678",
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
      sourceRowId: randomUUID(), canonicalEntityId: entity.canonicalEntityId,
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
  const { ImportService } = require("../dist/imports");
  const models = require("../dist/db");
  const service = new ImportService();
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
  const models = require("../dist/db");
  const { RegistryEnrichmentService } = require("../dist/registry-enrichment");
  const service = new RegistryEnrichmentService();
  await sequelize.query(
    `UPDATE source_rows SET regon_raw = '', regon = NULL, effective_regon = NULL, row_version = 1
     WHERE id = $1`,
    { bind: [seeded.sourceRowId] },
  );
  const createEmptyRow = async (rowNumber) => {
    const id = randomUUID();
    await sequelize.query(
      `INSERT INTO source_rows (
         id, batch_id, row_number, company_name, decision_maker_name, nip_raw, address,
         postal_code, city, regon_raw, regon, effective_regon, row_version, issues
       ) VALUES ($1, $2, $3, 'Synthetic Company', NULL, '0000000000', 'Test 2', '00-000', 'Test City', '', NULL, NULL, 1, '[]'::jsonb)`,
      { bind: [id, seeded.batchId, rowNumber] },
    );
    return id;
  };
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
  const matching = { nip: "0000000000", regon: "012345678", name: "Synthetic Company" };
  const concurrent = await Promise.allSettled([
    service.recordResult(seeded.batchId, 18001, 1, result([matching])),
    service.recordResult(seeded.batchId, 18001, 1, result([matching])),
  ]);
  const accepted = concurrent.filter((item) => item.status === "fulfilled");
  const rejected = concurrent.filter((item) => item.status === "rejected");
  if (accepted.length !== 1 || rejected.length !== 1 || rejected[0].reason?.getStatus?.() !== 409) {
    throw new Error("REGON_ENRICHMENT_CONCURRENCY_NOT_SERIALIZED");
  }
  const applied = await models.SourceRow.findByPk(seeded.sourceRowId);
  const appliedAudits = await models.RegistryEnrichmentAudit.findAll({ where: { sourceRowId: seeded.sourceRowId } });
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
    matching, { nip: "0000000000", regon: "00123456789012", name: "Synthetic Company", unitType: "LOCAL" },
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
  const cacheEntries = await models.RegistryLookupCache.findAll({ where: { nipNormalized: "0000000000" } });
  if (cacheEntries.length !== 1 || cacheEntries[0].attemptCount !== 4 || cacheEntries[0].status !== "not_found"
    || cacheEntries[0].dataVersion.length !== 64 || cacheEntries[0].responseFingerprint.length !== 64) {
    throw new Error("REGON_ENRICHMENT_LOOKUP_CACHE_MISMATCH");
  }
  const { ImportService } = require("../dist/imports");
  await new ImportService().proposeRegonCorrection(seeded.batchId, 18005, {
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
  const models = require("../dist/db");
  const { EntityGroupingService } = require("../dist/entity-grouping-service");
  const { CanonicalRunService } = require("../dist/canonical-run-service");
  const { WorkerCodeForwarder } = require("../dist/auth-challenges");
  const { RunService } = require("../dist/runs");
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
    const { ImportService } = require("../dist/imports");
    const imports = new ImportService();
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

async function verifyUserSchema(seeded = null, queuedSeed = null, legacyGrantUsers = null) {
  smokeStage = "users_schema_seed";
  const models = require("../dist/db");
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
    user_sessions: ["session_id", "tenant_id", "user_id", "expires_at", "revoked_at", "browser_label"],
    tools: ["tool_id", "display_name", "status"],
    tool_grants: ["tenant_id", "tool_id", "user_id", "can_discover", "can_execute", "can_view_results", "can_download_results", "version"],
    tool_settings: ["tenant_id", "tool_id", "enabled_for_new_runs", "timezone", "version"],
    intervention_activity: ["activity_id", "intervention_id", "actor_user_id", "event_type", "created_at"],
  };
  for (const [table, required] of Object.entries(requiredInterventionColumns)) {
    const actual = interventionColumns.filter((column) => column.table_name === table).map((column) => column.column_name);
    if (required.some((column) => !actual.includes(column))) throw new Error(`INTERVENTION_SCHEMA_COLUMNS_MISMATCH_${table}`);
  }
  const { hashPassword } = require("../dist/password-hash");
  const { AuthController, SessionGuard, resolveActiveSessionRole, resolveCurrentSessionRole, verifyCsrfRequest } = require("../dist/session");
  const { BootstrapAdminService } = require("../dist/bootstrap-admin");
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
    const bootstrap = new BootstrapAdminService();
    await bootstrap.onModuleInit();
    process.env.GOLDIS_ADMIN_USER = "Synthetic.Other.Admin";
    process.env.GOLDIS_ADMIN_PASSWORD = "Different Synthetic Password!";
    await bootstrap.onModuleInit();
  } finally {
    if (oldBootstrapUser === undefined) delete process.env.GOLDIS_ADMIN_USER;
    else process.env.GOLDIS_ADMIN_USER = oldBootstrapUser;
    if (oldBootstrapPassword === undefined) delete process.env.GOLDIS_ADMIN_PASSWORD;
    else process.env.GOLDIS_ADMIN_PASSWORD = oldBootstrapPassword;
  }
  const bootstrapAdmin = await models.User.findOne({ where: { usernameNormalized: "synthetic.bootstrap.admin" } });
  const { verifyPassword } = require("../dist/password-hash");
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

  const previousSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "synthetic-session-secret-for-users-migration-smoke";
  const cookies = {};
  const loginLimiter = {
    async consumeAttempt() { return { allowed: true, retryAfterSeconds: 0 }; },
    async clearPair() {},
  };
  const login = await new AuthController(loginLimiter).login({ username: " synthetic.operator ", password: syntheticPassword }, {
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
  const { PermissionGuard, resolvePermissionResource } = require("../dist/authorization-guard");
  const { ImportController } = require("../dist/imports");
  const { RunController } = require("../dist/runs");
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
    throw new Error("USER_MIGRATION_BATCH_SCOPE_GUARD_MISMATCH");
  }
  if (seeded) {
    const operatorOwnRun = await permissionGuard.canActivate(guardContext(
      makePrincipal("operator"), RunController.prototype.get, { params: { id: seeded.runId } },
    ));
    const { AuthChallengeController } = require("../dist/auth-challenges");
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
  const { recordAuditEvent } = require("../dist/audit");
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
    const { AuthChallengeController, AuthChallengeService } = require("../dist/auth-challenges");
    const { SESSION_ROLE_RESOLVER, SessionGuard, resolveActiveSessionRole } = require("../dist/session");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard, resolvePermissionResource } = require("../dist/authorization-guard");
    const challengeId = randomUUID();
    const mfaCycleId = randomUUID();
    const challengeNow = new Date();
    const browserSessionId = randomUUID();
    const accountKey = createHmac("sha256", "synthetic-account-key-for-scope-test").update(randomUUID()).digest("hex");
    await models.AutomationRun.update({ status: "pzu_login", currentStep: "pzu_login", errorCode: null, finishedAt: null }, {
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
        throw new Error("SMS_BODY_RUN_HTTP_GUARD_OR_SUBMISSION_MISMATCH");
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
  console.log(`USER_SCHEMA_SMOKE_PASS migration=023 existingBatchAdoptedByBootstrap=${Boolean(seeded)} bootstrapIdempotent=true ownershipPair=true membership=valid crossTenantOwner=blocked toolGrantBackfill=${Boolean(legacyGrantUsers)} newUserNoGrant=true dbLogin=valid sessionRegistry=true sessionRevoke=true temporaryPasswordGate=true roleFromMembership=true disabledPrincipal=blocked audit=nestedSensitiveMetadata=blocked actionRows=${savedEvents.length} transactionRollback=true outbox=queued-backfilled:${Boolean(queuedSeed)} lease=empty staging=metadata-only`);
}

async function verifyOperationalSettingsAndRunControls() {
  smokeStage = "operational_settings_http_and_run_controls";
  const models = require("../dist/db");
  const { AdminController, AdminOnlyGuard } = require("../dist/admin");
  const {
    SESSION_ROLE_RESOLVER, SESSION_PASSWORD_CHANGE_RESOLVER,
    SessionGuard, resolveCurrentSessionRole, resolveMustChangePassword,
  } = require("../dist/session");
  const { EntityGroupingService } = require("../dist/entity-grouping-service");
  const { CanonicalRunService, createLeadIdentityKey } = require("../dist/canonical-run-service");
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
    lastSeenAt: createdAt, expiresAt: new Date(createdAt.getTime() + 5 * 60_000),
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
    controllers: [AdminController],
    providers: [
      SessionGuard, AdminOnlyGuard,
      { provide: SESSION_ROLE_RESOLVER, useValue: resolveCurrentSessionRole },
      { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: resolveMustChangePassword },
    ],
  })(OperationalSettingsSmokeModule);

  let app;
  try {
    app = await NestFactory.create(OperationalSettingsSmokeModule, { logger: false });
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
      createdAt: operatorSessionAt, lastSeenAt: operatorSessionAt,
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
  const { persistOcSnapshot } = require("../dist/oc-snapshot-store");
  const { evaluateStoredSnapshot } = require("../dist/run-evaluation");
  const { exportRunWorkbook, RunExportError } = require("../dist/run-export");
  const ExcelJS = require("exceljs");
  const models = require("../dist/db");
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
  const { persistOcSnapshot } = require("../dist/oc-snapshot-store");
  const { evaluateStoredSnapshot } = require("../dist/run-evaluation");
  const { exportRunWorkbook } = require("../dist/run-export");
  const { finalizeRunExport, ExportFinalizeError } = require("../dist/export-finalizer");
  const { findOrphanedArtifacts } = require("../dist/private-artifact-store");
  const models = require("../dist/db");
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
  const { persistOcSnapshot } = require("../dist/oc-snapshot-store");
  const { evaluateStoredSnapshot } = require("../dist/run-evaluation");
  const { finalizeRunExport } = require("../dist/export-finalizer");
  const { getVerifiedArtifactDownload, ArtifactDownloadError } = require("../dist/artifact-download");
  const { artifactDownloadHeaders } = require("../dist/artifact-download-headers");
  const { RunController, RunService } = require("../dist/runs");
  const { SessionGuard } = require("../dist/session");
  const { PermissionGuard } = require("../dist/authorization-guard");
  const models = require("../dist/db");
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
    await upThrough("012-source-row-version.js");
    await verifyRegistrySchema(seeded);
  } else if (mode === "corrections") {
    await upThrough("011-regon-entities.js");
    const seeded = await seedLegacyRun("awaiting_portal_adapter");
    await upThrough("012-source-row-version.js");
    await verifyRegonCorrections(seeded);
  } else if (mode === "enrichment") {
    await upThrough("010-auth-challenges-and-interventions.js");
    const seeded = await seedLegacyRun("awaiting_portal_adapter");
    await upThrough("013-regon-enrichment-audit.js");
    await verifyRegistryEnrichment(seeded);
  } else if (mode === "groups") {
    await upThrough("013-regon-enrichment-audit.js");
    const seeded = await seedLegacyRun("failed");
    await upThrough("014-canonical-run-groups.js");
    await verifyCanonicalRunGroups(seeded);
  } else if (mode === "users-empty") {
    await umzug.up();
    await verifyUserSchema();
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
    const models = require("../dist/db");
    const { hashPassword } = require("../dist/password-hash");
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
    const { BootstrapAdminService } = require("../dist/bootstrap-admin");
    const previousBootstrapUser = process.env.GOLDIS_ADMIN_USER;
    const previousBootstrapPassword = process.env.GOLDIS_ADMIN_PASSWORD;
    process.env.GOLDIS_ADMIN_USER = "Synthetic.Bootstrap.Admin";
    process.env.GOLDIS_ADMIN_PASSWORD = "Synthetic-only Bootstrap Password!";
    try { await new BootstrapAdminService().onModuleInit(); }
    finally {
      if (previousBootstrapUser === undefined) delete process.env.GOLDIS_ADMIN_USER;
      else process.env.GOLDIS_ADMIN_USER = previousBootstrapUser;
      if (previousBootstrapPassword === undefined) delete process.env.GOLDIS_ADMIN_PASSWORD;
      else process.env.GOLDIS_ADMIN_PASSWORD = previousBootstrapPassword;
    }
    await verifyUserSchema(seeded, queuedSeed, legacyGrantUsers);
    await verifyOperationalSettingsAndRunControls();
    await require("./worker-result-smoke.cjs")(seedLegacyRun);
    if (process.env.GOLDIS_AUTOMATION_E2E === "1") await require("./automation-flow-smoke.cjs")();
  }

  const executed = await umzug.executed();
  const expectedCount = latestMigration;
  const expectedLatest = latestMigration === 23 ? "023-intervention-assignment.js" : latestMigration === 20 ? "020-worker-runtime-status.js" : latestMigration === 19 ? "019-run-manual-data-overrides.js" : latestMigration === 18 ? "018-intervention-read-state.js" : latestMigration === 17 ? "017-run-dispatch-outbox-and-leases.js" : latestMigration === 16 ? "016-auth-cycle-and-current-challenge.js" : latestMigration === 15 ? "015-users-memberships-audit.js" : latestMigration === 14 ? "014-canonical-run-groups.js" : latestMigration === 13 ? "013-regon-enrichment-audit.js" : latestMigration === 12 ? "012-source-row-version.js" : latestMigration === 9 ? "009-export-artifacts.js" : latestMigration === 8 ? "008-identities-and-policies.js" : "007-run-checkpoints.js";
  if (executed.length !== expectedCount || executed.at(-1)?.name !== expectedLatest) {
    throw new Error("MIGRATION_SMOKE_HISTORY_MISMATCH");
  }
  await umzug.up();
  if ((await umzug.executed()).length !== expectedCount) throw new Error("MIGRATION_SMOKE_RERUN_MISMATCH");
  console.log(`MIGRATION_SMOKE_PASS mode=${mode} applied=${expectedLatest.slice(0, 3)} rerun=stable`);
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
  const cachedModels = require.cache[require.resolve("../dist/db")];
  if (cachedModels) await cachedModels.exports.sequelize.close();
});
