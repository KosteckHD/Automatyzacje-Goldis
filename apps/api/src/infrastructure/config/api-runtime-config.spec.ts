import assert from "node:assert/strict";
import { test } from "node:test";
import { readAuthMailConfig } from "../../features/account-recovery/auth-mail-config";
import { assertImportParserClientConfiguration } from "../../features/imports/import-parser-client";
import { configureApiRuntimeConfig, loadApiRuntimeConfig, loadApiSecretConfig } from "./api-runtime-config";

test("API runtime config applies safe local defaults and returns no secret values", () => {
  const config = loadApiRuntimeConfig({ APP_ENV: "development", SESSION_SECRET: "must-not-be-copied" });
  assert.deepEqual(config, {
    port: 3001,
    trustProxyIps: undefined,
    appEnvironment: "development",
    nodeEnvironment: undefined,
    publicAppOrigin: undefined,
    loginRateLimitKeyPrefix: undefined,
    workerInternalUrl: undefined,
    importParserUrl: undefined,
    apiExportDirectory: undefined,
    deletionJournalDirectory: undefined,
    artifactEncryptionRequired: false,
    deletionWorkerEnabled: true,
    deletionRestoreMaintenance: false,
    build: { version: "0.1.0", commit: null, imageDigest: null },
  });
  assert.equal("sessionSecret" in config, false);
  assert.deepEqual(loadApiSecretConfig({ SESSION_SECRET: "secret-value" }), { sessionSecret: "secret-value",
    loginRateLimitSecret: undefined, privilegedActionBindingKey: undefined, workerAuthSecret: undefined,
    importParserSharedSecret: undefined, redisUrl: undefined, resendApiKey: undefined, authMailEncryptionActiveKeyVersion: undefined,
    authMailEncryptionKeysBase64: undefined, artifactEncryptionActiveKeyVersion: undefined,
    artifactEncryptionKeysBase64: undefined });
});

test("API runtime config parses the listener port and preserves configured proxy addresses", () => {
  assert.deepEqual(loadApiRuntimeConfig({ APP_ENV: "development", API_PORT: "4100", TRUST_PROXY_IPS: "127.0.0.1" }), {
    port: 4100, trustProxyIps: "127.0.0.1", appEnvironment: "development", nodeEnvironment: undefined,
    publicAppOrigin: undefined, loginRateLimitKeyPrefix: undefined, workerInternalUrl: undefined,
    importParserUrl: undefined, apiExportDirectory: undefined, deletionJournalDirectory: undefined,
    artifactEncryptionRequired: false, deletionWorkerEnabled: true, deletionRestoreMaintenance: false,
    build: { version: "0.1.0", commit: null, imageDigest: null },
  });
});

test("API runtime config rejects malformed or out-of-range ports", () => {
  for (const API_PORT of ["abc", "-1", "65536", "1.5"]) {
    assert.throws(() => loadApiRuntimeConfig({ APP_ENV: "development", API_PORT }), /API_PORT_INVALID/);
  }
});

test("API runtime config validates Redis URLs and rate-limit namespaces", () => {
  assert.throws(() => loadApiRuntimeConfig({ REDIS_URL: "https://redis.example" }), /REDIS_URL_INVALID/);
  assert.throws(() => loadApiRuntimeConfig({ LOGIN_RATE_LIMIT_KEY_PREFIX: "invalid prefix" }), /LOGIN_RATE_LIMIT_KEY_PREFIX_INVALID/);
  const environment = { REDIS_URL: "redis://goldis_api:do-not-expose@127.0.0.1:6379/15", LOGIN_RATE_LIMIT_KEY_PREFIX: "goldis:test" };
  const runtimeConfig = loadApiRuntimeConfig(environment);
  assert.equal("redisUrl" in runtimeConfig, false);
  assert.equal(loadApiSecretConfig(environment).redisUrl, environment.REDIS_URL);
  assert.equal(JSON.stringify(runtimeConfig).includes("do-not-expose"), false);
});

test("safe service URLs reject embedded credentials and ignored query/path data", () => {
  for (const WORKER_INTERNAL_URL of ["https://user:password@worker.example", "https://worker.example/?token=secret", "https://worker.example/base"]) {
    assert.throws(() => loadApiRuntimeConfig({ APP_ENV: "development", WORKER_INTERNAL_URL }), /WORKER_INTERNAL_URL_INVALID/);
  }
  for (const IMPORT_PARSER_URL of ["https://key:password@parser.example", "https://parser.example/?token=secret", "https://parser.example/other"]) {
    assert.throws(() => loadApiRuntimeConfig({ APP_ENV: "development", IMPORT_PARSER_URL }), /IMPORT_PARSER_URL_INVALID/);
  }
  assert.equal(loadApiRuntimeConfig({ APP_ENV: "development", WORKER_INTERNAL_URL: "http://127.0.0.1:3022" }).workerInternalUrl,
    "http://127.0.0.1:3022");
});

test("API startup config remains a stable snapshot after bootstrap", () => {
  const environment: Record<string, string | undefined> = {
    APP_ENV: "development", NODE_ENV: "development", API_PORT: "4100", SESSION_SECRET: "startup-secret",
    GOLDIS_PASSWORD_RECOVERY_ENABLED: "1", GOLDIS_EMAIL_PROVIDER: "resend",
    PUBLIC_APP_ORIGIN: "http://localhost:3000", GOLDIS_EMAIL_FROM: "Goldis <noreply@example.test>",
    RESEND_API_KEY: `re_${"r".repeat(32)}`,
    IMPORT_PARSER_URL: "http://127.0.0.1:3010", IMPORT_PARSER_SHARED_SECRET: "p".repeat(40),
  };
  configureApiRuntimeConfig(environment);
  environment.API_PORT = "4200";
  environment.SESSION_SECRET = "changed-secret";
  environment.GOLDIS_PASSWORD_RECOVERY_ENABLED = "0";
  environment.GOLDIS_EMAIL_PROVIDER = "disabled";
  environment.GOLDIS_EMAIL_FROM = "changed@example.test";
  environment.RESEND_API_KEY = "changed-provider-secret";
  environment.IMPORT_PARSER_URL = "javascript:invalid";
  environment.IMPORT_PARSER_SHARED_SECRET = "changed";
  assert.equal(loadApiRuntimeConfig().port, 4100);
  assert.equal(loadApiSecretConfig().sessionSecret, "startup-secret");
  assert.equal(readAuthMailConfig().enabled, true);
  assert.equal(readAuthMailConfig().from, "Goldis <noreply@example.test>");
  assert.equal(JSON.stringify(loadApiRuntimeConfig()).includes("re_"), false);
  assert.equal(loadApiSecretConfig().resendApiKey, `re_${"r".repeat(32)}`);
  assert.equal(loadApiSecretConfig().importParserSharedSecret, "p".repeat(40));
  assert.doesNotThrow(() => assertImportParserClientConfiguration());
  assert.deepEqual(readAuthMailConfig(), {
    enabled: true,
    provider: "resend",
    publicOrigin: "http://localhost:3000",
    from: "Goldis <noreply@example.test>",
    replyTo: null,
    resendApiKey: `re_${"r".repeat(32)}`,
  });
});
