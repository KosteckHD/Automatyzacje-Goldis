import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkerRuntimeConfig } from "./worker-runtime-config";

const validEnvironment = {
  DATABASE_URL: "postgres://goldis_worker:synthetic@127.0.0.1:5432/goldis",
  REDIS_URL: "redis://goldis_worker:synthetic@127.0.0.1:6379/1",
  WORKER_PROFILE_DIR: "C:/worker/profile",
  WORKER_AUTH_SECRET: "synthetic-worker-secret-at-least-32-bytes-long",
  WORKER_RESULT_API_URL: "http://api:3001",
  PUBLIC_APP_ORIGIN: "https://goldis.example",
};

test("worker runtime config applies defaults without returning unrelated secrets", () => {
  const config = loadWorkerRuntimeConfig({ ...validEnvironment, SESSION_SECRET: "must-not-be-copied", PZU_LOGIN: "synthetic-user" });
  assert.equal(config.headless, true);
  assert.equal(config.chromiumSandbox, false);
  assert.equal(config.databasePoolMax, 8);
  assert.equal(config.livePortals, false);
  assert.equal(config.startPaused, false);
  assert.equal(config.internalHost, "0.0.0.0");
  assert.equal(config.internalPort, 3022);
  assert.equal(config.redisUrl, validEnvironment.REDIS_URL);
  assert.equal(config.readinessEnvironment.GOLDIS_API_READY_URL, "http://127.0.0.1:3001/api/health/ready");
  assert.equal(config.resultForwarderEnvironment.WORKER_RESULT_API_URL, validEnvironment.WORKER_RESULT_API_URL);
  assert.equal(config.portalEnvironment.PZU_LOGIN, "synthetic-user");
  assert.equal("SESSION_SECRET" in config.portalEnvironment, false);
  assert.equal("SESSION_SECRET" in config.stagingEnvironment, false);
  assert.equal("SESSION_SECRET" in config, false);
});

test("worker runtime config parses explicit runtime options", () => {
  const config = loadWorkerRuntimeConfig({
    ...validEnvironment, WORKER_HEADLESS: "0", WORKER_CHROMIUM_SANDBOX: "1", WORKER_BROWSER_CHANNEL: "chrome",
    WORKER_DB_POOL_MAX: "12", WORKER_LIVE_PORTALS: "1", WORKER_INTERNAL_HOST: "127.0.0.1",
    WORKER_INTERNAL_PORT: "3030", WORKER_STAGING_DIR: "C:/worker/staging", WORKER_STAGING_KEY_VERSION: "2",
    WORKER_PORTAL_CONFIG_PATH: "C:/worker/portal.json", PZU_LOGIN: "synthetic-pzu-user", PZU_PASSWORD: "synthetic-pzu-password",
    COMPENSA_LOGIN: "synthetic-compensa-user", COMPENSA_PASSWORD: "synthetic-compensa-password",
    GOLDIS_API_READY_URL: "http://api:3010/api/health/ready",
  });
  assert.equal(config.headless, false);
  assert.equal(config.chromiumSandbox, true);
  assert.equal(config.browserChannel, "chrome");
  assert.equal(config.databasePoolMax, 12);
  assert.equal(config.livePortals, true);
  assert.equal(config.startPaused, false);
  assert.equal(config.internalHost, "127.0.0.1");
  assert.equal(config.internalPort, 3030);
  assert.equal(config.stagingDirectory, "C:/worker/staging");
  assert.equal(config.portalConfigPath, "C:/worker/portal.json");
  assert.equal(config.readinessEnvironment.GOLDIS_API_READY_URL, "http://api:3010/api/health/ready");
  assert.equal(config.stagingEnvironment.WORKER_STAGING_DIR, "C:/worker/staging");
});

test("worker runtime config rejects missing credentials and invalid options with stable error codes", () => {
  assert.throws(() => loadWorkerRuntimeConfig({ ...validEnvironment, DATABASE_URL: "" }), /DATABASE_URL is required/);
  assert.throws(() => loadWorkerRuntimeConfig({ ...validEnvironment, WORKER_PROFILE_DIR: "" }), /WORKER_PROFILE_DIR is required/);
  assert.throws(() => loadWorkerRuntimeConfig({ ...validEnvironment, WORKER_AUTH_SECRET: "" }), /WORKER_AUTH_SECRET_REQUIRED/);
  for (const patch of [
    { REDIS_URL: "postgres://localhost/goldis" }, { REDIS_URL: "redis://localhost/not-a-db" },
    { WORKER_RESULT_API_URL: "file:///tmp/results" },
    { PUBLIC_APP_ORIGIN: "https://user:secret@goldis.example" }, { GOLDIS_API_READY_URL: "http://api/other" },
    { WORKER_HEADLESS: "yes" }, { WORKER_CHROMIUM_SANDBOX: "yes" }, { WORKER_LIVE_PORTALS: "yes" },
    { WORKER_BROWSER_CHANNEL: "firefox" }, { WORKER_DB_POOL_MAX: "3" }, { WORKER_INTERNAL_PORT: "65536" },
    { WORKER_INTERNAL_HOST: " " },
  ]) {
    assert.throws(() => loadWorkerRuntimeConfig({ ...validEnvironment, ...patch }));
  }
});

test("live portal mode requires all four portal credentials without exposing values", () => {
  const complete = {
    ...validEnvironment, WORKER_LIVE_PORTALS: "1", PZU_LOGIN: "synthetic-pzu-user", PZU_PASSWORD: "synthetic-pzu-password",
    COMPENSA_LOGIN: "synthetic-compensa-user", COMPENSA_PASSWORD: "synthetic-compensa-password",
  };
  assert.equal(loadWorkerRuntimeConfig(complete).livePortals, true);
  for (const name of ["PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD"] as const) {
    const incomplete = { ...complete, [name]: "   " };
    assert.throws(() => loadWorkerRuntimeConfig(incomplete), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "WORKER_LIVE_PORTAL_CREDENTIALS_REQUIRED");
      assert.equal(error.message.includes("synthetic"), false);
      return true;
    });
  }
  assert.equal(loadWorkerRuntimeConfig({ ...validEnvironment, WORKER_LIVE_PORTALS: "0" }).livePortals, false);
});

test("worker can start paused for safe preparation, but not as a live-ready worker", () => {
  const paused = loadWorkerRuntimeConfig({ ...validEnvironment, WORKER_START_PAUSED: "1" });
  assert.equal(paused.startPaused, true);
  assert.throws(() => loadWorkerRuntimeConfig({
    ...validEnvironment, WORKER_START_PAUSED: "1", WORKER_LIVE_PORTALS: "1",
    PZU_LOGIN: "synthetic-pzu-user", PZU_PASSWORD: "synthetic-pzu-password",
    COMPENSA_LOGIN: "synthetic-compensa-user", COMPENSA_PASSWORD: "synthetic-compensa-password",
  }), /WORKER_START_PAUSED_LIVE_INVALID/);
  assert.throws(() => loadWorkerRuntimeConfig({ ...validEnvironment, WORKER_START_PAUSED: "yes" }), /WORKER_START_PAUSED_INVALID/);
});
