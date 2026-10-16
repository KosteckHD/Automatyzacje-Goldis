const assert = require("node:assert/strict");
const { test } = require("node:test");
const { inspectRuntimeEnvironment } = require("./preflight-contract.cjs");

function validLocalEnvironment(overrides = {}) {
  const keyring = Buffer.from(JSON.stringify({ "1": Buffer.alloc(32, 7).toString("base64") })).toString("base64");
  const artifactKeyring = Buffer.from(JSON.stringify({ "1": Buffer.alloc(32, 8).toString("base64") })).toString("base64");
  return {
    DATABASE_URL: "postgres://goldis_api:synthetic@127.0.0.1:5432/goldis",
    MIGRATOR_DATABASE_URL: "postgres://goldis_migrator:synthetic@127.0.0.1:5432/goldis",
    WORKER_DATABASE_URL: "postgres://goldis_worker:synthetic@127.0.0.1:5432/goldis",
    ENRICHMENT_DATABASE_URL: "postgres://goldis_enrichment:synthetic@127.0.0.1:5432/goldis",
    REDIS_URL: `redis://goldis_api:${"a".repeat(64)}@127.0.0.1:6379/0`,
    REDIS_API_PASSWORD: "a".repeat(64),
    WORKER_REDIS_URL: `redis://goldis_worker:${"c".repeat(64)}@127.0.0.1:6379/0`,
    REDIS_WORKER_PASSWORD: "c".repeat(64),
    WORKER_AUTH_SECRET: "synthetic-only-worker-secret-with-more-than-32-bytes",
    PRIVILEGED_ACTION_BINDING_KEY: "synthetic-only-privileged-binding-key-32-bytes-minimum",
    WORKER_PROFILE_DIR: "C:\\Temp\\goldis-profile",
    WORKER_HEADLESS: "0",
    APP_ENV: "development",
    WORKER_INTERNAL_PORT: "3022",
    PUBLIC_APP_ORIGIN: "http://localhost:3000",
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: keyring,
    ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    ARTIFACT_ENCRYPTION_KEYS_BASE64: artifactKeyring,
    WORKER_LIVE_PORTALS: "0",
    ...overrides,
  };
}

function productionEnvironment(overrides = {}) {
  return validLocalEnvironment({
    APP_ENV: "production",
    PUBLIC_APP_ORIGIN: "https://goldis.example.test",
    TRUST_PROXY_IPS: "172.30.10.10",
    WORKER_CHROMIUM_SANDBOX: "1",
    GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
    REGISTRY_CACHE_HMAC_KEY: "b".repeat(64),
    IMPORT_PARSER_URL: "http://import-parser:3010",
    IMPORT_PARSER_SHARED_SECRET: "parser-shared-secret-that-is-at-least-thirty-two-bytes",
    ...overrides,
  });
}

test("off mode accepts a valid local service config without requiring portal credentials", () => {
  const result = inspectRuntimeEnvironment(validLocalEnvironment());
  assert.deepEqual(result, { mode: "off", errors: [] });
});

test("off mode names missing or malformed service settings without leaking their values", () => {
  const env = validLocalEnvironment({
    REDIS_URL: "not-a-url", WORKER_PROFILE_DIR: "relative-profile", WORKER_AUTH_SECRET: "short",
    PESEL_ENCRYPTION_KEYS_BASE64: "not-a-keyring", PUBLIC_APP_ORIGIN: "http://remote.example",
  });
  const result = inspectRuntimeEnvironment(env);
  assert.deepEqual(result.errors, ["REDIS_URL", "WORKER_AUTH_SECRET", "WORKER_PROFILE_DIR", "PUBLIC_APP_ORIGIN", "PESEL_ENCRYPTION_KEYS_BASE64"]);
  assert.equal(JSON.stringify(result).includes("remote.example"), false);
  assert.equal(JSON.stringify(result).includes("short"), false);
});

test("wymaga osobnych użytkowników API, migracji i workera", () => {
  const result = inspectRuntimeEnvironment(validLocalEnvironment({
    DATABASE_URL: "postgres://goldis:synthetic@127.0.0.1:5432/goldis",
    MIGRATOR_DATABASE_URL: "postgres://goldis:synthetic@127.0.0.1:5432/goldis",
    WORKER_DATABASE_URL: "postgres://goldis_api:synthetic@127.0.0.1:5432/goldis",
  }));
  assert.deepEqual(result.errors, ["MIGRATOR_DATABASE_URL", "WORKER_DATABASE_URL", "DATABASE_URL_ROLE"]);
  const missingEnrichmentRole = inspectRuntimeEnvironment(validLocalEnvironment({ ENRICHMENT_DATABASE_URL: "postgres://goldis_worker:synthetic@127.0.0.1:5432/goldis" }));
  assert.deepEqual(missingEnrichmentRole.errors, ["ENRICHMENT_DATABASE_URL"]);
});

test("Redis oddziela użytkownika API od użytkownika workera", () => {
  const result = inspectRuntimeEnvironment(validLocalEnvironment({
    WORKER_REDIS_URL: "redis://goldis_api:wrong@127.0.0.1:6379/0",
  }));
  assert.deepEqual(result.errors, ["WORKER_REDIS_URL"]);
});

test("produkcja wymaga twardej odmowy pobrania niezaszyfrowanego artefaktu", () => {
  const result = inspectRuntimeEnvironment(productionEnvironment());
  assert.deepEqual(result.errors, ["ARTIFACT_REQUIRE_ENCRYPTION"]);
  const enabled = inspectRuntimeEnvironment(productionEnvironment({ ARTIFACT_REQUIRE_ENCRYPTION: "1" }));
  assert.deepEqual(enabled.errors, []);
});

test("production import requires a private parser endpoint and an independent service secret", () => {
  const missing = inspectRuntimeEnvironment(productionEnvironment({ ARTIFACT_REQUIRE_ENCRYPTION: "1",
    IMPORT_PARSER_URL: "", IMPORT_PARSER_SHARED_SECRET: "" }));
  assert.deepEqual(missing.errors, ["IMPORT_PARSER_URL", "IMPORT_PARSER_SHARED_SECRET"]);
  const malformed = inspectRuntimeEnvironment(productionEnvironment({ ARTIFACT_REQUIRE_ENCRYPTION: "1",
    IMPORT_PARSER_URL: "https://user:password@example.test/path?secret=x", IMPORT_PARSER_SHARED_SECRET: "short" }));
  assert.deepEqual(malformed.errors, ["IMPORT_PARSER_URL", "IMPORT_PARSER_SHARED_SECRET"]);
});

test("production refuses non-HTTPS origins and wildcard proxy trust", () => {
  const result = inspectRuntimeEnvironment(productionEnvironment({ ARTIFACT_REQUIRE_ENCRYPTION: "1",
    PUBLIC_APP_ORIGIN: "http://goldis.example.test", TRUST_PROXY_IPS: "*" }));
  assert.deepEqual(result.errors, ["PUBLIC_APP_ORIGIN", "TRUST_PROXY_IPS"]);
});

test("live mode requires portal credentials, absolute config/staging paths, and a 32-byte staging key", () => {
  const result = inspectRuntimeEnvironment(validLocalEnvironment({ WORKER_LIVE_PORTALS: "1" }));
  assert.deepEqual(result.errors, [
    "PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD", "WORKER_PORTAL_CONFIG_PATH",
    "WORKER_STAGING_DIR", "WORKER_STAGING_KEY_VERSION", "WORKER_STAGING_KEY_V1",
  ]);
});

test("off mode validates an optional staging key with the worker's numeric version and base64url contract", () => {
  const valid = inspectRuntimeEnvironment(validLocalEnvironment({
    WORKER_STAGING_DIR: "C:\\Temp\\goldis-staging",
    WORKER_STAGING_KEY_VERSION: "1",
    WORKER_STAGING_KEY_V1: Buffer.alloc(32, 9).toString("base64url"),
  }));
  assert.deepEqual(valid.errors, []);

  const invalid = inspectRuntimeEnvironment(validLocalEnvironment({
    WORKER_STAGING_DIR: "C:\\Temp\\goldis-staging",
    WORKER_STAGING_KEY_VERSION: "local-v1",
    WORKER_STAGING_KEY_V1: Buffer.alloc(32, 255).toString("base64"),
  }));
  assert.deepEqual(invalid.errors, ["WORKER_STAGING_KEY_VERSION", "WORKER_STAGING_KEY_V1"]);
});

test("off mode rejects the nonnumeric PESEL key version written by older local setup scripts", () => {
  const result = inspectRuntimeEnvironment(validLocalEnvironment({ PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "local-v1" }));
  assert.deepEqual(result.errors, ["PESEL_ENCRYPTION_ACTIVE_KEY_VERSION", "PESEL_ENCRYPTION_KEYS_BASE64"]);
});

test("registry request and portal action intervals accept optional bounded positive integers", () => {
  const valid = inspectRuntimeEnvironment(validLocalEnvironment({
    MF_VAT_MIN_REQUEST_INTERVAL_MS: "60000",
    WORKER_PORTAL_MIN_ACTION_INTERVAL_MS: "1000",
  }));
  assert.deepEqual(valid.errors, []);

  const invalid = inspectRuntimeEnvironment(validLocalEnvironment({
    MF_VAT_MIN_REQUEST_INTERVAL_MS: "60001",
    WORKER_PORTAL_MIN_ACTION_INTERVAL_MS: "60001",
  }));
  assert.deepEqual(invalid.errors, ["MF_VAT_MIN_REQUEST_INTERVAL_MS", "WORKER_PORTAL_MIN_ACTION_INTERVAL_MS"]);
});

test("MF VAT provider requires a bounded cache key before startup", () => {
  const missing = inspectRuntimeEnvironment(validLocalEnvironment({ GOLDIS_ENRICHMENT_PROVIDER: "mf-vat" }));
  assert.deepEqual(missing.errors, ["REGISTRY_CACHE_HMAC_KEY"]);
  const configured = inspectRuntimeEnvironment(validLocalEnvironment({ GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
    REGISTRY_CACHE_HMAC_KEY: "a".repeat(64), MF_VAT_ENVIRONMENT: "production" }));
  assert.deepEqual(configured.errors, []);
  const unsupported = inspectRuntimeEnvironment(validLocalEnvironment({ GOLDIS_ENRICHMENT_PROVIDER: "gus-bir" }));
  assert.deepEqual(unsupported.errors, ["GOLDIS_ENRICHMENT_PROVIDER"]);
});
