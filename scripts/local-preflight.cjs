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
  } catch { errors.push("DATABASE_URL_UNREACHABLE"); }
  finally { await pool.end().catch(() => undefined); }

  try {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true, connectTimeout: 2_000, maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    await redis.connect();
    if (await redis.ping() !== "PONG") errors.push("REDIS_URL_UNREACHABLE");
  } catch { errors.push("REDIS_URL_UNREACHABLE"); }
  finally { await redis?.quit().catch(() => undefined); }

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
      const { loadPortalRuntimeConfig } = require("../apps/worker/dist/portal-runtime-config");
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
