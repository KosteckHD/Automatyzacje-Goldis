import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sequelize } from "sequelize";
import { assertSequelizeRuntimeDatabaseRole } from "./runtime-database-role";

const restrictedApiRole = {
  role: "goldis_api",
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

test("Sequelize startup probe validates the connected PostgreSQL role", async () => {
  const calls: unknown[] = [];
  const connection = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return [restrictedApiRole];
    },
  } as unknown as Sequelize;

  await assertSequelizeRuntimeDatabaseRole(connection, "goldis_api");
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]), /current_user AS role/);
});

test("Sequelize startup probe rejects a superuser connection", async () => {
  const connection = {
    query: async () => [{ ...restrictedApiRole, rolsuper: true }],
  } as unknown as Sequelize;

  await assert.rejects(assertSequelizeRuntimeDatabaseRole(connection, "goldis_api"), /RUNTIME_DATABASE_ROLE_PRIVILEGED/);
});
