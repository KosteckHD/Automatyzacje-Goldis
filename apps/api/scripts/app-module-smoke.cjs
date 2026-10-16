"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createHook } = require("node:async_hooks");
const { API_DATABASE, assertSequelizeRuntimeDatabaseRole } = require("../dist/infrastructure/database");
const { apiRequestBudgetMiddleware, createHttpApplication } = require("../dist/infrastructure/http");
const { AppModule } = require("../dist/composition/module");
const { assertDeletionJournalApplied } = require("../dist/features/deletions/deletion-journal-admission");
const { LoginRateLimiter } = require("../dist/features/auth/index");
const ExcelJS = require("exceljs");
const { verifySchemaCatalog } = require("./schema-catalog-contract.cjs");
const socketOrigins = new WeakMap();
createHook({
  init(_asyncId, type, _triggerAsyncId, resource) {
    if (type === "TCPWRAP") socketOrigins.set(resource, new Error().stack?.split("\n").slice(2, 8).join("\n"));
  },
}).enable();

function assertDisposableTargets() {
  if (process.env.GOLDIS_TEST_APP_MODULE_SMOKE !== "1" || process.env.GOLDIS_TEST_REDIS_DISPOSABLE !== "1") {
    throw new Error("APP_MODULE_SMOKE_DISPOSABLE_MARKERS_REQUIRED");
  }
  const database = new URL(process.env.DATABASE_URL || "");
  const redis = new URL(process.env.REDIS_URL || "");
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!new Set(["postgres:", "postgresql:"]).has(database.protocol) || database.username !== "goldis_api"
    || !database.pathname.startsWith("/goldis_migration_smoke_")
    || !loopback.has(database.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("APP_MODULE_SMOKE_DATABASE_TARGET_INVALID");
  }
  if (redis.protocol !== "redis:" || !loopback.has(redis.hostname.replace(/^\[|\]$/g, ""))
    || !/^\/(?:0|15)$/.test(redis.pathname) || redis.search || redis.hash) {
    throw new Error("APP_MODULE_SMOKE_REDIS_TARGET_INVALID");
  }
  if (!process.env.GOLDIS_DELETION_JOURNAL_DIR || !process.env.API_EXPORT_DIR) {
    throw new Error("APP_MODULE_SMOKE_TEMP_PATHS_REQUIRED");
  }
}

async function expectHealth(baseUrl, endpoint, expectedStatus, expectedBody) {
  const result = await new Promise((resolve, reject) => {
    const request = http.get(new URL(endpoint, baseUrl), { agent: false, timeout: 5_000 }, (response) => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { content += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(content) }); }
        catch { reject(new Error("APP_MODULE_SMOKE_HTTP_JSON_INVALID")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("APP_MODULE_SMOKE_HTTP_TIMEOUT")));
    request.on("error", reject);
  });
  if (result.status !== expectedStatus || JSON.stringify(result.body) !== JSON.stringify(expectedBody)) {
    throw new Error(`APP_MODULE_SMOKE_HTTP_UNEXPECTED_${endpoint.replace(/\W/g, "_")}`);
  }
}

async function verifyRuntimeImport(baseUrl, connection, cookies, csrfToken, userId) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "NIP"]);
  sheet.addRow(["Firma syntetyczna runtime", "1234563218"]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsedRows = await require("../dist/features/imports/workbook").parseTransportWorkbook(bytes);
  if (parsedRows.length !== 1 || parsedRows[0].companyName !== "Firma syntetyczna runtime") {
    throw new Error("APP_MODULE_RUNTIME_IMPORT_FIXTURE_INVALID");
  }
  const upload = new FormData();
  upload.set("file", new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "runtime-role-import.xlsx");
  const response = await fetch(new URL("/api/imports", baseUrl), {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3000",
      cookie: cookies.map((cookie) => cookie.split(";", 1)[0]).join("; "),
      "x-csrf-token": csrfToken,
    },
    body: upload,
    signal: AbortSignal.timeout(15_000),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("APP_MODULE_RUNTIME_IMPORT_JSON_INVALID"); }
  const importContract = {
    created: response.status === 201,
    batchId: typeof payload?.id === "string",
    totalRows: payload?.totalRows === 1,
    invalidRows: payload?.invalidRows === 1,
    readyRows: payload?.readyRows === 0,
    regonLookupReadyRows: payload?.regonLookupReadyRows === 1,
    sha256: typeof payload?.sha256 === "string" && /^[0-9a-f]{64}$/.test(payload.sha256),
  };
  if (Object.values(importContract).some((matches) => !matches)) {
    throw new Error(`APP_MODULE_RUNTIME_IMPORT_HTTP_CONTRACT_INVALID_${JSON.stringify(importContract)}`);
  }
  const [roleRows] = await connection.query("SELECT current_user AS role");
  const batch = await connection.models.ImportBatch.findByPk(payload.id);
  const sourceRow = await connection.models.SourceRow.findOne({ where: { batchId: payload.id } });
  const audit = await connection.models.AuditEvent.findOne({
    where: { actorUserId: userId, action: "import.created", resourceId: payload.id, outcome: "succeeded" },
  });
  if (roleRows[0]?.role !== "goldis_api" || !batch || !sourceRow || sourceRow.companyName !== "Firma syntetyczna runtime"
    || sourceRow.nipRaw !== "1234563218" || sourceRow.effectiveRegon !== null || !audit) {
    throw new Error("APP_MODULE_RUNTIME_IMPORT_PERSISTENCE_INCOMPLETE");
  }
  console.log("RUNTIME_API_IMPORT_PASS role=goldis_api batch=true rows=1 audit=true");
  await verifyImportAuditRollback(connection, batch.tenantId, userId);
  return {
    batchId: payload.id,
    sourceRowId: sourceRow.id,
    companyName: sourceRow.companyName,
    nipRaw: sourceRow.nipRaw,
    tenantId: batch.tenantId,
    userId,
  };
}

async function verifyImportAuditRollback(connection, tenantId, ownerUserId) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "NIP"]);
  sheet.addRow(["Firma syntetyczna rollback", "9876543210"]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileName = `runtime-audit-rollback-${randomUUID()}.xlsx`;
  const before = await connection.models.ImportBatch.count({ where: { tenantId, fileName } });
  if (before !== 0) throw new Error("RUNTIME_IMPORT_ROLLBACK_FIXTURE_COLLISION");

  const { ImportService } = require("../dist/features/imports/import.service");
  const { ImportsRepository } = require("../dist/features/imports/imports.repository");
  const service = new ImportService(connection, new ImportsRepository(connection), {
    record: async () => { throw new Error("SYNTHETIC_IMPORT_AUDIT_FAILURE"); },
  });
  let failureObserved = false;
  try {
    await service.create({ buffer: bytes, originalname: fileName }, tenantId, ownerUserId);
  } catch (error) {
    failureObserved = error?.message === "SYNTHETIC_IMPORT_AUDIT_FAILURE";
    if (!failureObserved) throw error;
  }
  const remaining = await connection.models.ImportBatch.count({ where: { tenantId, fileName } });
  const [rowCounts] = await connection.query(
    `SELECT count(*)::int AS count FROM source_rows source
      JOIN import_batches batch ON batch.id = source.batch_id
     WHERE batch.tenant_id = :tenantId AND batch.file_name = :fileName`,
    { replacements: { tenantId, fileName } },
  );
  if (!failureObserved || remaining !== 0 || Number(rowCounts[0]?.count ?? 0) !== 0) {
    throw new Error("RUNTIME_IMPORT_AUDIT_FAILURE_DID_NOT_ROLL_BACK_BATCH_AND_ROWS");
  }
  console.log("RUNTIME_API_IMPORT_ROLLBACK_PASS auditFailure=true batch=false rows=false");
}

async function verifyRuntimeEnrichmentJob(baseUrl, imported, cookies, csrfToken) {
  const response = await fetch(new URL(`/api/imports/${imported.batchId}/enrichment-jobs`, baseUrl), {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3000",
      cookie: cookies.map((cookie) => cookie.split(";", 1)[0]).join("; "),
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ idempotencyKey: "runtime-enrichment-smoke-0001", rowNumbers: [2] }),
    signal: AbortSignal.timeout(15_000),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("APP_MODULE_RUNTIME_ENRICHMENT_JSON_INVALID"); }
  if (response.status !== 201 || !payload || typeof payload.id !== "string" || payload.status !== "queued"
    || payload.selectedCount !== 1 || payload.completedCount !== 0 || payload.excludedCount !== 0
    || payload.failedCount !== 0) {
    throw new Error(`APP_MODULE_RUNTIME_ENRICHMENT_HTTP_${response.status}_${JSON.stringify(payload)}`);
  }
  const fixturePath = process.env.GOLDIS_TEST_RUNTIME_ENRICHMENT_FIXTURE_PATH;
  const exportRoot = path.resolve(process.env.API_EXPORT_DIR || "");
  const resolvedFixture = path.resolve(fixturePath || "");
  if (!fixturePath || path.dirname(resolvedFixture) !== exportRoot || path.basename(resolvedFixture) !== "runtime-enrichment-fixture.json") {
    throw new Error("APP_MODULE_RUNTIME_ENRICHMENT_FIXTURE_PATH_INVALID");
  }
  fs.writeFileSync(resolvedFixture, JSON.stringify({
    batchId: imported.batchId,
    jobId: payload.id,
    sourceRowId: imported.sourceRowId,
    tenantId: imported.tenantId,
    userId: imported.userId,
    rowNumber: 2,
    companyName: imported.companyName,
    nipRaw: imported.nipRaw,
    expectedRegon: "123456789",
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log("RUNTIME_API_ENRICHMENT_JOB_PASS role=goldis_api status=queued items=1");
}

async function verifyRuntimeLogin(baseUrl, connection) {
  const username = process.env.GOLDIS_TEST_RUNTIME_LOGIN_USERNAME;
  const password = process.env.GOLDIS_TEST_RUNTIME_LOGIN_PASSWORD;
  if (!username || !password) throw new Error("APP_MODULE_RUNTIME_LOGIN_FIXTURE_REQUIRED");
  const payload = JSON.stringify({ username, password });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(new URL("/api/auth/login", baseUrl), {
      method: "POST",
      agent: false,
      timeout: 10_000,
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
    }, (response) => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { content += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(content), cookies: response.headers["set-cookie"] || [] });
        } catch {
          reject(new Error("APP_MODULE_RUNTIME_LOGIN_JSON_INVALID"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("APP_MODULE_RUNTIME_LOGIN_TIMEOUT")));
    request.on("error", reject);
    request.end(payload);
  });
  if (result.status !== 201 && result.status !== 200) throw new Error(`APP_MODULE_RUNTIME_LOGIN_HTTP_${result.status}`);
  if (result.body.role !== "operator" || result.body.mustChangePassword !== false
    || typeof result.body.csrfToken !== "string" || result.body.csrfToken.length < 32
    || !result.cookies.some((cookie) => cookie.startsWith("goldis_session="))
    || !result.cookies.some((cookie) => cookie.startsWith("goldis_csrf="))) {
    throw new Error("APP_MODULE_RUNTIME_LOGIN_RESPONSE_INVALID");
  }
  const user = await connection.models.User.findOne({
    where: { usernameNormalized: username },
    attributes: ["userId", "lastLoginAt"],
  });
  if (!user?.lastLoginAt) throw new Error("APP_MODULE_RUNTIME_LOGIN_USER_NOT_UPDATED");
  const session = await connection.models.UserSession.findOne({ where: { userId: user.userId, revokedAt: null } });
  const audit = await connection.models.AuditEvent.findOne({
    where: { actorUserId: user.userId, action: "login.succeeded", outcome: "succeeded" },
  });
  if (!session || !audit) throw new Error("APP_MODULE_RUNTIME_LOGIN_PERSISTENCE_INCOMPLETE");
  const imported = await verifyRuntimeImport(baseUrl, connection, result.cookies, result.body.csrfToken, user.userId);
  await verifyRuntimeEnrichmentJob(baseUrl, imported, result.cookies, result.body.csrfToken);
  const logoutPayload = "{}";
  const logout = await new Promise((resolve, reject) => {
    const request = http.request(new URL("/api/auth/logout", baseUrl), {
      method: "POST",
      agent: false,
      timeout: 10_000,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: result.cookies.map((cookie) => cookie.split(";", 1)[0]).join("; "),
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(logoutPayload)),
      },
    }, (response) => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { content += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(content) }); }
        catch { reject(new Error("APP_MODULE_RUNTIME_LOGOUT_JSON_INVALID")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("APP_MODULE_RUNTIME_LOGOUT_TIMEOUT")));
    request.on("error", reject);
    request.end(logoutPayload);
  });
  if (logout.status !== 201 && logout.status !== 200 || logout.body.ok !== true) {
    throw new Error(`APP_MODULE_RUNTIME_LOGOUT_HTTP_${logout.status}`);
  }
  const revokedSession = await connection.models.UserSession.findByPk(session.sessionId);
  if (!revokedSession?.revokedAt) throw new Error("APP_MODULE_RUNTIME_LOGOUT_SESSION_NOT_REVOKED");
  console.log("RUNTIME_API_LOGIN_LOGOUT_PASS role=goldis_api session=true audit=true logout=true");
}

async function verifyRuntimeQueueDispatch(app, connection) {
  const dispatchId = process.env.GOLDIS_TEST_RUNTIME_DISPATCH_ID;
  const runId = process.env.GOLDIS_TEST_RUNTIME_RUN_ID;
  if (!dispatchId || !runId) throw new Error("APP_MODULE_RUNTIME_DISPATCH_FIXTURE_REQUIRED");
  const runService = app.get(require("../dist/features/runs/runs.service").RunService);
  let outbox;
  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await runService.reconcile();
    outbox = await connection.models.RunDispatchOutbox.findByPk(dispatchId);
    job = runService.queue ? await runService.queue.getJob(`dispatch-${dispatchId}`) : null;
    if (outbox?.status === "published" && job) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (outbox?.status !== "published" || !job || job.name !== "verify-row"
    || job.data?.runId !== runId || Object.keys(job.data ?? {}).sort().join(",") !== "runId"
    || job.opts?.jobId !== `dispatch-${dispatchId}` || job.opts?.attempts !== 1) {
    throw new Error("APP_MODULE_RUNTIME_DISPATCH_CONTRACT_INVALID");
  }
  const state = await job.getState();
  if (state !== "waiting" && state !== "delayed") throw new Error("APP_MODULE_RUNTIME_DISPATCH_NOT_QUEUED");
  console.log("RUNTIME_RUN_QUEUE_DISPATCH_PASS role=goldis_api outbox=published job=verify-row payload=runId");
}

async function verifyModelColumns(connection) {
  let checkedColumns = 0;
  let checkedTypes = 0;
  const queryInterface = connection.getQueryInterface();
  const normalizedType = (value) => String(value).toLowerCase().replace(/character varying/g, "varchar")
    .replace(/timestamp with time zone/g, "timestamptz").replace(/timestamp without time zone/g, "timestamp")
    .replace(/time without time zone/g, "time").replace(/\s+/g, " ").trim();
  const expectedType = (attribute) => {
    const key = attribute.type.key;
    if (key === "STRING") return `varchar(${attribute.type.options?.length ?? 255})`;
    return ({
      BIGINT: "bigint", BLOB: "bytea", BOOLEAN: "boolean", DATE: "timestamptz", DATEONLY: "date",
      INTEGER: "integer", JSONB: "jsonb", TEXT: "text", TIME: "time", UUID: "uuid",
    })[key];
  };
  for (const [modelName, model] of Object.entries(connection.models)) {
    const table = model.getTableName();
    const tableName = typeof table === "string" ? table : table.tableName;
    const databaseColumns = await queryInterface.describeTable(tableName);
    const attributes = Object.entries(model.getAttributes());
    const missing = attributes
      .map(([attributeName, attribute]) => attribute.field || attributeName)
      .filter((columnName) => !Object.hasOwn(databaseColumns, columnName));
    if (missing.length) throw new Error(`APP_MODULE_SCHEMA_MODEL_COLUMNS_MISSING_${modelName}_${missing.join("_")}`);
    const nullableMismatches = attributes.flatMap(([attributeName, attribute]) => {
      const columnName = attribute.field || attributeName;
      const modelNullable = attribute.allowNull !== false && attribute.primaryKey !== true;
      const databaseNullable = databaseColumns[columnName].allowNull;
      return modelNullable === databaseNullable ? [] : [columnName];
    });
    if (nullableMismatches.length) {
      throw new Error(`APP_MODULE_SCHEMA_MODEL_NULLABILITY_MISMATCH_${modelName}_${nullableMismatches.join("_")}`);
    }
    const typeMismatches = attributes.flatMap(([attributeName, attribute]) => {
      const columnName = attribute.field || attributeName;
      const expected = expectedType(attribute);
      if (!expected) throw new Error(`APP_MODULE_SCHEMA_MODEL_TYPE_UNSUPPORTED_${modelName}_${columnName}_${attribute.type.key}`);
      checkedTypes += 1;
      return normalizedType(databaseColumns[columnName].type) === expected ? [] : [columnName];
    });
    if (typeMismatches.length) {
      throw new Error(`APP_MODULE_SCHEMA_MODEL_TYPE_MISMATCH_${modelName}_${typeMismatches.join("_")}`);
    }
    checkedColumns += Object.keys(model.getAttributes()).length;
  }
  console.log(`PERSISTENCE_MODEL_SCHEMA_PASS models=${Object.keys(connection.models).length} mapped_columns=${checkedColumns} mapped_types=${checkedTypes}`);
}

async function main() {
  assertDisposableTargets();
  process.env.APP_ENV = "test";
  process.env.GOLDIS_DELETION_WORKER = "0";
  process.env.API_PORT = "0";
  const expectRedisUnavailable = process.env.GOLDIS_TEST_APP_MODULE_EXPECT_REDIS_UNAVAILABLE === "1";
  const expectDatabaseUnavailable = process.env.GOLDIS_TEST_APP_MODULE_EXPECT_DATABASE_UNAVAILABLE === "1";
  if (expectRedisUnavailable && expectDatabaseUnavailable) {
    throw new Error("APP_MODULE_SMOKE_FAILURE_MODES_MUST_BE_ISOLATED");
  }

  let app;
  let secondApp;
  try {
    app = await createHttpApplication(AppModule, { logger: false, cors: false, abortOnError: false }, undefined, {
      trustProxyIps: undefined,
    });
    process.stdout.write("APP_MODULE_SMOKE_APPLICATION_CREATED\n");
    app.enableShutdownHooks();
    await app.init();
    if (!expectDatabaseUnavailable) {
      await assertSequelizeRuntimeDatabaseRole(app.get(API_DATABASE), "goldis_api");
      await verifyModelColumns(app.get(API_DATABASE));
      if (!expectRedisUnavailable || process.env.GOLDIS_TEST_SCHEMA_CATALOG_CAPTURE !== "1") {
        await verifySchemaCatalog(app.get(API_DATABASE), process.env.API_EXPORT_DIR);
      }
      await assertDeletionJournalApplied();
    }
    if (!expectRedisUnavailable && !expectDatabaseUnavailable) {
      secondApp = await createHttpApplication(AppModule, { logger: false, cors: false, abortOnError: false }, undefined, {
        trustProxyIps: undefined,
      });
      await secondApp.init();
      if (secondApp.get(API_DATABASE) !== app.get(API_DATABASE)) {
        throw new Error("APP_MODULE_SMOKE_DATABASE_CONNECTION_NOT_SHARED");
      }
    }
    if (!expectRedisUnavailable) {
      const limiter = app.get(LoginRateLimiter);
      app.use("/api", apiRequestBudgetMiddleware((ip) => limiter.consumeApiRequest(ip)));
    }
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port < 1) {
      throw new Error("APP_MODULE_SMOKE_LISTEN_ADDRESS_INVALID");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await expectHealth(baseUrl, "/api/health/live", 200, { status: "alive", service: "goldis-api" });
    const readinessStatus = expectRedisUnavailable || expectDatabaseUnavailable ? 503 : 200;
    const readinessBody = readinessStatus === 503 ? { status: "not_ready" } : { status: "ready" };
    await expectHealth(baseUrl, "/api/health/ready", readinessStatus, readinessBody);
    if (!expectRedisUnavailable && !expectDatabaseUnavailable) {
      await verifyRuntimeLogin(baseUrl, app.get(API_DATABASE));
      await verifyRuntimeQueueDispatch(app, app.get(API_DATABASE));
    }
    console.log(expectDatabaseUnavailable
      ? "APP_MODULE_FAILURE_SMOKE_PASS live=200 readiness=503 database=unavailable response=safe"
      : expectRedisUnavailable
      ? "APP_MODULE_FAILURE_SMOKE_PASS live=200 readiness=503 redis=unavailable response=safe"
      : "APP_MODULE_SMOKE_PASS providers=initialized database_role=goldis_api health=live,ready redis=owned-disposable");
  } finally {
    if (app) {
      const server = app.getHttpServer();
      server.closeAllConnections?.();
      const redisOwners = [
        ["health", app.get(require("../dist/features/health/health.service").HealthService).redisClient],
        ["login-rate-limiter", app.get(LoginRateLimiter).redis],
      ].filter(([, client]) => client);
      const runQueue = app.get(require("../dist/features/runs/runs.service").RunService).queue;
      const runQueueConnection = runQueue?.connection;
      if (runQueueConnection?._client) redisOwners.push(["run-service-queue", runQueueConnection._client]);
      await app.close();
      if (server.listening) throw new Error("APP_MODULE_SMOKE_HTTP_SERVER_STILL_LISTENING");
      if (secondApp) {
        const secondReady = await secondApp.get(require("../dist/features/health/health.service").HealthService).readiness();
        if (!secondReady) throw new Error("APP_MODULE_SMOKE_SECOND_INSTANCE_DATABASE_LEASE_RELEASED_EARLY");
        redisOwners.push(
          ["health-second-app", secondApp.get(require("../dist/features/health/health.service").HealthService).redisClient],
          ["login-rate-limiter-second-app", secondApp.get(LoginRateLimiter).redis],
        );
        await secondApp.close();
        console.log("APP_MODULE_MULTIPLE_INSTANCES_PASS shared_connection=true second_ready=true");
      }
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const pendingApplicationSockets = process._getActiveHandles()
          .filter((handle) => handle instanceof net.Socket && !handle.destroyed)
          .filter((socket) => ![process.stdin, process.stdout, process.stderr].includes(socket));
        if (pendingApplicationSockets.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const stdio = [
        ["stdin", process.stdin],
        ["stdout", process.stdout],
        ["stderr", process.stderr],
      ];
      const activeSockets = process._getActiveHandles()
        .filter((handle) => handle instanceof net.Socket && !handle.destroyed);
      const stdioHandles = new Set(stdio.map(([, handle]) => handle));
      const processSockets = activeSockets.filter((socket) => !stdioHandles.has(socket));
      const processSocketDetails = processSockets.map((socket) => ({
        peer: `${socket.remoteAddress || "unknown"}:${socket.remotePort || 0}`,
        local: `${socket.localAddress || "unknown"}:${socket.localPort || 0}`,
        state: { connecting: socket.connecting, readyState: socket.readyState, writable: socket.writable, readable: socket.readable },
        redisOwners: redisOwners.filter(([, client]) => client.stream === socket).map(([name]) => name),
        origin: socketOrigins.get(socket._handle) || "origin-not-recorded",
      }));
      for (const socket of processSockets) socket.destroy();
      const activeStdio = stdio.filter(([, handle]) => activeSockets.includes(handle)).map(([name]) => name);
      if (processSocketDetails.length > 0) {
        throw new Error(`APP_MODULE_SMOKE_LEAKED_SOCKETS_${JSON.stringify(processSocketDetails)}`);
      }
      console.log(`APP_MODULE_SHUTDOWN_PASS listener=closed application_sockets=0 active_stdio=${activeStdio.join(",") || "none"}`);
    }
  }
}

main().then(
  () => undefined,
  (error) => {
    process.stderr.write(`APP_MODULE_SMOKE_FAIL ${error instanceof Error ? error.message : "UNKNOWN"}\n`, () => process.exit(1));
  },
);
