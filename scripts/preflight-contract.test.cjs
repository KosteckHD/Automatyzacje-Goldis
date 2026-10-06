const assert = require("node:assert/strict");
const { test } = require("node:test");
const { inspectRuntimeEnvironment } = require("./preflight-contract.cjs");

function validLocalEnvironment(overrides = {}) {
  const keyring = Buffer.from(JSON.stringify({ local: Buffer.alloc(32, 7).toString("base64") })).toString("base64");
  return {
    DATABASE_URL: "postgres://goldis:synthetic@127.0.0.1:5432/goldis",
    REDIS_URL: "redis://127.0.0.1:6379",
    WORKER_AUTH_SECRET: "synthetic-only-worker-secret-with-more-than-32-bytes",
    WORKER_PROFILE_DIR: "C:\\Temp\\goldis-profile",
    WORKER_HEADLESS: "0",
    WORKER_INTERNAL_PORT: "3022",
    PUBLIC_APP_ORIGIN: "http://localhost:3000",
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "local",
    PESEL_ENCRYPTION_KEYS_BASE64: keyring,
    WORKER_LIVE_PORTALS: "0",
    ...overrides,
  };
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

test("live mode requires portal credentials, absolute config/staging paths, and a 32-byte staging key", () => {
  const result = inspectRuntimeEnvironment(validLocalEnvironment({ WORKER_LIVE_PORTALS: "1" }));
  assert.deepEqual(result.errors, [
    "PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD", "WORKER_PORTAL_CONFIG_PATH",
    "WORKER_STAGING_DIR", "WORKER_STAGING_KEY_VERSION", "WORKER_STAGING_KEY_V1",
  ]);
});
