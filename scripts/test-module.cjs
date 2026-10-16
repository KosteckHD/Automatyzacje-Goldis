"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

// Keep this manifest explicit. Module runs must never fall back to a broad
// glob, an automation smoke, or the production portal worker.
const MODULES = Object.freeze({
  migrations: { workspace: "@goldis/api", db: true },
  "migrations-upgrade": { workspace: "@goldis/api", db: true, dbMode: "migrations-upgrade" },
  "password-recovery": { workspace: "@goldis/api", db: true, dbMode: "password-recovery" },
  "tenant-scope": { workspace: "@goldis/api", db: true, dbMode: "tenant-scope" },
  "security-db": { workspace: "@goldis/api", db: true, dbMode: "security-db" },
  "runtime-roles": { workspace: "@goldis/api", db: true, dbMode: "runtime-roles" },
  "app-module": { workspace: "@goldis/api", db: true, dbMode: "app-module" },
  deletion: { workspace: "@goldis/api", db: true, dbMode: "deletion" },
  "run-control": { workspace: "@goldis/api", db: true, dbMode: "run-control" },
  "security-redis": { workspace: "@goldis/api", redis: true },
  "security-browser": { workspace: "@goldis/web", browser: true },
  "backup-restore": { workspace: "@goldis/api", db: true },
  grouping: { workspace: "@goldis/api", db: true, dbMode: "grouping", files: [
    "features/grouping/grouping.module.spec.js", "features/grouping/entity-grouping.spec.js",
  ] },
  "registry-jobs": { workspace: "@goldis/api", db: true },
  reports: { workspace: "@goldis/api", db: true },
  runtime: { workspace: "@goldis/api", files: [
    "infrastructure/config/runtime-manifest.spec.js", "infrastructure/config/runtime-startup-config.spec.js",
    "infrastructure/config/api-runtime-config.spec.js",
    "infrastructure/config/process-runtime-config.spec.js",
  ] },
  database: { workspace: "@goldis/api", files: [
    "infrastructure/database/database.factory.spec.js",
  ] },
  health: { workspace: "@goldis/api", files: [
    "features/health/health-probe.spec.js", "features/health/health-readiness.spec.js",
    "features/health/enrichment-worker-health.spec.js", "features/health/health.http.spec.js",
  ] },
  registry: { workspace: "@goldis/api", files: [
    "features/enrichment/enrichment.module.spec.js",
    "features/enrichment/mf-vat-provider.spec.js", "features/enrichment/gus-bir-provider.spec.js",
    "features/enrichment/registry-cache.spec.js", "features/enrichment/registry-provider.factory.spec.js",
    "features/enrichment/registry-request-budget.spec.js", "features/enrichment/registry-request-pacer.spec.js",
    "features/enrichment/enrichment-jobs.runner.spec.js",
    "features/enrichment/enrichment-jobs.service.spec.js",
    "features/enrichment/registry-provider.spec.js", "features/enrichment/registry-lookup.spec.js", "contracts/registry-result.spec.js",
  ] },
  runs: { workspace: "@goldis/api", files: [
    "features/runs/run-control.dto.spec.js", "features/runs/run-cancellation.service.spec.js", "features/runs/run-control.service.spec.js", "features/runs/run-recovery.service.spec.js", "features/runs/run-resume.service.spec.js", "features/runs/runs-read.service.spec.js",
    "features/runs/runs.module.spec.js",
  ] },
  interventions: { workspace: "@goldis/api", files: [
    "features/interventions/interventions.module.spec.js", "features/interventions/manual-data.repository.spec.js",
    "features/interventions/manual-data.service.spec.js", "features/interventions/auth-challenges.spec.js",
    "features/interventions/interventions.service.spec.js", "features/interventions/manual-data.spec.js", "features/interventions/auth-challenges.http.spec.js",
  ] },
  notifications: { workspace: "@goldis/api", files: [
    "features/notifications/notifications.module.spec.js",
    "features/notifications/notifications.service.spec.js",
  ] },
  review: { workspace: "@goldis/api", files: [
    "features/imports/imports.http.spec.js", "features/imports/import.dto.spec.js", "features/imports/import.service.spec.js", "features/imports/imports.module.spec.js",
    "features/imports/import-parser.spec.js", "features/imports/workbook.spec.js",
    "features/preparations/preparations.dto.spec.js", "features/preparations/preparations.service.spec.js", "features/preparations/preparations.module.spec.js",
    "features/grouping/grouping.module.spec.js",
    "features/review/review.module.spec.js",
    "features/review/review.dto.spec.js",
    "features/preparations/import-preparations.http.spec.js", "features/preparations/preparation-analysis.spec.js",
    "features/preparations/preparation-export.spec.js", "features/preparations/preparation-workflows.service.spec.js",
    "features/review/review.http.spec.js", "features/grouping/entity-grouping.spec.js",
  ] },
  leads: { workspace: "@goldis/api", files: ["features/leads/leads.module.spec.js", "features/leads/business-leads.http.spec.js"] },
  teams: { workspace: "@goldis/api", files: ["features/teams/team.http.spec.js", "features/teams/team.module.spec.js", "features/teams/team.service.spec.js"] },
  tools: { workspace: "@goldis/api", files: ["features/tools/tools.module.spec.js", "features/tools/tools.service.spec.js"] },
  admin: { workspace: "@goldis/api", files: ["features/admin/admin.http.spec.js", "features/admin/admin.module.spec.js", "features/admin/admin-mutations.service.spec.js", "features/privileged-actions/privileged-actions.module.spec.js"] },
  "teams-db": { workspace: "@goldis/api", db: true, dbMode: "teams-db" },
  "admin-users-db": { workspace: "@goldis/api", db: true, dbMode: "admin-users-db" },
  submission: { workspace: "@goldis/api", files: [
    "features/submissions/run-submission.dto.spec.js", "features/submissions/submissions.module.spec.js",
    "features/submissions/run-submissions.http.spec.js",
  ] },
  auth: { workspace: "@goldis/api", files: [
    "features/auth/session.guard.spec.js", "features/auth/auth.session.spec.js",
    "features/auth/auth.module.spec.js",
    "features/auth/auth.service.spec.js",
      "features/account-recovery/account-recovery.http.spec.js",
      "features/account-recovery/account-recovery.module.spec.js",
    "features/auth/session.service.spec.js",
    "features/identity/identity.module.spec.js",
    "features/identity/identity.repository.spec.js",
    "features/authorization/authorization.module.spec.js", "features/authorization/authorization-guard.spec.js",
    "features/auth/login-rate-limiter.spec.js", "features/auth/password-hash.spec.js", "features/auth/password-policy.spec.js",
    "features/authorization/authorization.repository.spec.js",
    "features/authorization/authorization-policy.spec.js", "features/authorization/resource-scope.spec.js",
    "infrastructure/http/request-protection.http.spec.js", "infrastructure/http/http-bootstrap.spec.js",
    "features/account-recovery/auth-mail-config.spec.js", "features/account-recovery/auth-mail-crypto.spec.js", "features/account-recovery/recovery-email.spec.js", "features/account-recovery/resend-mail-provider.spec.js",
    "features/auth/offline-admin-password-reset.spec.js",
  ] },
  security: { workspace: "@goldis/api", files: [
    "features/authorization/authorization-guard.spec.js", "features/authorization/authorization-policy.spec.js", "infrastructure/http/http-bootstrap.spec.js", "infrastructure/http/public-output.spec.js", "features/admin/manager-revocation.http.spec.js", "features/auth/session.guard.spec.js",
    "features/privileged-actions/privileged-actions.spec.js",
    "features/reports/history.spec.js", "features/auth/login-rate-limiter.spec.js", "features/auth/password-hash.spec.js", "features/auth/password-policy.spec.js",
    "features/authorization/resource-scope.spec.js", "features/runs/run-cancel.http.spec.js", "features/auth/auth.session.spec.js", "features/authorization/tool-access.spec.js",
    "contracts/user-serialization.spec.js", "features/imports/workbook.spec.js",
  ] },
    "deletion-step-up": { workspace: "@goldis/api", files: [
      "features/deletions/deletion-step-up.spec.js",
      "features/deletions/deletion-step-up.controller.spec.js",
      "features/deletions/deletion-step-up.module.spec.js",
      "features/deletions/deletion-step-up.service.spec.js",
      "features/deletions/deletions.module.spec.js",
      "features/deletions/deletions.service.spec.js",
    ] },
  "deletion-jobs": { workspace: "@goldis/api", files: [
    "features/deletions/deletions.module.spec.js",
    "features/deletions/deletion-jobs.service.spec.js",
  ] },
  "worker-lifecycle": { workspace: "@goldis/worker", files: [
    "apps/worker/dist/application/worker-shutdown.spec.js", "apps/worker/dist/application/run-worker.spec.js",
  ] },
  sms: { workspaces: ["@goldis/api", "@goldis/worker"], files: [
    "apps/api/dist/features/interventions/auth-challenges.spec.js", "apps/api/dist/features/interventions/auth-challenges.http.spec.js",
    "apps/api/dist/features/interventions/sms-retry-policy.spec.js", "apps/worker/dist/features/authentication/auth-challenges.spec.js",
    "apps/worker/dist/features/authentication/code-inbox.spec.js",
  ] },
  results: { workspaces: ["@goldis/api", "@goldis/worker"], files: [
    "apps/api/dist/features/results/results.module.spec.js",
    "apps/api/dist/features/results/results.service.spec.js",
    "apps/api/dist/features/results/artifact-download.repository.spec.js",
    "apps/api/dist/features/results/artifact-download-headers.spec.js", "apps/api/dist/features/results/artifact-download.http.spec.js",
    "apps/api/dist/features/results/artifact-crypto.spec.js", "apps/api/dist/features/results/artifact-store.spec.js",
    "apps/api/dist/features/results/export.spec.js", "apps/api/dist/features/results/run-export.spec.js",
    "apps/api/dist/features/results/canonical-json.spec.js",
    "apps/worker/dist/infrastructure/staging/result-staging.spec.js", "apps/worker/dist/features/results/oc.spec.js", "apps/worker/dist/testing/fixtures/oc-fixtures.spec.js",
  ] },
  "audit-reports": { workspace: "@goldis/api", files: [
    "features/audit/audit.spec.js", "features/audit/audit.module.spec.js", "features/audit/audit.service.spec.js", "features/reports/reports.module.spec.js", "features/audit/audit-search.http.spec.js",
  ] },
  everest: { workspace: "@goldis/worker", files: [
    "apps/worker/dist/portals/pzu/everest-identity-provider.spec.js", "apps/worker/dist/portals/shared/portal-action-pacer.spec.js",
  ] },
  "everest-browser": { workspace: "@goldis/worker", browserFixture: true, testCwd: "apps/worker", files: [
    "apps/worker/dist/portals/pzu/everest-identity-provider.spec.js", "apps/worker/dist/portals/shared/portal-navigation.spec.js",
  ] },
  compensa: { workspace: "@goldis/worker", files: [
    "apps/worker/dist/portals/compensa/compensa-session.spec.js", "apps/worker/dist/portals/compensa/compensa-portal.spec.js",
    "apps/worker/dist/portals/compensa/compensa-form.spec.js", "apps/worker/dist/portals/compensa/compensa-offer-saver.spec.js",
    "apps/worker/dist/portals/compensa/compensa-offer-checkpoint.spec.js",
  ] },
  "compensa-browser": { workspace: "@goldis/worker", browserFixture: true, testCwd: "apps/worker", files: [
    "apps/worker/dist/portals/compensa/compensa-session.spec.js", "apps/worker/dist/portals/compensa/compensa-portal.spec.js",
    "apps/worker/dist/portals/compensa/compensa-form.spec.js", "apps/worker/dist/portals/compensa/compensa-offer-saver.spec.js",
    "apps/worker/dist/portals/compensa/compensa-offer-checkpoint.spec.js",
  ] },
  ufg: { workspace: "@goldis/worker", files: [
    "apps/worker/dist/portals/compensa/compensa-ufg.spec.js",
  ] },
  "ufg-browser": { workspace: "@goldis/worker", browserFixture: true, testCwd: "apps/worker", files: [
    "apps/worker/dist/portals/compensa/compensa-ufg.spec.js", "apps/worker/dist/features/results/oc.spec.js", "apps/worker/dist/infrastructure/browser/browser.spec.js",
  ] },
});

const FULL_FLOW_ENV_KEYS = Object.freeze([
  "GOLDIS_AUTOMATION_E2E",
  "GOLDIS_FULL_FLOW_E2E",
  "GOLDIS_PLATFORM_E2E",
  "GOLDIS_LIVE_E2E",
]);

function isolatedEnvironment(parent = process.env, moduleName, ownedTempDir = path.join(os.tmpdir(), `goldis-module-guard-${process.pid}`)) {
  const env = { ...parent };
  for (const key of FULL_FLOW_ENV_KEYS) delete env[key];
  for (const key of [
    "GOLDIS_TEST_DATABASE_ADMIN_URL", "PZU_LOGIN", "PZU_PASSWORD", "COMPENSA_LOGIN", "COMPENSA_PASSWORD",
    "GOLDIS_TEST_POSTGRES_CONTAINER", "GOLDIS_TEST_POSTGRES_OWNER",
    "GOLDIS_TEST_REDIS_DISPOSABLE", "LOGIN_RATE_LIMIT_KEY_PREFIX",
    "WORKER_AUTH_SECRET", "WORKER_STAGING_KEY_V1", "PESEL_ENCRYPTION_KEYS_BASE64", "ARTIFACT_ENCRYPTION_KEYS_BASE64", "ARTIFACT_REQUIRE_ENCRYPTION", "SESSION_SECRET", "LOGIN_RATE_LIMIT_SECRET", "PRIVILEGED_ACTION_BINDING_KEY",
    "GOLDIS_ADMIN_PASSWORD", "REGISTRY_CACHE_HMAC_KEY", "GUS_BIR_USER_KEY", "RESEND_API_KEY",
    "AUTH_MAIL_ENCRYPTION_KEYS_BASE64", "AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION",
    "GOLDIS_OFFLINE_ADMIN_RECOVERY",
    "GOLDIS_EMAIL_FROM", "GOLDIS_EMAIL_REPLY_TO",
  ]) delete env[key];
  env.DATABASE_URL = "postgres://goldis_module_test:unused@127.0.0.1:1/goldis_module_test";
  env.REDIS_URL = "redis://127.0.0.1:1/15";
  env.WORKER_LIVE_PORTALS = "0";
  delete env.WORKER_PZU_LOGIN_TEST_RUN_ID;
  env.WORKER_PORTAL_MIN_ACTION_INTERVAL_MS = "1000";
  env.ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
  env.ARTIFACT_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({ "1": Buffer.alloc(32, 11).toString("base64") })).toString("base64");
  env.ARTIFACT_REQUIRE_ENCRYPTION = "0";
  env.PRIVILEGED_ACTION_BINDING_KEY = "module-isolated-binding-secret-at-least-32-bytes";
  env.GOLDIS_ENRICHMENT_PROVIDER = "disabled";
  env.GOLDIS_PASSWORD_RECOVERY_ENABLED = "0";
  env.GOLDIS_EMAIL_PROVIDER = "disabled";
  env.GOLDIS_TEST_MODULE = moduleName;
  env.GOLDIS_TEST_MODULE_RUNNER = "1";
  env.PLAYWRIGHT_INTEGRATION = "0";
  if (MODULES[moduleName]?.browserFixture === true) env.PLAYWRIGHT_INTEGRATION = "1";
  env.WORKER_PROFILE_DIR = path.join(ownedTempDir, "profile");
  env.WORKER_STAGING_DIR = path.join(ownedTempDir, "staging");
  env.API_EXPORT_DIR = path.join(ownedTempDir, "exports");
  return env;
}

function npmCommand(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("RUN_MODULE_TESTS_THROUGH_NPM");
  return { command: process.execPath, args: [npmCli, ...args] };
}

function commandFor(name) {
  const definition = MODULES[name];
  if (!definition) throw new Error("TEST_MODULE_UNKNOWN");
  if (definition.browser) {
    const command = npmCommand(["run", "test:module:security-browser"]);
    return {
      command: command.command,
      args: command.args,
      env: isolatedEnvironment(process.env, name),
    };
  }
  if (definition.redis) {
    if (process.platform !== "win32") throw new Error("SECURITY_REDIS_MODULE_REQUIRES_WINDOWS_DOCKER_RUNNER");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts/Test-GoldisSecurityRedis.ps1")],
      env: isolatedEnvironment(process.env, name),
    };
  }
  if (definition.db) {
    if (process.platform !== "win32") throw new Error("MIGRATION_MODULE_REQUIRES_WINDOWS_DOCKER_RUNNER");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts/Test-GoldisDatabase.ps1"), "-Module", definition.dbMode ?? name],
      env: isolatedEnvironment(process.env, name),
    };
  }
  const workspaces = definition.workspaces ?? [definition.workspace];
  const buildCommands = workspaces.map((workspace) => npmCommand(["run", "build", "-w", workspace]));
  const testFiles = definition.files.map((file) => path.resolve(ROOT,
    file.startsWith("apps/") ? file : `apps/api/dist/${file}`));
  assertUniqueTestFiles(testFiles);
  return {
    buildCommands,
    testFiles,
    command: process.execPath,
    args: ["--test", ...testFiles],
    testCwd: definition.testCwd ? path.resolve(ROOT, definition.testCwd) : ROOT,
    env: isolatedEnvironment(process.env, name),
  };
}

function assertUniqueTestFiles(files) {
  const normalized = files.map((file) => path.resolve(file));
  if (new Set(normalized).size !== normalized.length) throw new Error("TEST_MODULE_DUPLICATE_TEST_FILE");
}

function assertTestFilesExist(files) {
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`TEST_MODULE_FILE_MISSING_${path.relative(ROOT, path.resolve(file)).replace(/\\/g, "/")}`);
    }
  }
}

function run(name) {
  const ownedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), `goldis-module-${randomBytes(4).toString("hex")}-`));
  let plan;
  try {
    plan = commandFor(name);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "TEST_MODULE_INVALID"}\n`);
    fs.rmSync(ownedTempDir, { recursive: true, force: true });
    return 2;
  }
  plan.env = isolatedEnvironment(process.env, name, ownedTempDir);
  try {
    for (const build of plan.buildCommands ?? []) {
      const result = spawnSync(build.command, build.args, {
        cwd: ROOT, env: plan.env, stdio: "inherit", windowsHide: true,
      });
      if (result.error || result.status !== 0) return result.status ?? 1;
    }
    assertTestFilesExist(plan.testFiles ?? []);
    const result = spawnSync(plan.command, plan.args, {
      cwd: plan.testCwd ?? ROOT, env: plan.env, stdio: "inherit", windowsHide: true,
    });
    return result.status ?? 1;
  } finally {
    const resolvedTemp = path.resolve(ownedTempDir);
    if (path.dirname(resolvedTemp) !== path.resolve(os.tmpdir()) || !path.basename(resolvedTemp).startsWith("goldis-module-")) {
      throw new Error("TEST_MODULE_TEMP_PATH_OWNERSHIP_INVALID");
    }
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const name = process.argv[2];
  if (!name || process.argv.length !== 3) {
    process.stderr.write(`Usage: node scripts/test-module.cjs <${Object.keys(MODULES).join("|")}>\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = run(name);
  }
}

module.exports = { FULL_FLOW_ENV_KEYS, MODULES, assertTestFilesExist, assertUniqueTestFiles, commandFor, isolatedEnvironment };
