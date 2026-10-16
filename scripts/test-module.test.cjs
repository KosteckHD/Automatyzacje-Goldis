"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { FULL_FLOW_ENV_KEYS, MODULES, assertTestFilesExist, assertUniqueTestFiles, commandFor, isolatedEnvironment } = require("./test-module.cjs");

test("runner exposes only named module suites and no broad test glob", () => {
  assert.deepEqual(Object.keys(MODULES).sort(), [
    "admin", "admin-users-db", "app-module", "audit-reports", "auth", "backup-restore", "compensa", "compensa-browser", "database", "deletion", "deletion-jobs", "deletion-step-up", "everest", "everest-browser", "grouping", "health", "interventions", "leads", "migrations", "migrations-upgrade", "notifications", "password-recovery", "registry", "registry-jobs", "reports", "results", "review", "run-control", "runs", "runtime", "runtime-roles", "security", "security-browser", "security-db", "security-redis", "sms", "submission", "teams", "teams-db", "tenant-scope", "tools", "ufg", "ufg-browser", "worker-lifecycle",
  ]);
  for (const definition of Object.values(MODULES)) {
    assert.ok(definition.db || definition.redis || definition.browser || (definition.files?.length ?? 0) > 0);
    for (const file of definition.files ?? []) assert.match(file, /\.(?:http\.)?(?:test|spec)\.js$/);
  }
  for (const name of Object.keys(MODULES)) {
    const plan = commandFor(name);
    assert.equal(new Set(plan.testFiles ?? []).size, (plan.testFiles ?? []).length, `${name} has a duplicate test path`);
  }
  assert.throws(() => assertUniqueTestFiles([path.join(ROOT, "apps/api/dist/a.test.js"), path.join(ROOT, "apps/api/dist", "..", "dist/a.test.js")]), /TEST_MODULE_DUPLICATE_TEST_FILE/);
  assert.throws(() => assertTestFilesExist([path.join(ROOT, "apps/api/dist/moved-away.test.js")]), /TEST_MODULE_FILE_MISSING_/);
  assert.throws(() => commandFor("all"), /TEST_MODULE_UNKNOWN/);
});

test("security DB/Redis modules use isolated local services and never inherit ownership flags", () => {
  const database = commandFor("security-db");
  assert.equal(database.args.at(-1), "security-db");
  assert.equal(database.env.GOLDIS_TEST_DATABASE_ADMIN_URL, undefined);
  const redis = commandFor("security-redis");
  assert.match(redis.args.at(-1), /Test-GoldisSecurityRedis\.ps1$/);
  assert.equal(redis.env.GOLDIS_TEST_REDIS_DISPOSABLE, undefined);
  for (const key of FULL_FLOW_ENV_KEYS) {
    assert.equal(database.env[key], undefined);
    assert.equal(redis.env[key], undefined);
  }
  const deletion = commandFor("deletion");
  assert.equal(deletion.args.at(-1), "deletion");
  assert.equal(deletion.env.WORKER_LIVE_PORTALS, "0");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(deletion.env[key], undefined);
});

test("runtime role suite creates and checks process roles only on the owned disposable PostgreSQL service", () => {
  const command = commandFor("runtime-roles");
  assert.equal(command.args.at(-1), "runtime-roles");
  assert.equal(command.env.GOLDIS_TEST_DATABASE_ADMIN_URL, undefined);
  const source = fs.readFileSync(path.join(ROOT, "scripts/test-module.cjs"), "utf8");
  assert.match(source, /\"runtime-roles\":\s*\{\s*workspace:\s*\"@goldis\/api\",\s*db:\s*true,\s*dbMode:\s*\"runtime-roles\"/);
  assert.match(fs.readFileSync(path.join(ROOT, "scripts/Test-GoldisDatabase.ps1"), "utf8"), /runtime-roles/);
  assert.match(fs.readFileSync(path.join(ROOT, "apps/api/scripts/run-db-integration.cjs"), "utf8"), /runtime-role-smoke\.cjs/);
  assert.match(fs.readFileSync(path.join(ROOT, "apps/api/scripts/runtime-role-smoke.cjs"), "utf8"), /runtime-process-role-probe-smoke\.cjs/);
  assert.match(fs.readFileSync(path.join(ROOT, "apps/worker/scripts/runtime-role-probe-smoke.cjs"), "utf8"), /assertPoolRuntimeDatabaseRole/);
});

test("app module smoke is isolated behind disposable PostgreSQL and Redis", () => {
  const command = commandFor("app-module");
  assert.equal(command.args.at(-1), "app-module");
  const databaseHarness = fs.readFileSync(path.join(ROOT, "scripts/Test-GoldisDatabase.ps1"), "utf8");
  assert.match(databaseHarness, /'app-module'/);
  assert.match(databaseHarness, /Module -eq 'app-module'[\s\S]*GOLDIS_TEST_REDIS_DISPOSABLE/);
  const runtimeHarness = fs.readFileSync(path.join(ROOT, "apps/api/scripts/runtime-role-smoke.cjs"), "utf8");
  assert.match(runtimeHarness, /GOLDIS_TEST_APP_MODULE_SMOKE === "1"/);
  assert.match(runtimeHarness, /GOLDIS_TEST_REDIS_DISPOSABLE !== "1"/);
  assert.match(runtimeHarness, /API_EXPORT_DIR: appModuleTempRoot/);
  assert.match(runtimeHarness, /APP_MODULE_TEMP_PATH_OWNERSHIP_INVALID/);
});

test("module child environment clears inherited whole-flow/live flags", () => {
  const parent = Object.fromEntries(FULL_FLOW_ENV_KEYS.map((key) => [key, "1"]));
  parent.WORKER_LIVE_PORTALS = "1";
  parent.WORKER_PZU_LOGIN_TEST_RUN_ID = "11111111-1111-4111-8111-111111111111";
  parent.PLAYWRIGHT_INTEGRATION = "1";
  const env = isolatedEnvironment(parent, "registry");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(env[key], undefined);
  assert.equal(env.WORKER_LIVE_PORTALS, "0");
  assert.equal(env.WORKER_PZU_LOGIN_TEST_RUN_ID, undefined);
  assert.equal(env.PLAYWRIGHT_INTEGRATION, "0");
  assert.equal(env.GOLDIS_ENRICHMENT_PROVIDER, "disabled");
});

test("browser fixture opt-in is explicit, portal live stays disabled, and worker fixtures use their workspace cwd", () => {
  const defaultEnv = isolatedEnvironment({ PLAYWRIGHT_INTEGRATION: "1", WORKER_LIVE_PORTALS: "1" }, "compensa");
  assert.equal(defaultEnv.PLAYWRIGHT_INTEGRATION, "0");
  const browserEnv = isolatedEnvironment({ PLAYWRIGHT_INTEGRATION: "0", WORKER_LIVE_PORTALS: "1" }, "compensa-browser");
  assert.equal(browserEnv.PLAYWRIGHT_INTEGRATION, "1");
  assert.equal(browserEnv.WORKER_LIVE_PORTALS, "0");
  assert.equal(commandFor("compensa-browser").testCwd, require("node:path").resolve(__dirname, "../apps/worker"));
  assert.equal(commandFor("ufg-browser").args.some((file) => /[\\/]oc\.spec\.js$/.test(file)), true);
});

test("module child environment cannot inherit production databases, exports, profiles or credentials", () => {
  const env = isolatedEnvironment({
    DATABASE_URL: "postgres://customer-secret@production.example/customer",
    REDIS_URL: "redis://production.example/0",
    GOLDIS_TEST_DATABASE_ADMIN_URL: "postgres://customer-secret@production.example/postgres",
    PZU_PASSWORD: "synthetic-parent-value", WORKER_AUTH_SECRET: "synthetic-parent-value",
    REGISTRY_CACHE_HMAC_KEY: "synthetic-parent-secret", GUS_BIR_USER_KEY: "synthetic-parent-bir-key",
  }, "registry", "C:/tmp/goldis-module-owner-fixture");
  assert.match(env.DATABASE_URL, /127\.0\.0\.1:1/);
  assert.match(env.REDIS_URL, /127\.0\.0\.1:1/);
  for (const key of ["GOLDIS_TEST_DATABASE_ADMIN_URL", "PZU_PASSWORD", "WORKER_AUTH_SECRET", "REGISTRY_CACHE_HMAC_KEY", "GUS_BIR_USER_KEY"]) assert.equal(env[key], undefined);
  assert.equal(env.API_EXPORT_DIR, "C:\\tmp\\goldis-module-owner-fixture\\exports");
});

test("module suite paths are explicit and submission does not select a portal worker", () => {
  const submission = commandFor("submission");
  assert.equal(submission.args.includes("--test"), true);
  assert.equal(submission.args.length, 4);
  assert.equal(submission.args.some((arg) => /run-submission\.dto\.spec\.js$/.test(arg)), true);
  assert.equal(submission.args.some((arg) => /submissions\.module\.spec\.js$/.test(arg)), true);
  assert.equal(submission.args.some((arg) => /run-submissions\.http\.spec\.js$/.test(arg)), true);
  assert.equal(submission.args.some((arg) => /automation-flow|run-submission-platform-smoke|apps\/worker/.test(arg)), false);
});

test("health feature suite runs colocated spec files through the recursive module runner", () => {
  const health = commandFor("health");
  assert.equal(health.args.length, 5);
  assert.equal(health.args.some((file) => /features[\\/]health[\\/]health\.http\.spec\.js$/.test(file)), true);
});

test("auth feature composition spec is part of the explicit auth module suite", () => {
  const auth = commandFor("auth");
  assert.equal(auth.args.some((file) => /features[\\/]auth[\\/]auth\.module\.spec\.js$/.test(file)), true);
  assert.equal(auth.args.some((file) => /features[\\/]authorization[\\/]authorization\.module\.spec\.js$/.test(file)), true);
});

test("database factory spec is isolated from local and production database URLs", () => {
  const database = commandFor("database");
  assert.equal(database.args.length, 2);
  assert.match(database.args[1], /infrastructure[\\/]database[\\/]database\.factory\.spec\.js$/);
  assert.equal(database.env.DATABASE_URL, "postgres://goldis_module_test:unused@127.0.0.1:1/goldis_module_test");
});

test("migration module selects the owned disposable-database wrapper with full flow disabled", () => {
  const plan = commandFor("migrations");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.args.at(-1), "migrations");
  assert.equal(plan.args.at(-2), "-Module");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(plan.env[key], undefined);
  assert.equal(plan.env.WORKER_LIVE_PORTALS, "0");
});

test("migration upgrade module selects only the disposable 061-to-062 upgrade smoke", () => {
  const plan = commandFor("migrations-upgrade");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.args.at(-1), "migrations-upgrade");
  assert.equal(plan.args.at(-2), "-Module");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(plan.env[key], undefined);
  assert.equal(plan.env.WORKER_LIVE_PORTALS, "0");
});

test("password recovery module runs the owned disposable PostgreSQL recovery flow", () => {
  const database = commandFor("password-recovery");
  assert.match(database.args.at(-3), /Test-GoldisDatabase\.ps1$/);
  assert.equal(database.args.at(-2), "-Module");
  assert.equal(database.args.at(-1), "password-recovery");
  assert.equal(database.env.GOLDIS_PASSWORD_RECOVERY_ENABLED, "0");
});

test("tenant-scope module selects only its owned disposable-database smoke", () => {
  const plan = commandFor("tenant-scope");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.args.at(-1), "tenant-scope");
  assert.equal(plan.args.at(-2), "-Module");
  assert.equal(plan.env.WORKER_LIVE_PORTALS, "0");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(plan.env[key], undefined);
});

test("teams DB module selects its owned disposable PostgreSQL smoke", () => {
  const plan = commandFor("teams-db");
  assert.equal(plan.args.at(-1), "teams-db");
  assert.match(fs.readFileSync(path.join(ROOT, "scripts/Test-GoldisDatabase.ps1"), "utf8"), /teams-db.*GOLDIS_TEST_DB_MODES = 'teams'/);
  assert.match(fs.readFileSync(path.join(ROOT, "apps/api/scripts/migration-smoke.cjs"), "utf8"), /mode === "teams"[\s\S]*team-db-smoke\.cjs/);
});

test("admin users DB module selects its disposable PostgreSQL create and audit rollback smoke", () => {
  const plan = commandFor("admin-users-db");
  assert.equal(plan.args.at(-1), "admin-users-db");
  assert.match(fs.readFileSync(path.join(ROOT, "scripts/Test-GoldisDatabase.ps1"), "utf8"), /admin-users-db.*GOLDIS_TEST_DB_MODES = 'admin-users'/);
  assert.match(fs.readFileSync(path.join(ROOT, "apps/api/scripts/migration-smoke.cjs"), "utf8"), /mode === "admin-users"[\s\S]*admin-users-db-smoke\.cjs/);
});

test("registry job module runs only its own disposable PostgreSQL smoke", () => {
  const plan = commandFor("registry-jobs");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.args.at(-1), "registry-jobs");
  assert.equal(plan.env.WORKER_LIVE_PORTALS, "0");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(plan.env[key], undefined);
});

test("report module runs only its two-tenant synthetic PostgreSQL aggregation smoke", () => {
  const plan = commandFor("reports");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.args.at(-1), "reports");
  assert.equal(plan.env.WORKER_LIVE_PORTALS, "0");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(plan.env[key], undefined);
});

test("backup restore module is pinned to the owned disposable Postgres wrapper", () => {
  const plan = commandFor("backup-restore");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.args.at(-1), "backup-restore");
  assert.equal(plan.env.WORKER_LIVE_PORTALS, "0");
  assert.equal(plan.env.GOLDIS_TEST_POSTGRES_CONTAINER, undefined);
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(plan.env[key], undefined);
});

test("grouping module runs only its synthetic database suite with full flow disabled", () => {
  const plan = commandFor("grouping");
  assert.equal(plan.command, "powershell.exe");
  assert.equal(plan.args.at(-1), "grouping");
  assert.equal(plan.env.WORKER_LIVE_PORTALS, "0");
  for (const key of FULL_FLOW_ENV_KEYS) assert.equal(plan.env[key], undefined);
});

