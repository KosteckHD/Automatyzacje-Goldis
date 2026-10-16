import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRuntimeDatabaseRole,
  type RuntimeDatabaseRoleSnapshot,
} from "./runtime-database-role";

function safeRole(role = "goldis_api"): RuntimeDatabaseRoleSnapshot {
  return {
    role,
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
}

test("runtime database role accepts only the expected restricted identity", () => {
  assert.doesNotThrow(() => assertRuntimeDatabaseRole(safeRole(), "goldis_api"));
  assert.doesNotThrow(() => assertRuntimeDatabaseRole({ ...safeRole("goldis_migrator"), public_create: true }, "goldis_migrator"));
});

test("runtime database role rejects the wrong identity and each elevated capability", () => {
  assert.throws(() => assertRuntimeDatabaseRole(safeRole("goldis"), "goldis_api"), /RUNTIME_DATABASE_ROLE_MISMATCH/);
  for (const flag of [
    "rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit",
  ] as const) {
    assert.throws(() => assertRuntimeDatabaseRole({ ...safeRole(), [flag]: true }, "goldis_api"), /RUNTIME_DATABASE_ROLE_PRIVILEGED/);
  }
  assert.throws(() => assertRuntimeDatabaseRole({ ...safeRole(), memberships: ["pg_read_server_files"] }, "goldis_api"), /RUNTIME_DATABASE_ROLE_PRIVILEGED/);
  assert.throws(() => assertRuntimeDatabaseRole({ ...safeRole(), public_usage: false }, "goldis_api"), /RUNTIME_DATABASE_ROLE_PRIVILEGED/);
  assert.throws(() => assertRuntimeDatabaseRole({ ...safeRole(), public_create: true }, "goldis_api"), /RUNTIME_DATABASE_ROLE_PRIVILEGED/);
  assert.throws(() => assertRuntimeDatabaseRole(safeRole("goldis_migrator"), "goldis_migrator"), /RUNTIME_DATABASE_ROLE_PRIVILEGED/);
});

test("runtime database role fails closed for incomplete probe results", () => {
  assert.throws(() => assertRuntimeDatabaseRole(undefined, "goldis_api"), /RUNTIME_DATABASE_ROLE_CHECK_FAILED/);
  assert.throws(() => assertRuntimeDatabaseRole({ ...safeRole(), rolsuper: "false" }, "goldis_api"), /RUNTIME_DATABASE_ROLE_CHECK_FAILED/);
});
