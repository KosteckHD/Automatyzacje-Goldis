require("reflect-metadata");

const path = require("node:path");
const { createHash } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const ExcelJS = require("exceljs");
const { Worker: BullWorker } = require("bullmq");
const { Pool } = require("pg");
const { SequelizeStorage, Umzug } = require("umzug");
const { NestFactory } = require("@nestjs/core");

const targetDatabase = process.argv[2];
const databaseTemplate = process.env.DATABASE_URL;
const databasePattern = /^goldis_migration_smoke_[a-z0-9_]+$/;
if (!databaseTemplate || !databasePattern.test(targetDatabase ?? "")) {
  console.error("W2_INTEGRATION_SMOKE_USAGE: isolated goldis_migration_smoke_* database required");
  process.exit(2);
}

const databaseUrlObject = new URL(databaseTemplate);
databaseUrlObject.pathname = `/${targetDatabase}`;
process.env.DATABASE_URL = databaseUrlObject.toString();
if (!process.env.REDIS_URL) throw new Error("W2_INTEGRATION_SMOKE_REDIS_URL_REQUIRED");

// All portal credentials and identity values used by this smoke are synthetic.
process.env.GOLDIS_ADMIN_USER = "synthetic-smoke-admin";
process.env.GOLDIS_ADMIN_PASSWORD = "synthetic-smoke-password-not-for-reuse";
process.env.SESSION_SECRET = "synthetic-w2-integration-session-secret";
process.env.PUBLIC_APP_ORIGIN = "http://goldis-smoke.local";
process.env.PESEL_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
process.env.PESEL_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({
  "1": Buffer.alloc(32, 5).toString("base64"),
}), "utf8").toString("base64");

const { sequelize, AutomationRun, RunEvent, SourceRow } = require("../dist/db");
const umzug = new Umzug({
  migrations: { glob: path.join(__dirname, "../dist/migrations/0{0[1-9],1[0-5]}-*.js").replace(/\\/g, "/") },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: undefined,
});

function bullConnection(value) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function makeInputWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "REGON", "Osoba Decyzyjna", "NIP", "Adres", "Kod pocztowy", "Miasto"]);
  sheet.addRow(["Fikcyjna Firma Testowa", "012345678", "Ala Testowa", "", "ul. Testowa 1", "00-000", "Miasto Testowe"]);
  sheet.addRow(["Fikcyjny Brak REGON", "", "", "0123456789", "ul. Testowa 2", "00-001", "Miasto Testowe"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function persistPipelineCheckpoints(runId, checkpointEvents) {
  const { canTransitionRunStatus } = require("@goldis/core");
  await sequelize.transaction(async (transaction) => {
    const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!run) throw new Error("W2_INTEGRATION_RUN_NOT_FOUND");
    for (const checkpoint of checkpointEvents) {
      const previous = run.status;
      if (!canTransitionRunStatus(previous, checkpoint.status)) throw new Error("W2_INTEGRATION_TRANSITION_INVALID");
      const createdAt = new Date(checkpoint.createdAt);
      run.status = checkpoint.status;
      run.currentStep = checkpoint.step;
      run.lastSafeStep = checkpoint.step;
      run.adapterVersion = "synthetic-integration-v1";
      run.errorCode = checkpoint.errorCode;
      run.updatedAt = createdAt;
      await run.save({ transaction });
      await RunEvent.create({
        runId,
        status: checkpoint.status,
        step: checkpoint.step,
        errorCode: checkpoint.errorCode,
        metadata: { testOnly: true },
        createdAt,
      }, { transaction });
    }
  });
}

async function executeSyntheticPipeline(runId, pool, exportRoot) {
  const { validateAndParkRun } = require("../../worker/dist/run-worker");
  const { runPipeline } = require("../../worker/dist/pipeline");
  const { SyntheticEverestProvider } = require("../../worker/dist/identity-fixtures");
  const { SyntheticPolicyProvider } = require("../../worker/dist/oc-fixtures");
  const { MemoryRunRepository } = require("../../worker/dist/test-support/memory-run-repository");
  const { persistOcSnapshot } = require("../dist/oc-snapshot-store");
  const { evaluateStoredSnapshot } = require("../dist/run-evaluation");
  const { finalizeRunExport } = require("../dist/export-finalizer");
  const { ExportArtifact, OcPolicyRecord, OcSnapshot } = require("../dist/db");

  await validateAndParkRun(pool, runId);
  const run = await AutomationRun.findByPk(runId);
  const source = run ? await SourceRow.findByPk(run.sourceRowId) : null;
  if (!run || !source || run.status !== "awaiting_portal_adapter") throw new Error("W2_INTEGRATION_RUN_NOT_PARKED");

  const context = {
    run: {
      schemaVersion: 1,
      runId: run.id,
      sourceRowId: source.id,
      batchId: run.batchId,
      referenceDate: run.referenceDate,
      toolId: run.toolId,
    },
    source: {
      id: source.id,
      rowNumber: source.rowNumber,
      companyName: source.companyName,
      decisionMakerName: source.decisionMakerName,
      nipRaw: source.nipRaw,
      address: source.address,
      postalCode: source.postalCode,
      city: source.city,
      regonRaw: source.regonRaw,
      regon: source.regon,
      effectiveRegon: source.effectiveRegon,
      issues: source.issues,
    },
    status: run.status,
    cancelRequested: false,
    identity: null,
  };
  const repository = new MemoryRunRepository(context, { now: () => new Date("2026-09-30T13:00:00.000Z") });
  const policyFixture = new SyntheticPolicyProvider("many_policies");
  let capturedSnapshot = null;
  const result = await runPipeline(runId, {
    identityProvider: new SyntheticEverestProvider("one_business"),
    policyProvider: {
      async verifyAndReadOc(workerContext, identity, signal) {
        const response = await policyFixture.verifyAndReadOc(workerContext, identity, signal);
        if (response.kind === "snapshot") capturedSnapshot = response.snapshot;
        return response;
      },
    },
    repository,
    clock: { now: () => new Date("2026-09-30T13:00:00.000Z") },
  });
  const persistedContext = await repository.load(runId);
  if (result.kind !== "draft_result" || !persistedContext?.identity || !capturedSnapshot
    || result.result.totalOcCount !== 3 || result.result.currentOcCount !== 2) {
    const code = result.kind === "failed" ? result.errorCode : "none";
    const totals = result.kind === "draft_result" ? `${result.result.totalOcCount}/${result.result.currentOcCount}` : "none";
    throw new Error(`W2_INTEGRATION_SYNTHETIC_PIPELINE_FAILED kind=${result.kind} code=${code} totals=${totals} identity=${Boolean(persistedContext?.identity)} snapshot=${Boolean(capturedSnapshot)}`);
  }

  await persistPipelineCheckpoints(runId, repository.events());
  await persistOcSnapshot(runId, persistedContext.identity, capturedSnapshot, { environment: process.env });
  const evaluated = await evaluateStoredSnapshot(runId);
  if (evaluated.outcome !== "export_ready" || evaluated.totalOcCount !== 3 || evaluated.currentOcCount !== 2) {
    throw new Error("W2_INTEGRATION_DATABASE_EVALUATION_MISMATCH");
  }
  const finalized = await finalizeRunExport(runId, { artifactRoot: exportRoot });
  const storedSnapshot = await OcSnapshot.findByPk(runId);
  const policyCount = await OcPolicyRecord.count({ where: { runId } });
  const storedArtifact = await ExportArtifact.findOne({ where: { runId, state: "ready" } });
  const eventRows = await RunEvent.findAll({ where: { runId }, order: [["createdAt", "ASC"]] });
  if (!storedSnapshot || storedSnapshot.totalCount !== 3 || policyCount !== 3
    || !storedArtifact || storedArtifact.artifactId !== finalized.artifactId
    || eventRows.some((event) => JSON.stringify(event.metadata).includes(persistedContext.identity.pesel))) {
    throw new Error("W2_INTEGRATION_PERSISTED_RELATION_MISMATCH");
  }
}

async function main() {
  await sequelize.authenticate();
  await umzug.up();
  const exportRoot = await mkdtemp(path.join(os.tmpdir(), "goldis-w2-integration-"));
  process.env.API_EXPORT_DIR = exportRoot;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let app;
  let worker;
  try {
    const { AppModule } = require("../dist/module");
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    const baseUrl = `http://127.0.0.1:${address.port}/api`;

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: process.env.PUBLIC_APP_ORIGIN },
      body: JSON.stringify({ username: process.env.GOLDIS_ADMIN_USER, password: process.env.GOLDIS_ADMIN_PASSWORD }),
    });
    if (!login.ok) throw new Error("W2_INTEGRATION_SYNTHETIC_LOGIN_FAILED");
    const session = await login.json();
    const cookies = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
    const cookie = cookies.join("; ");
    if (!cookie || typeof session.csrfToken !== "string") throw new Error("W2_INTEGRATION_SESSION_COOKIE_MISSING");
    const authHeaders = { cookie, "X-CSRF-Token": session.csrfToken, origin: process.env.PUBLIC_APP_ORIGIN };

    const xlsx = await makeInputWorkbook();
    const form = new FormData();
    form.append("file", new Blob([xlsx], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "synthetic-transport.xlsx");
    const upload = await fetch(`${baseUrl}/imports`, { method: "POST", headers: authHeaders, body: form });
    if (!upload.ok) throw new Error("W2_INTEGRATION_IMPORT_FAILED");
    const batch = await upload.json();
    if (batch.totalRows !== 2 || batch.readyRows !== 1 || batch.invalidRows !== 1
      || batch.regonLookupReadyRows !== 1 || batch.regonLookupReviewRows !== 0) {
      throw new Error("W2_INTEGRATION_IMPORT_COUNTS_MISMATCH");
    }
    const previewResponse = await fetch(`${baseUrl}/imports/${batch.id}/rows`, { headers: authHeaders });
    const previewRows = await previewResponse.json();
    if (!previewResponse.ok || previewRows.length !== 2
      || previewRows[0].regonRaw !== "012345678" || previewRows[0].effectiveRegon !== "012345678"
      || previewRows[0].regonLookupEligibility !== "REGON_PRESENT"
      || previewRows[1].regonRaw !== "" || previewRows[1].effectiveRegon !== null
      || previewRows[1].regonLookupEligibility !== "eligible") {
      throw new Error("W2_INTEGRATION_REGON_LOOKUP_ELIGIBILITY_MISMATCH");
    }

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST", headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ batchId: batch.id, rowNumber: 2 }),
    });
    if (!runResponse.ok) throw new Error("W2_INTEGRATION_RUN_CREATE_FAILED");
    const createdRun = await runResponse.json();
    if (createdRun.status !== "queued") throw new Error("W2_INTEGRATION_RUN_NOT_QUEUED");
    await AutomationRun.update({ referenceDate: "2026-09-29" }, { where: { id: createdRun.id } });

    worker = new BullWorker("oc-verification", async (job) => {
      if (Object.keys(job.data).sort().join(",") !== "runId" || job.data.runId !== createdRun.id) {
        throw new Error("W2_INTEGRATION_QUEUE_PAYLOAD_MISMATCH");
      }
      await executeSyntheticPipeline(job.data.runId, pool, exportRoot);
    }, { connection: bullConnection(process.env.REDIS_URL), concurrency: 1, maxStalledCount: 1 });
    let processorFailure = null;
    worker.on("failed", (_job, error) => { processorFailure = error instanceof Error ? error.message : "TEST_JOB_FAILED"; });
    await worker.waitUntilReady();

    let details;
    for (let attempt = 0; attempt < 100; attempt++) {
      await sleep(100);
      if (processorFailure) throw new Error(`W2_INTEGRATION_TEST_JOB_FAILED ${processorFailure}`);
      const response = await fetch(`${baseUrl}/runs/${createdRun.id}`, { headers: authHeaders });
      if (!response.ok) throw new Error("W2_INTEGRATION_RUN_READ_FAILED");
      details = await response.json();
      if (details.status === "completed") break;
      if (details.status === "failed") throw new Error("W2_INTEGRATION_RUN_FAILED");
    }
    if (details?.status !== "completed" || details.policyCounts?.totalOcCount !== 3
      || details.policyCounts?.currentOcCount !== 2 || details.artifactAvailable !== true) {
      throw new Error("W2_INTEGRATION_RUN_DETAILS_MISMATCH");
    }

    const download = await fetch(`${baseUrl}/runs/${createdRun.id}/artifact`, { headers: authHeaders });
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    const { ExportArtifact } = require("../dist/db");
    const artifactRecord = await ExportArtifact.findOne({ where: { runId: createdRun.id, state: "ready" } });
    if (!download.ok || download.headers.get("cache-control") !== "private, no-store"
      || !/filename\*?=.*\.xlsx/i.test(download.headers.get("content-disposition") ?? "")
      || !artifactRecord
      || createHash("sha256").update(downloadedBytes).digest("hex") !== artifactRecord.sha256) {
      throw new Error("W2_INTEGRATION_DOWNLOAD_FAILED");
    }
    const output = new ExcelJS.Workbook();
    await output.xlsx.load(downloadedBytes);
    const sheet = output.getWorksheet("Polisy OC");
    const exportedEndDates = sheet ? [sheet.getRow(2).getCell(15).text, sheet.getRow(3).getCell(15).text] : [];
    if (!sheet || sheet.rowCount !== 3 || sheet.columnCount !== 15
      || exportedEndDates.join(",") !== "2026-09-29,2026-09-30") {
      throw new Error("W2_INTEGRATION_XLSX_CONTENT_MISMATCH");
    }
    console.log("W2_INTEGRATION_SMOKE_PASS importRows=2 regonLookupEligible=1 leadingZeroNipPreserved=true queuePayload=runId-only syntheticPipeline=true snapshot=3 current=2 completed=true xlsxRows=2 download=verified isolation=test-redis-and-db");
  } finally {
    if (worker) await worker.close();
    if (app) await app.close();
    await pool.end();
    await sequelize.close();
    await rm(exportRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("W2_INTEGRATION_SMOKE_FAILED", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
});
