import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { assertPoolRuntimeDatabaseRole } from "./runtime-database-role";

const restrictedWorkerRole = {
  role: "goldis_worker",
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolbypassrls: false,
  rolinherit: false,
  memberships: [],
  public_usage: true,
  public_create: false,
};

test("portal worker startup validates the actual connected database role", async () => {
  let probeCount = 0;
  const pool = {
    query: async () => {
      probeCount += 1;
      return { rows: [restrictedWorkerRole], rowCount: 1 };
    },
  } as unknown as Pool;

  await assertPoolRuntimeDatabaseRole(pool, "goldis_worker");
  assert.equal(probeCount, 1);
});

test("portal worker startup rejects a database role with inherited memberships", async () => {
  const pool = {
    query: async () => ({ rows: [{ ...restrictedWorkerRole, memberships: ["pg_read_server_files"] }], rowCount: 1 }),
  } as unknown as Pool;

  await assert.rejects(assertPoolRuntimeDatabaseRole(pool, "goldis_worker"), /RUNTIME_DATABASE_ROLE_PRIVILEGED/);
});
