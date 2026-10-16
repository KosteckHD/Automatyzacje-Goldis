import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadBootstrapAdminRuntimeConfig,
  loadDatabaseProcessRuntimeConfig,
  loadEnrichmentWorkerRuntimeConfig,
  loadImportParserRuntimeConfig,
} from "./process-runtime-config";

test("database process config binds an explicit role without exposing the connection in errors", () => {
  const config = loadDatabaseProcessRuntimeConfig({ DATABASE_URL: "postgres://goldis_migrator:secret@localhost:5432/goldis" }, "goldis_migrator");
  assert.equal(config.expectedRole, "goldis_migrator");
  assert.equal(config.databaseUrl, "postgres://goldis_migrator:secret@localhost:5432/goldis");
  for (const DATABASE_URL of [undefined, "not-a-url", "https://user:secret@example.test/db", "postgres://localhost/"]) {
    assert.throws(() => loadDatabaseProcessRuntimeConfig({ DATABASE_URL }, "goldis_api"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
});

test("import parser config validates secret, host, and bounded listener port", () => {
  const config = loadImportParserRuntimeConfig({ IMPORT_PARSER_SHARED_SECRET: "s".repeat(40), IMPORT_PARSER_HOST: "0.0.0.0", IMPORT_PARSER_PORT: "3010" });
  assert.deepEqual(config, { secret: "s".repeat(40), host: "0.0.0.0", port: 3010 });
  assert.deepEqual(loadImportParserRuntimeConfig({ IMPORT_PARSER_SHARED_SECRET: "s".repeat(32) }), {
    secret: "s".repeat(32), host: "127.0.0.1", port: 3010,
  });
  for (const IMPORT_PARSER_PORT of ["0", "65536", "1.5", "bad"]) {
    assert.throws(() => loadImportParserRuntimeConfig({ IMPORT_PARSER_SHARED_SECRET: "s".repeat(32), IMPORT_PARSER_PORT }));
  }
  assert.throws(() => loadImportParserRuntimeConfig({ IMPORT_PARSER_SHARED_SECRET: "short" }), /IMPORT_PARSER_SHARED_SECRET_INVALID/);
  assert.throws(() => loadImportParserRuntimeConfig({ IMPORT_PARSER_SHARED_SECRET: "s".repeat(32), IMPORT_PARSER_HOST: "bad host" }), /IMPORT_PARSER_HOST_INVALID/);
});

test("enrichment config passes only provider allowlisted settings and the enrichment database role", () => {
  const config = loadEnrichmentWorkerRuntimeConfig({
    DATABASE_URL: "postgres://goldis_enrichment:secret@localhost:5432/goldis",
    GOLDIS_ENRICHMENT_PROVIDER: "disabled", REGISTRY_CACHE_HMAC_KEY: "a".repeat(64), UNRELATED_TOKEN: "must-not-propagate",
  });
  assert.equal(config.database.expectedRole, "goldis_enrichment");
  assert.deepEqual(config.providerEnvironment, {
    GOLDIS_ENRICHMENT_PROVIDER: "disabled", REGISTRY_CACHE_HMAC_KEY: "a".repeat(64),
  });
  assert.equal("UNRELATED_TOKEN" in config.providerEnvironment, false);
});

test("bootstrap config carries optional credentials without validating them before checking whether seeding is needed", () => {
  assert.deepEqual(loadBootstrapAdminRuntimeConfig({}), { username: undefined, password: undefined });
  assert.deepEqual(loadBootstrapAdminRuntimeConfig({ GOLDIS_ADMIN_USER: "admin", GOLDIS_ADMIN_PASSWORD: "secret" }), {
    username: "admin", password: "secret",
  });
});
