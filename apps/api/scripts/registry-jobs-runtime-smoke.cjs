"use strict";

const assert = require("node:assert/strict");
const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function validNip(prefixNumber) {
  const prefix = String(prefixNumber).padStart(9, "0").slice(-9);
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11;
  if (checksum === 10) return validNip(prefixNumber + 1);
  return `${prefix}${checksum}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function stopWorker(worker) {
  if (!worker || worker.exitCode !== null) return;
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  worker.kill("SIGTERM");
  const terminated = await Promise.race([exited.then(() => true), wait(5_000).then(() => false)]);
  if (!terminated) {
    worker.kill("SIGKILL");
    await Promise.race([exited, wait(2_000)]);
  }
}

function sessionCookies({ sessionId, userId, tenantId, secret, csrf }) {
  const payload = Buffer.from(JSON.stringify({
    v: 2, sessionId, exp: Date.now() + 60_000, userId, tenantId, csrf,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
}

async function verifyEnrichmentTransactionBoundaries(models, batchId) {
  const { RegistryEnrichmentService } = require("../dist/features/enrichment/public");
  const service = new RegistryEnrichmentService();
  const staleNip = validNip(124019002);
  const rollbackNip = validNip(124019003);
  const staleRowId = randomUUID();
  const rollbackRowId = randomUUID();
  const makeRow = (id, rowNumber, nipRaw, rowVersion) => ({
    id, batchId, rowNumber, companyName: `Synthetic Transaction Company ${rowNumber}`,
    decisionMakerName: null, nipRaw, address: "Synthetic", postalCode: "00-000", city: "Test City",
    regonRaw: "", regon: null, effectiveRegon: null, rowVersion, issues: ["REGON_EMPTY"],
  });
  const resultFor = (nip, name) => ({
    providerName: "mf-vat", providerVersion: "transaction-fixture", dataVersion: null,
    fetchedAt: new Date(), candidates: [{ nip, name, regon: "987654321" }],
  });
  const migrationId = randomUUID().replaceAll("-", "");
  const functionName = `test_reject_registry_audit_${migrationId}`;
  const triggerName = `test_reject_registry_audit_${migrationId}`;
  let triggerInstalled = false;
  try {
    await models.SourceRow.bulkCreate([
      makeRow(staleRowId, 19_002, staleNip, 2),
      makeRow(rollbackRowId, 19_003, rollbackNip, 1),
    ]);

    await assert.rejects(
      service.recordResult(batchId, 19_002, 1, resultFor(staleNip, "Synthetic Transaction Company 19002")),
      (error) => error?.message?.includes("Wiersz został zmieniony"),
      "STALE_ROW_VERSION_MUST_REJECT_ENRICHMENT",
    );
    let row = await models.SourceRow.findByPk(staleRowId);
    assert.equal(row.rowVersion, 2, "STALE_RESULT_MUST_NOT_CHANGE_ROW_VERSION");
    assert.equal(row.effectiveRegon, null, "STALE_RESULT_MUST_NOT_CHANGE_EFFECTIVE_REGON");
    assert.equal(await models.RegistryEnrichmentAudit.count({ where: { sourceRowId: staleRowId } }), 0,
      "STALE_RESULT_MUST_NOT_CREATE_AUDIT");

    await models.sequelize.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'TEST_AUDIT_INJECTED_FAILURE'; RETURN NEW; END; $$`,
    );
    await models.sequelize.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON regon_enrichment_audits
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    triggerInstalled = true;
    await assert.rejects(
      service.recordResult(batchId, 19_003, 1, resultFor(rollbackNip, "Synthetic Transaction Company 19003")),
      (error) => JSON.stringify(error).includes("TEST_AUDIT_INJECTED_FAILURE")
        || String(error?.message ?? "").includes("TEST_AUDIT_INJECTED_FAILURE"),
      "AUDIT_FAILURE_MUST_ABORT_ENRICHMENT_TRANSACTION",
    );
    row = await models.SourceRow.findByPk(rollbackRowId);
    assert.equal(row.rowVersion, 1, "AUDIT_FAILURE_MUST_ROLL_BACK_ROW_VERSION");
    assert.equal(row.effectiveRegon, null, "AUDIT_FAILURE_MUST_ROLL_BACK_REGON");
    assert.equal(await models.RegistryEnrichmentAudit.count({ where: { sourceRowId: rollbackRowId } }), 0,
      "AUDIT_FAILURE_MUST_NOT_LEAVE_AUDIT");
    const cached = await models.sequelize.query(
      "SELECT 1 FROM registry_lookup_cache WHERE nip_normalized = $1",
      { bind: [rollbackNip] },
    );
    assert.equal(cached[0].length, 0, "AUDIT_FAILURE_MUST_ROLL_BACK_LOOKUP_CACHE");
    console.log("ENRICHMENT_TRANSACTION_BOUNDARIES_PASS staleRowVersionRejected=true auditFailureRolledBackRowAndCache=true");
  } finally {
    if (triggerInstalled) {
      await models.sequelize.query(`DROP TRIGGER IF EXISTS ${triggerName} ON regon_enrichment_audits`);
      await models.sequelize.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    await models.SourceRow.destroy({ where: { id: [staleRowId, rollbackRowId] } });
  }
}

async function run(seed) {
  assert.ok(process.env.DATABASE_URL, "DISPOSABLE_DATABASE_URL_REQUIRED");
  const models = require("../dist/infrastructure/database/db");
  const tenantId = seed.goldisTenantId;
  const userId = seed.goldisActorId;
  const batchId = seed.goldis.batchId;
  assert.ok(tenantId && userId && batchId, "REGISTRY_RUNTIME_SEED_REQUIRED");

  const secret = `synthetic-runtime-session-${randomBytes(24).toString("hex")}`;
  const csrf = randomBytes(32).toString("base64url");
  const publicOrigin = "http://registry-runtime.synthetic";
  const previousSecret = process.env.SESSION_SECRET;
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  process.env.SESSION_SECRET = secret;
  process.env.PUBLIC_APP_ORIGIN = publicOrigin;

  const companyName = "Synthetic Runtime HTTP Company";
  const nip = validNip(124019001);
  const regon = "987654321";
  const fixtureCompanies = new Map([[nip, { companyName, regon }]]);
  const rowNumber = 19_001;
  const sourceRowId = randomUUID();
  const now = new Date();
  let app;
  let worker;
  const workers = [];
  let fixtureServer;
  let apiUrl;
  let registryUrl;
  let registryRequests = 0;
  let fixtureRejectedRequests = 0;
  const workerOutput = [];

  try {
    await models.SourceRow.create({
      id: sourceRowId, batchId, rowNumber, companyName, decisionMakerName: null, nipRaw: nip,
      address: "Synthetic", postalCode: "00-000", city: "Test City", regonRaw: "", regon: null,
      effectiveRegon: null, rowVersion: 1, issues: ["REGON_EMPTY"],
    });
    const sessionId = randomUUID();
    await models.UserSession.create({
      sessionId, tenantId, userId, createdAt: now, lastSeenAt: now, lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000), revokedAt: null, revokedBy: null,
      revokeReason: null, ipHash: null, browserLabel: "Synthetic test runner",
    });
    const operatorMembership = await models.TenantMembership.findOne({
      where: { tenantId, role: "operator", status: "active" }, attributes: ["userId"],
    });
    assert.ok(operatorMembership, "SYNTHETIC_OPERATOR_REQUIRED_FOR_ADMIN_GUARD_TEST");
    const operatorSessionId = randomUUID();
    await models.UserSession.create({
      sessionId: operatorSessionId, tenantId, userId: operatorMembership.userId, createdAt: now, lastSeenAt: now, lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000), revokedAt: null, revokedBy: null,
      revokeReason: null, ipHash: null, browserLabel: "Synthetic operator test runner",
    });

    fixtureServer = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = request.method === "GET" && requestUrl.pathname.match(/^\/api\/search\/nips\/([0-9,]+)$/);
      if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(requestUrl.searchParams.get("date") ?? "")) {
        fixtureRejectedRequests += 1;
        response.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      const requested = match[1].split(",");
      const fixture = requested.length === 1 ? fixtureCompanies.get(requested[0]) : null;
      if (!fixture) {
        fixtureRejectedRequests += 1;
        response.writeHead(400, { "content-type": "application/json" }).end("{}");
        return;
      }
      registryRequests += 1;
      const body = JSON.stringify({ result: { entries: [{ identifier: requested[0], subjects: [{ nip: requested[0], name: fixture.companyName, regon: fixture.regon }] }] } });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
    await new Promise((resolve, reject) => {
      fixtureServer.once("error", reject);
      fixtureServer.listen(0, "127.0.0.1", resolve);
    });
    const registryPort = fixtureServer.address().port;
    registryUrl = `http://127.0.0.1:${registryPort}/`;

    const { createHttpApplication } = require("../dist/infrastructure/http/index");
    const { DatabaseModule } = require("../dist/infrastructure/database");
    const { EnrichmentJobController, EnrichmentJobService } = require("../dist/features/enrichment/public");
    const { EnrichmentJobsRepository } = require("../dist/features/enrichment/enrichment-jobs.repository");
    const { HealthModule } = require("../dist/features/health");
    const { AdminOverviewController } = require("../dist/features/admin/admin-overview.controller");
    const { AdminOverviewRepository } = require("../dist/features/admin/admin-overview.repository");
    const { AdminOverviewService } = require("../dist/features/admin/admin-overview.service");
    const { AdminOperationsController } = require("../dist/features/admin/admin-operations.controller");
    const { AdminOperationsRepository } = require("../dist/features/admin/admin-operations.repository");
    const { AdminOperationsService } = require("../dist/features/admin/admin-operations.service");
    const { AdminMutationsService } = require("../dist/features/admin/admin-mutations.service");
    const { AdminMutationsRepository } = require("../dist/features/admin/admin-mutations.repository");
    const { AuditRepository } = require("../dist/features/audit/audit.repository");
    const { AuditService } = require("../dist/features/audit/audit.service");
    const { AdminOnlyGuard } = require("../dist/features/admin/admin.support");
    const { APP_GUARD } = require("@nestjs/core");
    const { Module } = require("@nestjs/common");
    const { RequestProtectionGuard } = require("../dist/infrastructure/http/index");
    const { SessionGuard, SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER,
      resolveCurrentSessionRole, resolveMustChangePassword } = require("../dist/features/auth/index");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard, resolvePermissionResource } = require("../dist/features/authorization/index");
    class RegistryRuntimeSmokeModule {}
    Module({
      imports: [DatabaseModule, HealthModule],
      controllers: [EnrichmentJobController, AdminOverviewController, AdminOperationsController],
      providers: [
        SessionGuard, PermissionGuard, AdminOnlyGuard, EnrichmentJobService, EnrichmentJobsRepository,
        AdminOverviewRepository, AdminOverviewService,
        AdminOperationsService, AdminOperationsRepository, AdminMutationsRepository, AdminMutationsService, AuditRepository, AuditService,
        { provide: APP_GUARD, useClass: RequestProtectionGuard },
        { provide: SESSION_ROLE_RESOLVER, useValue: resolveCurrentSessionRole },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: resolveMustChangePassword },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: resolvePermissionResource },
      ],
    })(RegistryRuntimeSmokeModule);
    app = await createHttpApplication(RegistryRuntimeSmokeModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    const apiPort = app.getHttpServer().address().port;
    apiUrl = `http://127.0.0.1:${apiPort}/api`;

    const initialHealthResponse = await fetch(`${apiUrl}/health/enrichment`);
    const initialHealth = await initialHealthResponse.json();
    assert.equal(initialHealthResponse.status, 503, "WORKER_MUST_START_OFFLINE");
    assert.equal(initialHealth.worker, "offline");
    assert.equal(initialHealth.provider, "unknown");
    const adminCookie = sessionCookies({ sessionId, userId, tenantId, secret, csrf });
    const operatorCookie = sessionCookies({ sessionId: operatorSessionId, userId: operatorMembership.userId, tenantId, secret, csrf });
    const publicHealth = await (await fetch(`${apiUrl}/health`)).json();
    assert.deepEqual(Object.keys(publicHealth).sort(), ["service", "status"]);
    assert.equal(JSON.stringify(publicHealth).includes(secret), false);
    const versionResponse = await fetch(`${apiUrl}/admin/runtime`, { headers: { cookie: adminCookie } });
    assert.equal(versionResponse.status, 200, "ADMIN_RUNTIME_VERSION_ENDPOINT_FAILED");
    const runtimeBeforeWorker = await versionResponse.json();
    assert.equal(runtimeBeforeWorker.schema.latestMigration, "062-enrichment-worker-row-lock-capability.js");
    assert.equal(runtimeBeforeWorker.schema.version, "062");
    assert.equal(runtimeBeforeWorker.enrichment.worker.worker, "offline");
    assert.deepEqual(Object.keys(runtimeBeforeWorker.build).sort(), ["commit", "imageDigest", "version"]);
    assert.equal(JSON.stringify(runtimeBeforeWorker).includes(secret), false);
    assert.equal((await fetch(`${apiUrl}/admin/runtime`, { headers: { cookie: operatorCookie } })).status, 403,
      "NON_ADMIN_READS_RUNTIME_MANIFEST");

    const cookie = adminCookie;
    const body = { idempotencyKey: `synthetic-runtime-${randomUUID()}`, rowNumbers: [rowNumber] };
    const createResponse = await fetch(`${apiUrl}/imports/${batchId}/enrichment-jobs`, {
      method: "POST",
      headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
    assert.equal(createResponse.status, 201, `ENRICHMENT_HTTP_CREATE_FAILED_${createResponse.status}`);
    const created = await createResponse.json();
    assert.equal(created.status, "queued");

    const { provisionRuntimeRoles } = require("./disposable-runtime-roles.cjs");
    const runtimeDatabase = await provisionRuntimeRoles(new URL(process.env.DATABASE_URL).pathname.slice(1));
    const childEnvironment = {
      DATABASE_URL: runtimeDatabase.enrichmentDatabaseUrl,
      NODE_ENV: "test",
      GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
      MF_VAT_ENVIRONMENT: "test",
      MF_VAT_TEST_BASE_URL: registryUrl,
      REGISTRY_CACHE_HMAC_KEY: randomBytes(32).toString("hex"),
      WORKER_LIVE_PORTALS: "0",
      GOLDIS_TEST_MODULE_RUNNER: "1",
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    };
    const launchWorker = () => {
      const child = spawn(process.execPath, [path.resolve(__dirname, "../dist/enrichment-worker.js")], {
        cwd: path.resolve(__dirname, "../../.."), env: childEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      workers.push(child);
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          const diagnosticLines = chunk.split(/(?<=\n)/).filter((line) => line.includes("ENRICHMENT_WORKER_"));
          if (diagnosticLines.length) {
            workerOutput.push(diagnosticLines.join(""));
            while (workerOutput.join("").length > 2_000) workerOutput.shift();
          }
        });
      }
      return child;
    };
    worker = launchWorker();

    const deadline = Date.now() + 20_000;
    let job = null;
    let health = null;
    while (Date.now() < deadline) {
      if (worker.exitCode !== null) throw new Error("ENRICHMENT_WORKER_EXITED_BEFORE_RESULT");
      const [healthResponse, jobResponse] = await Promise.all([
        fetch(`${apiUrl}/health/enrichment`),
        fetch(`${apiUrl}/enrichment-jobs/${created.id}`, { headers: { cookie } }),
      ]);
      health = await healthResponse.json();
      job = await jobResponse.json();
      if (health.worker === "ready" && health.providerName === "mf-vat" && job.status === "completed") break;
      await wait(150);
    }
    assert.equal(health?.worker, "ready", "ENRICHMENT_WORKER_HEALTH_NOT_READY");
    assert.equal(health?.provider, "configured");
    assert.equal(health?.providerName, "mf-vat");
    if (job?.status === "failed") {
      const failedItemsResponse = await fetch(`${apiUrl}/enrichment-jobs/${created.id}/items`, { headers: { cookie } });
      const failedItems = failedItemsResponse.ok ? await failedItemsResponse.json() : null;
      const safeFailures = failedItems?.items?.map((item) => ({ status: item.status, errorCode: item.errorCode, reasonCode: item.reasonCode })) ?? [];
      throw new Error(`ENRICHMENT_HTTP_JOB_FAILED health=${health.worker}/${health.providerName} itemFailures=${JSON.stringify(safeFailures)} workerOutput=${workerOutput.join("").replace(/[\r\n]+/g, " ").slice(0, 240)}`);
    }
    assert.equal(job?.status, "completed",
      `ENRICHMENT_HTTP_JOB_DID_NOT_COMPLETE status=${job?.status} worker=${health?.worker} workerOutput=${workerOutput.join("").replace(/[\r\n]+/g, " ").slice(0, 1_600)}`);
    const runtimeAfterWorkerResponse = await fetch(`${apiUrl}/admin/runtime`, { headers: { cookie } });
    assert.equal(runtimeAfterWorkerResponse.status, 200);
    const runtimeAfterWorker = await runtimeAfterWorkerResponse.json();
    assert.equal(runtimeAfterWorker.enrichment.worker.worker, "ready");
    assert.equal(runtimeAfterWorker.enrichment.worker.providerName, "mf-vat");
    const operationsResponse = await fetch(`${apiUrl}/admin/operations/summary`, { headers: { cookie } });
    assert.equal(operationsResponse.status, 200);
    const operations = await operationsResponse.json();
    assert.equal(operations.enrichment.worker.worker, "ready");
    assert.equal(operations.enrichment.providerBudgets.find((item) => item.providerName === "mf-vat")?.reservedRequests, 1);
    assert.deepEqual(operations.submissionGroups, { pendingCount: 0, oldestPendingAt: null, byStateAndReason: [] });
    assert.deepEqual(operations.submissionCounts, {});

    const itemResponse = await fetch(`${apiUrl}/enrichment-jobs/${created.id}/items`, { headers: { cookie } });
    assert.equal(itemResponse.status, 200);
    const itemPage = await itemResponse.json();
    assert.equal(itemPage.items.length, 1);
    assert.equal(itemPage.items[0].status, "matched");
    const row = await models.SourceRow.findByPk(sourceRowId);
    assert.equal(row.effectiveRegon, regon);
    assert.equal(row.regonRaw, "");
    assert.equal(row.rowVersion, 2);
    assert.equal(registryRequests, 1, "REGISTRY_FIXTURE_REQUEST_COUNT_MISMATCH");
    assert.equal(fixtureRejectedRequests, 0, "REGISTRY_WORKER_SENT_UNEXPECTED_FIXTURE_REQUEST");

    const budgetRows = await models.sequelize.query(
      "SELECT reserved_requests FROM registry_provider_daily_budgets WHERE provider_name = 'mf-vat'",
    );
    assert.equal(budgetRows[0].length, 1);
    assert.equal(Number(budgetRows[0][0].reserved_requests), 1, "REGISTRY_REQUEST_BUDGET_NOT_RESERVED_ONCE");
    const cacheRows = await models.sequelize.query(
      "SELECT nip_hash, result_payload FROM registry_result_cache WHERE provider_name = 'mf-vat'",
    );
    assert.equal(cacheRows[0].length, 1);
    assert.notEqual(cacheRows[0][0].nip_hash, nip);
    assert.equal(JSON.stringify(cacheRows[0][0].result_payload).includes(nip), false);
    assert.equal(JSON.stringify(cacheRows[0][0].result_payload).includes("unnecessaryRawField"), false);
    await verifyEnrichmentTransactionBoundaries(models, batchId);

    await stopWorker(worker);
    // Windows may terminate a child without running its SIGTERM handler. Age only this
    // disposable fixture heartbeat past the production freshness window to model that case.
    await models.sequelize.query(
      `UPDATE enrichment_worker_runtime_status SET observed_at = now() - interval '31 seconds'
       WHERE worker_id = 'registry-enrichment-worker'`,
    );
    const healthAfterStopResponse = await fetch(`${apiUrl}/health/enrichment`);
    assert.equal(healthAfterStopResponse.status, 503, "WORKER_MUST_RETURN_OFFLINE_AFTER_STOP");
    assert.equal((await healthAfterStopResponse.json()).worker, "offline");
    const recoveryNip = validNip(124019004);
    const recoveryRegon = "123456789";
    const recoveryCompany = "Synthetic Persisted Recovery Company";
    const recoveryRowNumber = 19_004;
    fixtureCompanies.set(recoveryNip, { companyName: recoveryCompany, regon: recoveryRegon });
    await models.SourceRow.create({
      id: randomUUID(), batchId, rowNumber: recoveryRowNumber, companyName: recoveryCompany, decisionMakerName: null,
      nipRaw: recoveryNip, address: "Synthetic", postalCode: "00-000", city: "Test City", regonRaw: "", regon: null,
      effectiveRegon: null, rowVersion: 1, issues: ["REGON_EMPTY"],
    });
    const recoveryCreate = await fetch(`${apiUrl}/imports/${batchId}/enrichment-jobs`, {
      method: "POST",
      headers: { cookie, origin: publicOrigin, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ idempotencyKey: `synthetic-restart-${randomUUID()}`, rowNumbers: [recoveryRowNumber] }),
    });
    assert.equal(recoveryCreate.status, 201, "PERSISTED_RECOVERY_JOB_CREATE_FAILED");
    const persistedRecoveryJob = await recoveryCreate.json();
    assert.equal(persistedRecoveryJob.status, "queued", "RECOVERY_JOB_MUST_REMAIN_QUEUED_WHILE_WORKER_STOPPED");
    const beforeRestartResponse = await fetch(`${apiUrl}/enrichment-jobs/${persistedRecoveryJob.id}`, { headers: { cookie } });
    assert.equal((await beforeRestartResponse.json()).status, "queued");

    worker = launchWorker();
    const recoveryDeadline = Date.now() + 20_000;
    let recoveredJob = null;
    let recoveredHealth = null;
    while (Date.now() < recoveryDeadline) {
      if (worker.exitCode !== null) throw new Error("ENRICHMENT_RESTARTED_WORKER_EXITED_BEFORE_RESULT");
      const [healthResponse, jobResponse] = await Promise.all([
        fetch(`${apiUrl}/health/enrichment`),
        fetch(`${apiUrl}/enrichment-jobs/${persistedRecoveryJob.id}`, { headers: { cookie } }),
      ]);
      recoveredHealth = await healthResponse.json();
      recoveredJob = await jobResponse.json();
      if (recoveredHealth.worker === "ready" && recoveredJob.status === "completed") break;
      await wait(150);
    }
    assert.equal(recoveredHealth?.worker, "ready", "RESTARTED_WORKER_DID_NOT_RECOVER_HEALTH");
    assert.equal(recoveredJob?.status, "completed", "PERSISTED_JOB_NOT_RECOVERED_AFTER_WORKER_RESTART");
    const recoveryRow = await models.SourceRow.findOne({ where: { batchId, rowNumber: recoveryRowNumber } });
    assert.equal(recoveryRow.effectiveRegon, recoveryRegon);
    assert.equal(recoveryRow.regonRaw, "");
    assert.equal(recoveryRow.rowVersion, 2);
    assert.equal(registryRequests, 2, "RESTART_RECOVERY_MUST_LOOKUP_ONCE");
    assert.equal(fixtureRejectedRequests, 0, "RESTARTED_WORKER_SENT_UNEXPECTED_FIXTURE_REQUEST");
    const recoveredBudgetRows = await models.sequelize.query(
      "SELECT reserved_requests FROM registry_provider_daily_budgets WHERE provider_name = 'mf-vat'",
    );
    assert.equal(Number(recoveredBudgetRows[0][0].reserved_requests), 2, "RESTART_MUST_PRESERVE_AND_INCREMENT_DAILY_BUDGET");
    const recoveredCacheRows = await models.sequelize.query(
      "SELECT nip_hash, result_payload FROM registry_result_cache WHERE provider_name = 'mf-vat'",
    );
    assert.equal(recoveredCacheRows[0].length, 2, "RESTART_RECOVERY_CACHE_RECORD_COUNT_MISMATCH");
    for (const row of recoveredCacheRows[0]) {
      assert.equal(JSON.stringify(row.result_payload).includes(recoveryNip) || JSON.stringify(row.result_payload).includes(nip), false);
      assert.notEqual(row.nip_hash, nip);
      assert.notEqual(row.nip_hash, recoveryNip);
    }
    await models.sequelize.query(
      `UPDATE registry_provider_daily_budgets SET daily_limit = 2
       WHERE provider_name = 'mf-vat' AND usage_date = (now() AT TIME ZONE 'Europe/Warsaw')::date`,
    );
    const limitedOperationsResponse = await fetch(`${apiUrl}/admin/operations/summary`, { headers: { cookie } });
    assert.equal(limitedOperationsResponse.status, 200);
    const limitedOperations = await limitedOperationsResponse.json();
    const mfBudget = limitedOperations.enrichment.providerBudgets.find((item) => item.providerName === "mf-vat");
    assert.equal(mfBudget.reservedRequests, 2);
    assert.equal(mfBudget.remainingRequests, 0);
    assert.equal(mfBudget.limitReached, true);
    assert.ok(mfBudget.resetsAt && Date.parse(mfBudget.resetsAt) > Date.now(), "LIMIT_RESET_TIME_MUST_BE_IN_FUTURE");
    const resetParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(mfBudget.resetsAt)).map((part) => [part.type, part.value]));
    const usageDay = new Date(`${mfBudget.usageDate}T00:00:00Z`);
    usageDay.setUTCDate(usageDay.getUTCDate() + 1);
    const expectedResetDate = `${usageDay.getUTCFullYear()}-${String(usageDay.getUTCMonth() + 1).padStart(2, "0")}-${String(usageDay.getUTCDate()).padStart(2, "0")}`;
    assert.equal(`${resetParts.year}-${resetParts.month}-${resetParts.day}`, expectedResetDate, "BUDGET_RESET_MUST_BE_NEXT_WARSAW_DAY");
    assert.equal(`${resetParts.hour}:${resetParts.minute}:${resetParts.second}`, "00:00:00", "BUDGET_RESET_MUST_BE_WARSAW_MIDNIGHT");
    console.log("ENRICHMENT_HTTP_RUNTIME_SMOKE_PASS createStatus=201 job=completed result=matched workerRestart=true persistedQueuedJob=recovered provider=local-mf-fixture requests=2 budget=2 resetWarsawMidnight=true rawNipCached=false workerOfflineBeforeStartAndAfterStop=true");
  } finally {
    await Promise.all(workers.map((child) => stopWorker(child)));
    if (app) await app.close();
    await closeServer(fixtureServer);
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = previousOrigin;
    const failedWorker = workers.find((child) => child.exitCode !== null && child.exitCode !== 0);
    if (workerOutput.length && failedWorker) {
      throw new Error(`ENRICHMENT_WORKER_CHILD_FAILED output=${workerOutput.join("").replace(/[\r\n]+/g, " ").slice(0, 300)}`);
    }
  }
}

module.exports = run;
