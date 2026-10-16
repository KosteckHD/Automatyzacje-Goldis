"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const secretNames = [
  "database_password", "migrator_db_password", "api_db_password", "worker_db_password", "enrichment_db_password",
  "redis_api_password", "redis_worker_password", "database_url_migrator", "database_url_api", "database_url_worker",
  "database_url_enrichment", "redis_url_api", "redis_url_worker", "session_secret", "login_rate_limit_secret",
  "privileged_action_binding_key", "admin_user", "admin_password", "pesel_keyring", "artifact_keyring", "worker_auth_secret",
  "import_parser_secret", "registry_cache_key", "pzu_login", "pzu_password", "compensa_login", "compensa_password", "worker_staging_key",
  "resend_api_key", "auth_mail_keyring",
];

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-compose-validation-"));
  try {
    const secretsDirectory = path.join(tempRoot, "secrets");
    fs.mkdirSync(secretsDirectory, { recursive: true });
    for (const name of secretNames) fs.writeFileSync(path.join(secretsDirectory, name), "synthetic-compose-test-secret", { mode: 0o600 });
    const envFile = path.join(tempRoot, "production.env");
    const values = {
      APP_ENV: "production",
      GOLDIS_SECRETS_DIR: secretsDirectory.replaceAll("\\", "/"),
      GOLDIS_POSTGRES_IMAGE: `postgres@sha256:${"a".repeat(64)}`,
      GOLDIS_REDIS_IMAGE: `redis@sha256:${"b".repeat(64)}`,
      GOLDIS_API_IMAGE: `api@sha256:${"c".repeat(64)}`,
      GOLDIS_WORKER_IMAGE: `worker@sha256:${"d".repeat(64)}`,
      GOLDIS_WEB_IMAGE: `web@sha256:${"e".repeat(64)}`,
      GOLDIS_BUILD_VERSION: "0.1.0-fixture",
      GOLDIS_BUILD_COMMIT: "a1b2c3d4".padEnd(40, "e"),
      GOLDIS_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
      GOLDIS_WEB_HOST_PORT: "3000",
      PUBLIC_APP_ORIGIN: "https://goldis.example.test",
      TRUST_PROXY_IPS: "172.30.10.10",
    };
    fs.writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    const compose = spawnSync("docker", ["compose", "--env-file", envFile, "-f", "compose.yaml", "-f", "compose.production.yaml", "config", "--format", "json"], {
      cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true,
    });
    assert.equal(compose.error, undefined, "Docker Compose CLI starts");
    assert.equal(compose.status, 0, `production Compose resolves with synthetic secret files: ${compose.stderr || "no diagnostic"}`);
    const parsed = JSON.parse(compose.stdout);
    assert.equal(parsed.services.web.ports[0].host_ip, "127.0.0.1");
    assert.equal(parsed.services.api.environment.APP_ENV, "production");

    const validation = spawnSync(process.execPath, [path.join(__dirname, "validate-production-compose.cjs"), "--env", envFile], {
      cwd: root, encoding: "utf8", timeout: 35_000, windowsHide: true,
    });
    assert.equal(validation.status, 0, `${validation.stdout}${validation.stderr}`);
    assert.match(validation.stdout, /PRODUCTION_COMPOSE_PASS/);
    console.log("PRODUCTION_COMPOSE_FIXTURE_TEST_PASS");
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const tempBase = path.resolve(os.tmpdir()) + path.sep;
    if (!resolvedTemp.startsWith(tempBase) || !path.basename(resolvedTemp).startsWith("goldis-compose-validation-")) {
      throw new Error("TEMP_COMPOSE_FIXTURE_PATH_OWNERSHIP_INVALID");
    }
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

main();
