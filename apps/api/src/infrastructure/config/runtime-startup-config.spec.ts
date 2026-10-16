import assert from "node:assert/strict";
import { test } from "node:test";
import { assertApiStartupConfiguration } from "./runtime-startup-config";

function validProduction() {
  const keyring = Buffer.from(JSON.stringify({ "1": Buffer.alloc(32, 3).toString("base64") })).toString("base64");
  return {
    APP_ENV: "production", NODE_ENV: "production",
    DATABASE_URL: "postgres://goldis_api:synthetic@postgres:5432/goldis",
    REDIS_URL: `redis://goldis_api:${"a".repeat(64)}@redis:6379/0`,
    SESSION_SECRET: "s".repeat(40), LOGIN_RATE_LIMIT_SECRET: "l".repeat(40), WORKER_AUTH_SECRET: "w".repeat(40),
    PUBLIC_APP_ORIGIN: "https://goldis.example.test", TRUST_PROXY_IPS: "172.30.10.10",
    ARTIFACT_REQUIRE_ENCRYPTION: "1",
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1", PESEL_ENCRYPTION_KEYS_BASE64: keyring,
    ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: "1", ARTIFACT_ENCRYPTION_KEYS_BASE64: keyring,
    IMPORT_PARSER_URL: "http://import-parser:3010", IMPORT_PARSER_SHARED_SECRET: "p".repeat(40),
    PRIVILEGED_ACTION_BINDING_KEY: "q".repeat(64),
  };
}

test("API production startup accepts only the private service topology and active encryption keys", () => {
  assert.doesNotThrow(() => assertApiStartupConfiguration(validProduction()));
  assert.doesNotThrow(() => assertApiStartupConfiguration({ APP_ENV: "development" }));
});

test("API production startup rejects a DB superuser, user Redis ACL, wildcard proxy, and plaintext artifact mode", () => {
  assert.throws(() => assertApiStartupConfiguration({
    ...validProduction(), DATABASE_URL: "postgres://goldis:secret@postgres/goldis",
    REDIS_URL: "redis://goldis_worker:secret@redis:6379/0", TRUST_PROXY_IPS: "*", ARTIFACT_REQUIRE_ENCRYPTION: "0",
  }), /DATABASE_URL_ROLE,REDIS_URL_ROLE,TRUST_PROXY_IPS,ARTIFACT_REQUIRE_ENCRYPTION/);
});

test("API production startup requires distinct minimum-length authentication secrets", () => {
  for (const field of ["SESSION_SECRET", "LOGIN_RATE_LIMIT_SECRET", "WORKER_AUTH_SECRET"] as const) {
    const environment = validProduction();
    environment[field] = "";
    assert.throws(() => assertApiStartupConfiguration(environment), new RegExp(field));
  }
});
