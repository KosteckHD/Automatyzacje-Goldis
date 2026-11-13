"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const readiness = path.join(root, "docs/production-readiness");
const scenarios = JSON.parse(fs.readFileSync(path.join(root, "docs/backend-refactor/test-scenarios.json"), "utf8"));

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

function sourceSnapshot() {
  const hash = crypto.createHash("sha256");
  const diff = git(["diff", "--binary", "HEAD"], null);
  hash.update(diff);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  for (const relative of untracked) {
    if (relative.startsWith("docs/production-readiness/")) continue;
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    hash.update("\0UNTRACKED\0");
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
  }
  return hash.digest("hex");
}

function fixtureModule(sourcePath) {
  if (sourcePath.includes("infrastructure/browser/")) return "test:module:security-browser";
  if (sourcePath.includes("portals/pzu/") || sourcePath.includes("portals/shared/")) return "test:module:everest-browser";
  if (sourcePath.endsWith("compensa-ufg.spec.ts")) return "test:module:ufg-browser";
  if (sourcePath.includes("portals/compensa/")) return "test:module:compensa-browser";
  return null;
}

const skippedCases = scenarios.cases.filter((item) => item.skipCondition);
const skipRegister = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generatedFrom: "docs/backend-refactor/test-scenarios.json",
  defaultRun: {
    command: "npm test",
    snapshot: "sourceSnapshotSha256 in verification-matrix.json",
    observedRuntimeSkippedTests: 70,
    note: "The manifest contains title patterns (including dynamic-title patterns); runtime skip count is the observed test-run count.",
  },
  summary: {
    scenarioPatternsWithSkipCondition: skippedCases.length,
    distinctSourceFiles: new Set(skippedCases.map((item) => item.sourcePath)).size,
    dedicatedFixtureSuites: [...new Set(skippedCases.map((item) => fixtureModule(item.sourcePath)))].filter(Boolean).sort(),
    fixtureRun: "PASS",
    dedicatedFixtureEvidence: [
      { suite: "test:module:security-browser", status: "PASS", result: "Security browser smoke verified CSP, nonce, cache, framing, idle activity and recovery flow." },
      { suite: "test:module:everest-browser", status: "PASS", tests: "27/27", result: "Includes PZU session, Everest identity and navigation fixtures." },
      { suite: "test:module:compensa-browser", status: "PASS", tests: "39/39" },
      { suite: "test:module:ufg-browser", status: "PASS", tests: "14/14", result: "Includes browser guard and OC table fixture." },
    ],
  },
  entries: skippedCases.map((item) => ({
    id: item.id,
    owner: item.owner,
    sourcePath: item.sourcePath,
    titlePattern: item.titlePattern,
    dynamicTitle: item.dynamicTitle,
    condition: item.skipCondition,
    defaultResult: "SKIP",
    dedicatedFixtureSuite: fixtureModule(item.sourcePath),
    dedicatedFixtureResult: "PASS",
  })),
};

const matrix = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: {
    branch: git(["branch", "--show-current"]).trim(),
    baseHead: git(["rev-parse", "HEAD"]).trim(),
    workingTree: "dirty; changes are intentionally uncommitted",
    sourceSnapshotSha256: sourceSnapshot(),
  },
  environment: {
    node: process.version,
    npm: "11.6.2",
    dockerEngine: "unavailable (dockerDesktopLinuxEngine pipe missing)",
    postgresForPassedDbSmoke: "isolated Windows-native PostgreSQL 18 cluster, loopback-only random port, synthetic data",
    livePortals: false,
  },
  statusLegend: ["PASS", "FAIL", "SKIP", "BLOCKED", "NOT_RUN"],
  stages: [
    { id: "PROD-00", status: "BLOCKED", owner: "engineering", expected: "Complete persistence ownership, tenant/transaction/lock semantics, default skip register, and deployment decisions.", actual: "Static inventory scans 430 production TS files; 207 persistence candidates have feature/process owners, but all 207 still require semantic review. Skip patterns and decision register are generated; deployment values and historical baseline artifacts remain unknown.", evidence: ["docs/production-readiness/persistence-inventory.json", "docs/production-readiness/skip-register.json", "docs/production-readiness/deployment-decisions.md"] },
    { id: "PROD-01", status: "BLOCKED", owner: "engineering/platform", expected: "Repeatable isolated PostgreSQL and Redis suites, with unsupported modes explicit.", actual: "Windows-native isolated PostgreSQL harness is implemented and DB-only modules passed. Docker Engine is unavailable; Redis and Docker Compose modes remain unverified.", evidence: ["scripts/Test-GoldisDatabase.ps1 -NativePostgres", "test:module:reports", "test:module:tenant-scope", "test:module:teams", "test:module:admin-users", "test:module:deletion", "test:module:grouping-perf"] },
    { id: "PROD-02", status: "PASS", owner: "api/reports", expected: "Reports repositories and tenant-scoped projections behave against a real database.", actual: "Isolated PostgreSQL smoke passed reports, contacts, dashboard, lead allocation/idempotency, registry pacing, deletion history, and unauthenticated HTTP boundary. A real history query defect was fixed and re-tested.", evidence: ["test:module:reports (isolated PostgreSQL)", "test:module:deletion (isolated PostgreSQL)"] },
    { id: "PROD-03", status: "BLOCKED", owner: "api/review, api/grouping", expected: "Extract and verify transactional Grouping and Review writes, concurrency and audit rollback.", actual: "Review decision persistence now sits behind ReviewRepository; tenant/grant scope, correction/conflict decisions and audit rollback pass on isolated PostgreSQL. Grouping resolver still performs persistence directly, and the full grouping concurrency matrix is incomplete.", evidence: ["test:module:review (56/56)", "test:module:tenant-scope (isolated PostgreSQL)", "test:module:grouping-perf (isolated PostgreSQL)", "test:architecture"] },
    { id: "PROD-04", status: "BLOCKED", owner: "api/leads", expected: "Separate lead reads, allocation, contact, results and export persistence while preserving CAS/idempotency.", actual: "Lead allocation and idempotency behavior passed within reports smoke; service persistence extraction and the broader specified regression matrix remain incomplete.", evidence: ["test:module:reports (isolated PostgreSQL)"] },
    { id: "PROD-05", status: "BLOCKED", owner: "api/runs, worker", expected: "Extract admission/dispatch/outbox persistence and validate PostgreSQL–Redis failure windows.", actual: "Submission/outbox-related tenant-scope smoke passed. Dedicated Redis, multi-publisher, restart and dispatch failure-window tests were not run; Docker Engine is unavailable.", evidence: ["test:module:tenant-scope (isolated PostgreSQL)"] },
    { id: "PROD-06", status: "BLOCKED", owner: "api/results, api/privileged-actions", expected: "Verify file finalization failure recovery and privileged action replay/rollback on PostgreSQL.", actual: "Privileged actions and deletion DB smokes passed for relevant behavior; export finalization extraction and injected file-publication/commit failure tests remain incomplete.", evidence: ["test:module:team-db (isolated PostgreSQL)", "test:module:admin-users-db (isolated PostgreSQL)", "test:module:deletion-step-up (isolated PostgreSQL)", "test:module:deletion (isolated PostgreSQL)"] },
    { id: "PROD-07", status: "BLOCKED", owner: "engineering", expected: "Remove global DB facade and all temporary architecture exceptions.", actual: "Architecture, transaction audit and HTTP contract checks pass. Review removal reduced layer exceptions from 20 to 17; 17 layer, 90 public-export and 19 source-direction exceptions remain, and the global facade is still present.", evidence: ["npm run test:architecture", "npm run test:transaction-audit", "npm run test:http-contract"] },
    { id: "PROD-08", status: "BLOCKED", owner: "engineering/QA", expected: "Complete HTTP, DB and UI module matrix and resolve every required skip on fixture.", actual: "All 59 manifest skip patterns were assigned to dedicated fixture suites, which passed (security smoke; Everest 27/27; Compensa 39/39; UFG 14/14). The default full run still reports 70 skipped worker cases; route-by-route HTTP/UI coverage remains outstanding.", evidence: ["npm test", "npm run test:e2e:fixture", "docs/production-readiness/skip-register.json"] },
    { id: "PROD-09", status: "BLOCKED", owner: "operator/platform", expected: "Validate isolated production Compose stack and deployment configuration.", actual: "Production Compose configuration passed synthetic-fixture resolution and policy checks. Docker Engine is unavailable, so images/services were not started.", evidence: ["npm run test:production-compose", "docker info (engine unavailable)"] },
    { id: "PROD-10", status: "NOT_RUN", owner: "operator/platform", expected: "Test backup, cold restore, integrity and application rollback on isolated production-shaped environment.", actual: "No backup/restore or application rollback run was performed.", evidence: [] },
    { id: "PROD-11", status: "NOT_RUN", owner: "engineering/operations", expected: "Measure performance and verify security controls, monitoring and alerts.", actual: "Only the existing grouping synthetic DB performance smoke passed; full load, security review and monitoring/alert delivery were not tested.", evidence: ["test:module:grouping-perf (30,000 synthetic rows)"] },
    { id: "PROD-12", status: "NOT_RUN", owner: "engineering/release", expected: "Validate CI and produce a reproducible release bundle tied to source and image digests.", actual: "Local build and tests passed; remote CI, signed/reproducible release artifacts and rollback package were not verified.", evidence: ["npm test", "npm run build"] },
    { id: "PROD-13", status: "BLOCKED", owner: "user/operator", expected: "User accepts live portal behavior for an identified release candidate.", actual: "Not run. Depends on PROD-08–12 and an explicit user/operator live acceptance window.", evidence: [] },
    { id: "PROD-14", status: "BLOCKED", owner: "user/operator", expected: "Operator deploys and accepts the exact identified release on a named installation.", actual: "Not run. No target installation, release digests or operator acceptance record is available.", evidence: [] },
  ],
  executions: [
    { command: "npm test", status: "PASS", result: "core 18/18; API 376/376; worker 115 passed, 70 skipped; portal/live flags disabled", log: "%TEMP%/goldis-prod-plan-npm-test-20261016.log" },
    { command: "npm run build", status: "PASS", result: "core, API, worker and Next.js production build" },
    { command: "npm run check:backend:style", status: "PASS", result: "Biome checked 410 files; 0 errors, 47 warnings" },
    { command: "npm run test:module:runner", status: "PASS", result: "22/22" },
    { command: "npm run test:module:review", status: "PASS", result: "56/56" },
    { command: "npm run test:architecture", status: "PASS", result: "281 files; layer exceptions reduced to 17 with 105 findings; no new boundary violations" },
    { command: "npm run test:transaction-audit", status: "PASS", result: "326 files; 96 transaction boundaries; 0 missing DB transaction/audit propagation" },
    { command: "npm run test:inventory", status: "PASS", result: "9/9" },
    { command: "npm run test:scenarios", status: "PASS", result: "2/2; manifest 193 test files / 630 scenario patterns" },
    { command: "node --test apps/api/dist/features/reports/history.spec.js", status: "PASS", result: "2/2" },
    { command: "isolated PostgreSQL 18 DB smoke modules", status: "PASS", result: "reports, tenant-scope, teams, admin-users, deletion and grouping-perf; synthetic fixtures only" },
    { command: "npm run test:e2e:fixture", status: "PASS", result: "security-browser smoke PASS; Everest 27/27; Compensa 39/39; UFG 14/14; synthetic fixtures only, WORKER_LIVE_PORTALS=0" },
    { command: "npm run test:production-compose", status: "PASS", result: "Resolved production Compose with synthetic env and secret files; no services were started" },
  ],
};

fs.mkdirSync(readiness, { recursive: true });
fs.writeFileSync(path.join(readiness, "skip-register.json"), `${JSON.stringify(skipRegister, null, 2)}\n`);
fs.writeFileSync(path.join(readiness, "verification-matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
console.log(`Wrote readiness matrix and ${skippedCases.length} skip-pattern records; snapshot ${matrix.repository.sourceSnapshotSha256}`);
