const { Pool } = require("pg");
const { assertPoolRuntimeDatabaseRole } = require("../dist/infrastructure/database/runtime-database-role.js");

async function main() {
  if (!process.env.WORKER_DATABASE_URL) throw new Error("WORKER_DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 1, connectionTimeoutMillis: 3_000 });
  try {
    await assertPoolRuntimeDatabaseRole(pool, "goldis_worker");
  } finally {
    await pool.end();
  }
  console.log("PG_WORKER_RUNTIME_ROLE_PROBE_PASS");
}

main().catch((error) => {
  console.error("PG_WORKER_RUNTIME_ROLE_PROBE_FAIL", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
});
