const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");

const roles = ["goldis_migrator", "goldis_api", "goldis_worker", "goldis_enrichment"];
const repositoryRoot = path.resolve(__dirname, "../../..");

function localAdminUrl(value) {
  if (!value) throw new Error("GOLDIS_TEST_DATABASE_ADMIN_URL_REQUIRED");
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)
    || url.username !== "postgres"
    || url.pathname !== "/postgres"
    || url.search || url.hash) {
    throw new Error("LOCAL_TEST_POSTGRES_ADMIN_URL_REQUIRED");
  }
  return url;
}

function requireOwnedSmokeContainer() {
  const container = process.env.GOLDIS_TEST_POSTGRES_CONTAINER;
  const owner = process.env.GOLDIS_TEST_POSTGRES_OWNER;
  if (!/^goldis-db-smoke-[a-f0-9]{32}$/.test(container ?? "") || !/^[a-f0-9]{32}$/.test(owner ?? "")) {
    throw new Error("OWNED_DISPOSABLE_POSTGRES_REQUIRED_FOR_RUNTIME_ROLE_SMOKE");
  }
  const inspected = spawnSync("docker", [
    "inspect", `--format={{ index .Config.Labels "goldis.test.owner" }}`, container,
  ], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (inspected.error || inspected.status !== 0 || inspected.stdout.trim() !== owner) {
    throw new Error("DISPOSABLE_POSTGRES_OWNERSHIP_CHECK_FAILED");
  }
}

function buildRoleUrl(template, database, role, password) {
  const url = new URL(template);
  url.pathname = `/${database}`;
  url.username = role;
  url.password = password;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function provisionRuntimeRoles(databaseName) {
  if (!/^goldis_migration_smoke_[a-z0-9_]+$/.test(databaseName ?? "")) {
    throw new Error("DISPOSABLE_DATABASE_NAME_REQUIRED");
  }
  requireOwnedSmokeContainer();
  const adminUrl = localAdminUrl(process.env.GOLDIS_TEST_DATABASE_ADMIN_URL);
  const passwords = Object.fromEntries(roles.map((role) => [role, randomBytes(32).toString("hex")]));
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 3_000 });
  try {
    await admin.connect();
    const database = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (database.rowCount !== 1) throw new Error("DISPOSABLE_DATABASE_NOT_FOUND");
    for (const role of roles) {
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      const statement = exists.rowCount
        ? "ALTER ROLE " + role
        : "CREATE ROLE " + role;
      await admin.query(
        statement + " WITH LOGIN PASSWORD '" + passwords[role]
          + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT",
      );
    }
    await admin.query('REVOKE ALL PRIVILEGES ON DATABASE "' + databaseName + '" FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE "' + databaseName + '" TO goldis_api, goldis_worker, goldis_enrichment');
  } finally {
    await admin.end().catch(() => undefined);
  }

  const databaseUrl = buildRoleUrl(adminUrl.toString(), databaseName, "postgres", new URL(process.env.GOLDIS_TEST_DATABASE_ADMIN_URL).password);
  const databaseAdmin = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000 });
  try {
    await databaseAdmin.connect();
    const grants = await readFile(path.join(repositoryRoot, "docker/postgres/apply-runtime-grants.sql"), "utf8");
    await databaseAdmin.query(grants);
    const privileges = await databaseAdmin.query(`SELECT
      has_table_privilege('goldis_enrichment', 'public.audit_events', 'INSERT') AS audit_insert,
      has_table_privilege('goldis_enrichment', 'public.audit_events', 'UPDATE') AS audit_update,
      has_column_privilege('goldis_enrichment', 'public.import_batches', 'enrichment_worker_lock_capability', 'UPDATE') AS batch_lock`);
    if (!privileges.rows[0]?.audit_insert || privileges.rows[0]?.audit_update || !privileges.rows[0]?.batch_lock) {
      throw new Error("RUNTIME_GRANT_ALLOWLIST_PROBE_FAILED");
    }
  } finally {
    await databaseAdmin.end().catch(() => undefined);
  }

  return {
    enrichmentDatabaseUrl: buildRoleUrl(adminUrl.toString(), databaseName, "goldis_enrichment", passwords.goldis_enrichment),
  };
}

module.exports = { provisionRuntimeRoles };
