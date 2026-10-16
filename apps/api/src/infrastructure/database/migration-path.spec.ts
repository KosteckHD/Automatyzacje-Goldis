import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationGlob } from "./migration-path";

test("migration glob normalizes Windows separators for the Umzug glob resolver", () => {
  assert.equal(migrationGlob("C:\\Goldis\\apps\\api\\dist"), "C:/Goldis/apps/api/dist/migrations/*.js");
});

test("migration glob preserves POSIX paths", () => {
  assert.equal(migrationGlob("/srv/goldis/apps/api/dist"), "/srv/goldis/apps/api/dist/migrations/*.js");
});
