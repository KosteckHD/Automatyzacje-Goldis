const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");

const adminUrl = process.env.GOLDIS_TEST_DATABASE_ADMIN_URL;
function validateAdminUrl(value) {
  if (!value) throw new Error("GOLDIS_TEST_DATABASE_ADMIN_URL_REQUIRED");
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!new Set(["localhost", "127.0.0.1", "::1"]).has(host)
    || !new Set(["/postgres", "/template1"]).has(url.pathname)
    || url.search || url.hash) throw new Error("LOCAL_TEST_POSTGRES_ADMIN_URL_REQUIRED");
  return url;
}

async function withDisposableDatabase(baseUrl, mode) {
  const suffix = randomBytes(8).toString("hex");
  const databaseName = `goldis_migration_smoke_${process.pid}_${suffix}`;
  const client = new Client({ connectionString: baseUrl.toString(), connectionTimeoutMillis: 2_000 });
  let created = false;
  try {
    await client.connect();
    await client.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const smokeName = ["runtime-roles", "app-module"].includes(mode)
      ? "runtime-role-smoke.cjs"
      : mode === "upgrade-061-062" ? "migration-upgrade-smoke.cjs" : "migration-smoke.cjs";
    const smokePath = require("node:path").resolve(__dirname, smokeName);
    const childEnvironment = { ...process.env, DATABASE_URL: baseUrl.toString() };
    if (process.env.GOLDIS_TEST_MODULE_RUNNER === "1") {
      for (const key of ["GOLDIS_AUTOMATION_E2E", "GOLDIS_FULL_FLOW_E2E", "GOLDIS_PLATFORM_E2E", "GOLDIS_LIVE_E2E"]) delete childEnvironment[key];
      childEnvironment.WORKER_LIVE_PORTALS = "0";
      childEnvironment.PLAYWRIGHT_INTEGRATION = "0";
    }
    const smokeArgs = ["runtime-roles", "app-module"].includes(mode) || mode === "upgrade-061-062"
      ? [databaseName]
      : [mode, databaseName];
    const smokeTimeoutMs = mode === "users" && process.env.GOLDIS_AUTOMATION_E2E === "1" ? 360_000 : 180_000;
    const child = spawnSync(process.execPath, [smokePath, ...smokeArgs], {
      cwd: require("node:path").resolve(__dirname, "../../.."),
      env: childEnvironment, stdio: "inherit", timeout: smokeTimeoutMs,
    });
    if (child.error || child.status !== 0) {
      const status = child.status === null ? "null" : String(child.status);
      const signal = child.signal ?? "none";
      const spawnError = child.error?.code ?? child.error?.name ?? "none";
      throw new Error(`MIGRATION_SMOKE_FAILED_${mode}_status_${status}_signal_${signal}_spawn_${spawnError}`);
    }
  } finally {
    if (created) {
      const owned = await client.query("SELECT datname FROM pg_database WHERE datname = $1", [databaseName]);
      if (owned.rowCount === 1 && owned.rows[0].datname === databaseName) {
        await client.query(`DROP DATABASE "${databaseName}"`);
      }
    }
    await client.end().catch(() => undefined);
  }
}

async function main() {
  let baseUrl;
  try { baseUrl = validateAdminUrl(adminUrl); }
  catch (error) {
    console.error("DB_INTEGRATION_BLOCKED", error instanceof Error ? error.message : "LOCAL_TEST_POSTGRES_ADMIN_URL_REQUIRED");
    process.exitCode = 2;
    return;
  }
  try {
    const allModes = ["users-empty", "users", "tenant-scope", "teams", "admin-users", "grouping-perf", "registry-jobs", "reports", "deletion", "backup-restore", "run-control", "runtime-roles", "app-module", "upgrade-061-062"];
    const requestedModes = process.env.GOLDIS_TEST_DB_MODES
      ? [...new Set(process.env.GOLDIS_TEST_DB_MODES.split(",").map((value) => value.trim()).filter(Boolean))]
      : allModes;
    if (!requestedModes.length || requestedModes.some((mode) => !allModes.includes(mode))) {
      throw new Error("GOLDIS_TEST_DB_MODES_INVALID");
    }
    for (const mode of requestedModes) await withDisposableDatabase(baseUrl, mode);
    console.log(`DB_INTEGRATION_PASS modes=${requestedModes.join(",")} migrations=001-062 disposable_databases=dropped`);
  } catch (error) {
    console.error("DB_INTEGRATION_FAILED", error instanceof Error ? error.message : "SMOKE_FAILED");
    process.exitCode = 1;
  }
}

main();
