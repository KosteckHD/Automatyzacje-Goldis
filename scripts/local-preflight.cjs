const { Pool } = require("pg");
const Redis = require("ioredis");
const net = require("node:net");
const { inspectRuntimeEnvironment } = require("./preflight-contract.cjs");

const environment = inspectRuntimeEnvironment(process.env);
const errors = environment.errors;
const isLive = environment.mode === "live";
const checkSchema = process.argv.includes("--post-migration");

async function validateServices() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
  let redis;
  try {
    await pool.query("SELECT 1");
    const role = await pool.query(`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole,
      rolreplication, rolbypassrls, rolinherit,
      has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = current_user::regrole) AS inherited_role`);
    const row = role.rows[0];
    if (row?.name !== "goldis_api" || row.rolsuper || row.rolcreatedb || row.rolcreaterole
      || row.rolreplication || row.rolbypassrls || row.rolinherit || row.public_create || row.inherited_role) {
      errors.push("DATABASE_URL_ROLE_PRIVILEGE_INVALID");
    }
  } catch { errors.push("DATABASE_URL_UNREACHABLE"); }
  finally { await pool.end().catch(() => undefined); }

  for (const [name, url, expectedRole] of [
    ["MIGRATOR_DATABASE_URL", process.env.MIGRATOR_DATABASE_URL, "goldis_migrator"],
    ["WORKER_DATABASE_URL", process.env.WORKER_DATABASE_URL, "goldis_worker"],
    ["ENRICHMENT_DATABASE_URL", process.env.ENRICHMENT_DATABASE_URL, "goldis_enrichment"],
  ]) {
    let rolePool;
    try {
      rolePool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2_000 });
      const role = await rolePool.query(`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls, rolinherit,
        has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member = current_user::regrole) AS inherited_role`);
      const row = role.rows[0];
      const basicFlagsValid = row && !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole
        && !row.rolreplication && !row.rolbypassrls && !row.rolinherit && !row.inherited_role;
      const schemaValid = expectedRole === "goldis_migrator" ? row?.public_create === true : row?.public_create === false;
      if (row?.name !== expectedRole || !basicFlagsValid || !schemaValid) errors.push(`${name}_ROLE_PRIVILEGE_INVALID`);
    } catch { errors.push(`${name}_UNREACHABLE`); }
    finally { await rolePool?.end().catch(() => undefined); }
  }

  for (const [name, url] of [["REDIS_URL", process.env.REDIS_URL], ["WORKER_REDIS_URL", process.env.WORKER_REDIS_URL]]) {
    try {
      redis = new Redis(url, {
        lazyConnect: true, connectTimeout: 2_000, maxRetriesPerRequest: 1, retryStrategy: () => null,
      });
      redis.on("error", () => undefined);
      await redis.connect();
      if (await redis.ping() !== "PONG") errors.push(`${name}_UNREACHABLE`);
    } catch { errors.push(`${name}_UNREACHABLE`); }
    finally { await redis?.quit().catch(() => undefined); redis = undefined; }
  }

  try {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(process.env.WORKER_INTERNAL_PORT || "3022"), "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } catch { errors.push("WORKER_INTERNAL_PORT_UNAVAILABLE"); }

  if (isLive && process.env.WORKER_PORTAL_CONFIG_PATH) {
    try {
      const { loadPortalRuntimeConfig } = require("../apps/worker/dist/portals/shared/portal-runtime-config");
      await loadPortalRuntimeConfig(process.env.WORKER_PORTAL_CONFIG_PATH);
    } catch (error) {
      errors.push(error instanceof Error && /^PORTAL_CONFIG_[A-Z_]+$/.test(error.message) ? error.message : "WORKER_PORTAL_CONFIG_PATH_INVALID");
    }
  }
  if (checkSchema) {
    let client;
    try {
      client = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
      const result = await client.query("SELECT to_regclass('public.worker_runtime_status') AS status_table");
      if (!result.rows[0]?.status_table) errors.push("MIGRATIONS_REQUIRED");
    } catch { errors.push("DATABASE_SCHEMA_UNAVAILABLE"); }
    finally { await client?.end().catch(() => undefined); }
  }
}

async function main() {
  if (errors.length) {
    console.error(`PREFLIGHT_FAIL settings=${[...new Set(errors)].join(",")}`);
    process.exitCode = 1;
    return;
  }
  await validateServices();
  if (errors.length) {
    console.error(`PREFLIGHT_FAIL checks=${[...new Set(errors)].join(",")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PREFLIGHT_PASS mode=${isLive ? "live" : "off"} database=ok redis=ok keyring=ok`);
}

main().catch(() => {
  console.error("PREFLIGHT_FAIL checks=INTERNAL_ERROR");
  process.exitCode = 1;
});
