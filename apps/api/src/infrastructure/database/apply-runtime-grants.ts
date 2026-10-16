import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { loadDatabaseProcessRuntimeConfig } from "../config";

async function main(): Promise<void> {
  const runtimeConfig = loadDatabaseProcessRuntimeConfig(process.env, "goldis_migrator");
  const client = new Client({ connectionString: runtimeConfig.databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const role = await client.query<{ name: string }>("SELECT current_user AS name");
    if (role.rows[0]?.name !== runtimeConfig.expectedRole) throw new Error("RUNTIME_GRANTS_REQUIRE_MIGRATOR");
    const sql = await readFile(resolve(process.cwd(), "docker/postgres/apply-runtime-grants.sql"), "utf8");
    await client.query(sql);
    console.log("RUNTIME_GRANTS_APPLIED");
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error("RUNTIME_GRANTS_FAILED", error instanceof Error ? error.message : "UNKNOWN");
  process.exitCode = 1;
});
