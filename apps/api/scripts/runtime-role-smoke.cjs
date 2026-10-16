const { randomBytes, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const net = require("node:net");
const { Client } = require("pg");
const os = require("node:os");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../..");
const databaseName = process.argv[2];
const adminUrlText = process.env.GOLDIS_TEST_DATABASE_ADMIN_URL;
const roles = ["goldis_migrator", "goldis_api", "goldis_worker", "goldis_enrichment"];

function buildRoleUrl(template, database, role, password) {
  const url = new URL(template);
  url.pathname = "/" + database;
  url.username = role;
  url.password = password;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function runNodeScript(script, env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 180_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const reason = result.error?.code || `status_${result.status}_signal_${result.signal || "none"}`;
    throw new Error(`RUNTIME_ROLE_SMOKE_CHILD_FAILED_${path.basename(script, ".cjs")}_${reason}`);
  }
}

async function seedRuntimeLogin(migratorUrl) {
  const username = `runtime-smoke-${randomBytes(8).toString("hex")}`;
  const password = `RuntimeSmoke!${randomBytes(16).toString("hex")}`;
  const userId = randomUUID();
  const batchId = randomUUID();
  const sourceRowId = randomUUID();
  const runId = randomUUID();
  const dispatchId = randomUUID();
  const now = new Date();
  const { hashPassword } = require("../dist/features/auth/password-hash");
  const client = new Client({ connectionString: migratorUrl, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    const tenant = await client.query("SELECT tenant_id FROM tenants WHERE slug = 'goldis'");
    if (tenant.rowCount !== 1) throw new Error("RUNTIME_LOGIN_TENANT_MISSING");
    const passwordHash = await hashPassword(password);
    await client.query(
      `INSERT INTO users (user_id, username, username_normalized, password_hash, status, created_at, updated_at)
       VALUES ($1, $2, $2, $3, 'active', $4, $4)`,
      [userId, username, passwordHash, now],
    );
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, 'operator', 'active', $3, $3)`,
      [tenant.rows[0].tenant_id, userId, now],
    );
    await client.query(
      `INSERT INTO tool_grants
         (tenant_id, tool_id, user_id, can_discover, can_execute, can_view_results, can_download_results,
          granted_by, created_at, updated_at, version)
       VALUES ($1, 'oc-policy-verification', $2, true, true, true, true, NULL, $3, $3, 1)`,
      [tenant.rows[0].tenant_id, userId, now],
    );
    await client.query(
      `INSERT INTO import_batches
         (id, tenant_id, owner_user_id, tool_id, file_name, sha256, total_rows, invalid_rows, created_at)
       VALUES ($1, $2, $3, 'oc-policy-verification', 'runtime-role-fixture.xlsx', $4, 1, 0, $5)`,
      [batchId, tenant.rows[0].tenant_id, userId, "a".repeat(64), now],
    );
    await client.query(
      `INSERT INTO source_rows
         (id, batch_id, row_number, company_name, decision_maker_name, mobile, phone, email, nip_raw,
          address, postal_code, city, regon_raw, regon, effective_regon, row_version, issues, county_code)
       VALUES ($1, $2, 2, 'Runtime fixture company', NULL, '', '', '', '', '', '', '', '', NULL, NULL, 1, '[]'::jsonb, NULL)`,
      [sourceRowId, batchId],
    );
    const snapshot = {
      schemaVersion: 1,
      sourceRowId,
      rowNumber: 2,
      companyName: "Runtime fixture company",
      decisionMakerName: null,
      nipRaw: "",
      address: "",
      postalCode: "",
      city: "",
      countyCode: null,
      regonRaw: "",
      regon: null,
      effectiveRegon: null,
      issues: [],
    };
    await client.query(
      `INSERT INTO automation_runs
         (id, batch_id, source_row_id, row_number, tool_id, status, current_step, reference_date,
          error_code, created_at, updated_at, input_snapshot)
       VALUES ($1, $2, $3, 2, 'oc-policy-verification', 'queued', 'queued', $4, NULL, $5, $5, $6::jsonb)`,
      [runId, batchId, sourceRowId, now.toISOString().slice(0, 10), now, JSON.stringify(snapshot)],
    );
    await client.query(
      `INSERT INTO run_dispatch_outbox
         (dispatch_id, run_id, intent_type, status, attempt_count, next_attempt_at, claimed_at, claimed_by,
          last_error_code, created_at, updated_at)
       VALUES ($1, $2, 'create', 'pending', 0, $3, NULL, NULL, NULL, $3, $3)`,
      [dispatchId, runId, now],
    );
    return { username, password, userId, tenantId: tenant.rows[0].tenant_id, batchId, sourceRowId, runId, dispatchId };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function exerciseWorkerCheckpoint(workerUrl, migratorUrl, fixture) {
  const { Pool } = require("pg");
  const { PgRunRepository } = require(path.join(repositoryRoot, "apps/worker/dist/infrastructure/database/pg-run-repository.js"));
  const pool = new Pool({ connectionString: workerUrl, max: 1, connectionTimeoutMillis: 3_000 });
  try {
    const role = await pool.query("SELECT current_user AS role");
    if (role.rows[0]?.role !== "goldis_worker") throw new Error("RUNTIME_WORKER_CHECKPOINT_WRONG_ROLE");
    const repository = new PgRunRepository(pool);
    const advanced = await repository.transition(fixture.runId, "queued", "validating");
    const replayed = await repository.transition(fixture.runId, "queued", "validating");
    if (!advanced || replayed) throw new Error("RUNTIME_WORKER_CHECKPOINT_STATE_INVALID");
  } finally {
    await pool.end();
  }
  const verify = new Client({ connectionString: migratorUrl, connectionTimeoutMillis: 3_000 });
  try {
    await verify.connect();
    const run = await verify.query("SELECT status FROM automation_runs WHERE id = $1", [fixture.runId]);
    const events = await verify.query(
      "SELECT count(*)::int AS count FROM run_events WHERE run_id = $1 AND status = 'validating'",
      [fixture.runId],
    );
    if (run.rows[0]?.status !== "validating" || events.rows[0]?.count !== 1) {
      throw new Error("RUNTIME_WORKER_CHECKPOINT_PERSISTENCE_INVALID");
    }
  } finally {
    await verify.end().catch(() => undefined);
  }
  console.log("RUNTIME_WORKER_CHECKPOINT_PASS role=goldis_worker updated=true event=true replay=false");
}

async function verifyRuntimeEnrichment(migratorUrl, fixture) {
  if (!fixture || !fixture.batchId || !fixture.jobId || !fixture.sourceRowId) {
    throw new Error("RUNTIME_ENRICHMENT_FIXTURE_MISSING");
  }
  const verify = new Client({ connectionString: migratorUrl, connectionTimeoutMillis: 3_000 });
  try {
    await verify.connect();
    const job = await verify.query(
      "SELECT status, selected_count, completed_count, excluded_count, failed_count FROM enrichment_jobs WHERE job_id = $1 AND batch_id = $2",
      [fixture.jobId, fixture.batchId],
    );
    const item = await verify.query(
      "SELECT status, reason_code, error_code, attempt_count, audit_id FROM enrichment_job_items WHERE job_id = $1 AND source_row_id = $2",
      [fixture.jobId, fixture.sourceRowId],
    );
    const row = await verify.query(
      "SELECT effective_regon, row_version FROM source_rows WHERE id = $1 AND batch_id = $2",
      [fixture.sourceRowId, fixture.batchId],
    );
    const audit = await verify.query(
      `SELECT nip_normalized, provider_name, decision_status, proposed_regon, effective_regon_before,
              effective_regon_after, applied, row_version_before, row_version_after
         FROM regon_enrichment_audits WHERE source_row_id = $1`,
      [fixture.sourceRowId],
    );
    const completedAudit = await verify.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE action = 'enrichment.job.completed' AND resource_id = $1 AND outcome = 'succeeded'",
      [fixture.jobId],
    );
    const actualJob = job.rows[0];
    const actualItem = item.rows[0];
    const actualRow = row.rows[0];
    const actualAudit = audit.rows[0];
    if (job.rowCount !== 1 || actualJob.status !== "completed" || actualJob.selected_count !== 1
      || actualJob.completed_count !== 1 || actualJob.excluded_count !== 0 || actualJob.failed_count !== 0
      || item.rowCount !== 1 || actualItem.status !== "matched" || actualItem.reason_code !== null
      || actualItem.error_code !== null || actualItem.attempt_count !== 1 || !actualItem.audit_id
      || row.rowCount !== 1 || actualRow.effective_regon !== fixture.expectedRegon || actualRow.row_version !== 2
      || audit.rowCount !== 1 || actualAudit.nip_normalized !== fixture.nipRaw
      || actualAudit.provider_name !== "runtime-smoke-provider" || actualAudit.decision_status !== "matched"
      || actualAudit.proposed_regon !== fixture.expectedRegon || actualAudit.effective_regon_before !== null
      || actualAudit.effective_regon_after !== fixture.expectedRegon || actualAudit.applied !== true
      || actualAudit.row_version_before !== 1 || actualAudit.row_version_after !== 2
      || completedAudit.rows[0]?.count !== 1) {
      throw new Error("RUNTIME_ENRICHMENT_PERSISTENCE_INCOMPLETE");
    }
  } finally {
    await verify.end().catch(() => undefined);
  }
  console.log("RUNTIME_ENRICHMENT_PERSISTENCE_PASS job=completed item=matched row=updated audit=recorded");
}

async function verifyRuntimeImportCorrection(databaseUrl, fixture) {
  if (!fixture?.batchId || !fixture?.sourceRowId || !fixture?.tenantId || !fixture?.userId) {
    throw new Error("RUNTIME_IMPORT_CORRECTION_FIXTURE_MISSING");
  }
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;
  const { createApiDatabase, releaseApiDatabase, assertSequelizeRuntimeDatabaseRole } = require("../dist/infrastructure/database");
  const { ImportService } = require("../dist/features/imports/import.service");
  const { ImportsRepository } = require("../dist/features/imports/imports.repository");
  const { AuditRepository } = require("../dist/features/audit/audit.repository");
  const { AuditService } = require("../dist/features/audit/audit.service");
  const database = createApiDatabase(databaseUrl);
  try {
    await database.authenticate();
    await assertSequelizeRuntimeDatabaseRole(database, "goldis_api");
    const imports = new ImportService(
      database,
      new ImportsRepository(database),
      new AuditService(new AuditRepository()),
    );
    const proposal = await imports.proposeRegonCorrection(
      fixture.batchId,
      2,
      { proposedRegon: "987654321", reason: "synthetic runtime review", expectedVersion: 2 },
      fixture.userId,
      { tenantId: fixture.tenantId, actorUserId: fixture.userId },
    );
    const review = await imports.enrichmentReview(fixture.batchId, 1);
    const reviewedRow = review.rows.find((row) => row.rowNumber === 2);
    const persistedRow = await database.models.SourceRow.findByPk(fixture.sourceRowId);
    const audit = await database.models.AuditEvent.findOne({
      where: {
        tenantId: fixture.tenantId,
        actorUserId: fixture.userId,
        action: "regon.correction.proposed",
        resourceId: proposal.correctionId,
        outcome: "succeeded",
      },
    });
    if (proposal.rowVersion !== 3 || !persistedRow || persistedRow.rowVersion !== 3
      || persistedRow.effectiveRegon !== fixture.expectedRegon || !audit
      || review.summary.pendingCorrectionRows !== 1 || review.summary.openConflictRows !== 0
      || review.summary.lookupStatuses.matched !== 1 || reviewedRow?.state !== "correction_pending"
      || reviewedRow.correction?.correctionId !== proposal.correctionId
      || reviewedRow.source !== "registry") {
      throw new Error("RUNTIME_IMPORT_REVIEW_PERSISTENCE_INCOMPLETE");
    }
  } finally {
    await releaseApiDatabase(database);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
  console.log("RUNTIME_API_IMPORT_REVIEW_PASS role=goldis_api correction=true row_version=3 audit=true projection=true");
}

function reserveAndReleaseLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("TEST_LOOPBACK_PORT_INVALID"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function main() {
  if (!/^[a-z0-9_]+$/.test(databaseName || "")) throw new Error("RUNTIME_ROLE_SMOKE_DATABASE_INVALID");
  if (!adminUrlText) throw new Error("GOLDIS_TEST_DATABASE_ADMIN_URL_REQUIRED");
  const adminUrl = new URL(adminUrlText);
  if (!["localhost", "127.0.0.1", "::1"].includes(adminUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase())
    || !["/postgres", "/template1"].includes(adminUrl.pathname)
    || adminUrl.search || adminUrl.hash) {
    throw new Error("LOCAL_TEST_POSTGRES_ADMIN_URL_REQUIRED");
  }

  const passwords = Object.fromEntries(roles.map((role) => [role, randomBytes(32).toString("hex")]));
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 3_000 });
  try {
    await admin.connect();
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (exists.rowCount !== 1) throw new Error("RUNTIME_ROLE_SMOKE_DATABASE_MISSING");
    for (const role of roles) {
      const roleExists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      await admin.query(
        (roleExists.rowCount ? "ALTER ROLE " : "CREATE ROLE ") + role
          + " WITH LOGIN PASSWORD '" + passwords[role]
          + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT",
      );
    }
    await admin.query('ALTER DATABASE "' + databaseName + '" OWNER TO goldis_migrator');
    await admin.query('REVOKE ALL PRIVILEGES ON DATABASE "' + databaseName + '" FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE "' + databaseName + '" TO goldis_api, goldis_worker, goldis_enrichment');
    await admin.query('GRANT CONNECT, TEMPORARY ON DATABASE "' + databaseName + '" TO goldis_migrator');
  } finally {
    await admin.end().catch(() => undefined);
  }

  const migratorUrl = buildRoleUrl(adminUrl.toString(), databaseName, "goldis_migrator", passwords.goldis_migrator);
  const dbAdmin = new Client({ connectionString: migratorUrl, connectionTimeoutMillis: 3_000 });
  try {
    await dbAdmin.connect();
    await dbAdmin.query("REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment");
    await dbAdmin.query("ALTER SCHEMA public OWNER TO goldis_migrator");
    await dbAdmin.query("GRANT USAGE, CREATE ON SCHEMA public TO goldis_migrator");
    await dbAdmin.query("GRANT USAGE ON SCHEMA public TO goldis_api, goldis_worker, goldis_enrichment");
    await dbAdmin.query("ALTER DEFAULT PRIVILEGES FOR ROLE goldis_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment");
    await dbAdmin.query("ALTER DEFAULT PRIVILEGES FOR ROLE goldis_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment");
    await dbAdmin.query("ALTER DEFAULT PRIVILEGES FOR ROLE goldis_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment");
  } finally {
    await dbAdmin.end().catch(() => undefined);
  }

  const roleEnvironment = {
    ...process.env,
    DATABASE_URL: migratorUrl,
    MIGRATOR_DATABASE_URL: migratorUrl,
    WORKER_DATABASE_URL: buildRoleUrl(adminUrl.toString(), databaseName, "goldis_worker", passwords.goldis_worker),
    ENRICHMENT_DATABASE_URL: buildRoleUrl(adminUrl.toString(), databaseName, "goldis_enrichment", passwords.goldis_enrichment),
  };
  runNodeScript("apps/api/dist/infrastructure/database/migrate.js", roleEnvironment);
  runNodeScript("apps/api/dist/infrastructure/database/apply-runtime-grants.js", roleEnvironment);
  runNodeScript("apps/api/scripts/runtime-process-role-probe-smoke.cjs", {
    ...roleEnvironment,
    DATABASE_URL: buildRoleUrl(adminUrl.toString(), databaseName, "goldis_api", passwords.goldis_api),
  });
  runNodeScript("apps/worker/scripts/runtime-role-probe-smoke.cjs", roleEnvironment);
  runNodeScript("apps/api/scripts/runtime-permissions-smoke.cjs", {
    ...roleEnvironment,
    DATABASE_URL: buildRoleUrl(adminUrl.toString(), databaseName, "goldis_api", passwords.goldis_api),
  });
  const runtimeFixture = await seedRuntimeLogin(migratorUrl);
  if (process.env.GOLDIS_TEST_APP_MODULE_SMOKE === "1") {
    if (process.env.GOLDIS_TEST_REDIS_DISPOSABLE !== "1" || !process.env.REDIS_URL) {
      throw new Error("APP_MODULE_SMOKE_REQUIRES_OWNED_REDIS");
    }
    const appModuleTempRoot = mkdtempSync(path.join(os.tmpdir(), "goldis-app-module-smoke-"));
    let enrichmentFixture = null;
    try {
      const enrichmentFixturePath = path.join(appModuleTempRoot, "runtime-enrichment-fixture.json");
      runNodeScript("apps/api/scripts/app-module-smoke.cjs", {
        ...roleEnvironment,
        DATABASE_URL: buildRoleUrl(adminUrl.toString(), databaseName, "goldis_api", passwords.goldis_api),
        API_EXPORT_DIR: appModuleTempRoot,
        GOLDIS_TEST_APP_MODULE_SMOKE: "1",
        SESSION_SECRET: "synthetic-app-module-session-secret-0000000000000000",
        LOGIN_RATE_LIMIT_SECRET: "synthetic-app-module-login-rate-secret-0000000000000000",
        PRIVILEGED_ACTION_BINDING_KEY: "synthetic-app-module-binding-secret-0000000000000000",
        GOLDIS_TEST_RUNTIME_LOGIN_USERNAME: runtimeFixture.username,
        GOLDIS_TEST_RUNTIME_LOGIN_PASSWORD: runtimeFixture.password,
        GOLDIS_TEST_RUNTIME_RUN_ID: runtimeFixture.runId,
        GOLDIS_TEST_RUNTIME_DISPATCH_ID: runtimeFixture.dispatchId,
        GOLDIS_TEST_RUNTIME_ENRICHMENT_FIXTURE_PATH: enrichmentFixturePath,
        GOLDIS_DELETION_WORKER: "0",
        GOLDIS_DELETION_JOURNAL_DIR: path.join(appModuleTempRoot, "deletion-journal"),
      });
      if (process.env.GOLDIS_TEST_SCHEMA_CATALOG_CAPTURE === "1") {
        const snapshotPath = path.join(appModuleTempRoot, "schema-catalog-contract.json");
        const snapshotDestination = path.join(repositoryRoot, "docs/backend-refactor/schema-catalog-2026-10-16.json");
        const resolvedRoot = path.resolve(appModuleTempRoot);
        const destinationStat = existsSync(snapshotDestination) ? lstatSync(snapshotDestination) : null;
        if (path.dirname(path.resolve(snapshotPath)) !== resolvedRoot || !existsSync(snapshotPath)
          || path.resolve(snapshotDestination) !== path.resolve(repositoryRoot, "docs/backend-refactor/schema-catalog-2026-10-16.json")
          || (destinationStat && (!destinationStat.isFile() || destinationStat.isSymbolicLink()))) {
          throw new Error("SCHEMA_CATALOG_CAPTURE_SOURCE_INVALID");
        }
        copyFileSync(snapshotPath, snapshotDestination);
      }
      enrichmentFixture = JSON.parse(readFileSync(enrichmentFixturePath, "utf8"));
      runNodeScript("apps/api/scripts/runtime-enrichment-role-smoke.cjs", {
        ...roleEnvironment,
        DATABASE_URL: roleEnvironment.ENRICHMENT_DATABASE_URL,
        API_EXPORT_DIR: appModuleTempRoot,
        GOLDIS_TEST_APP_MODULE_SMOKE: "1",
        GOLDIS_TEST_RUNTIME_ENRICHMENT_FIXTURE_PATH: enrichmentFixturePath,
      });
      await verifyRuntimeEnrichment(migratorUrl, enrichmentFixture);
      await verifyRuntimeImportCorrection(
        buildRoleUrl(adminUrl.toString(), databaseName, "goldis_api", passwords.goldis_api),
        enrichmentFixture,
      );
      const unavailableDatabasePort = await reserveAndReleaseLoopbackPort();
      const unavailableDatabaseUrl = new URL(
        buildRoleUrl(adminUrl.toString(), databaseName, "goldis_api", passwords.goldis_api),
      );
      unavailableDatabaseUrl.port = String(unavailableDatabasePort);
      unavailableDatabaseUrl.searchParams.set("connect_timeout", "1");
      runNodeScript("apps/api/scripts/app-module-smoke.cjs", {
        ...roleEnvironment,
        DATABASE_URL: unavailableDatabaseUrl.toString(),
        API_EXPORT_DIR: appModuleTempRoot,
        GOLDIS_TEST_APP_MODULE_SMOKE: "1",
        GOLDIS_TEST_APP_MODULE_EXPECT_DATABASE_UNAVAILABLE: "1",
        SESSION_SECRET: "synthetic-app-module-session-secret-0000000000000000",
        LOGIN_RATE_LIMIT_SECRET: "synthetic-app-module-login-rate-secret-0000000000000000",
        PRIVILEGED_ACTION_BINDING_KEY: "synthetic-app-module-binding-secret-0000000000000000",
        GOLDIS_DELETION_WORKER: "0",
        GOLDIS_DELETION_JOURNAL_DIR: path.join(appModuleTempRoot, "deletion-journal-unavailable-database"),
      });
      const unavailableRedisPort = await reserveAndReleaseLoopbackPort();
      runNodeScript("apps/api/scripts/app-module-smoke.cjs", {
        ...roleEnvironment,
        DATABASE_URL: buildRoleUrl(adminUrl.toString(), databaseName, "goldis_api", passwords.goldis_api),
        REDIS_URL: `redis://127.0.0.1:${unavailableRedisPort}/0`,
        API_EXPORT_DIR: appModuleTempRoot,
        GOLDIS_TEST_APP_MODULE_SMOKE: "1",
        GOLDIS_TEST_APP_MODULE_EXPECT_REDIS_UNAVAILABLE: "1",
        SESSION_SECRET: "synthetic-app-module-session-secret-0000000000000000",
        LOGIN_RATE_LIMIT_SECRET: "synthetic-app-module-login-rate-secret-0000000000000000",
        PRIVILEGED_ACTION_BINDING_KEY: "synthetic-app-module-binding-secret-0000000000000000",
        GOLDIS_DELETION_WORKER: "0",
        GOLDIS_DELETION_JOURNAL_DIR: path.join(appModuleTempRoot, "deletion-journal-unavailable-redis"),
      });
    } finally {
      const resolvedTempRoot = path.resolve(appModuleTempRoot);
      if (path.dirname(resolvedTempRoot) !== path.resolve(os.tmpdir())
        || !path.basename(resolvedTempRoot).startsWith("goldis-app-module-smoke-")) {
        throw new Error("APP_MODULE_TEMP_PATH_OWNERSHIP_INVALID");
      }
      rmSync(resolvedTempRoot, { recursive: true, force: true });
    }
    if (!enrichmentFixture) throw new Error("RUNTIME_ENRICHMENT_FIXTURE_NOT_CREATED");
  }
  await exerciseWorkerCheckpoint(roleEnvironment.WORKER_DATABASE_URL, migratorUrl, runtimeFixture);
  console.log("RUNTIME_DATABASE_ROLE_SMOKE_PASS roles=4 elevated_privileges=false ddl_allowlist=true");
}

main().catch((error) => {
  console.error("RUNTIME_DATABASE_ROLE_SMOKE_FAIL", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
});
