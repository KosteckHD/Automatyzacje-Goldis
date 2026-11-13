"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { discoverNodeTests } = require("./run-node-tests.cjs");
const root = path.resolve(__dirname, "..");
const tag = process.argv[2] ?? "initial";
if (!/^[a-z0-9-]{1,32}$/.test(tag)) throw new Error("INVALID_ACCEPTANCE_RUN_TAG");
const dir = path.join(root, "docs/acceptance/2026-11-06-local" + (tag === "initial" ? "" : "-" + tag));
fs.mkdirSync(dir, { recursive: true });
const allowed = /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|PROGRAMFILES|ProgramFiles\(x86\)|HOMEDRIVE|HOMEPATH)$/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
env.WORKER_LIVE_PORTALS = "0";
env.GOLDIS_ENRICHMENT_PROVIDER = "disabled";
const tasks = [
  ["architecture", ["scripts/check-feature-boundaries.cjs"], root, 30000],
  ...["packages/core", "apps/api", "apps/worker"].map((workspace) => [workspace.replaceAll("/", "-"), ["--test", "--test-timeout=45000", ...discoverNodeTests(path.join(root, workspace, "dist"))], path.join(root, workspace), 180000]),
  ["return-to", ["--test", "apps/web/scripts/return-to.test.cjs"], root, 30000],
  ["security-browser", ["apps/web/scripts/security-browser-smoke.cjs"], root, 180000],
];
const report = { startedAt: new Date().toISOString(), scope: "Local isolated tests; sanitized environment; live portals disabled. Not a full acceptance or production pentest.", results: [] };
for (const [name, args, cwd, timeout] of tasks) {
  const logPath = path.join(dir, name + ".log");
  const fd = fs.openSync(logPath, "w");
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", fd, fd], timeout });
  fs.closeSync(fd);
  const log = fs.readFileSync(logPath, "utf8");
  const row = { name, startedAt, endedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.code ?? null, status: result.error ? "INCOMPLETE" : result.status === 0 ? "PASS" : "FAIL", summary: log.split(/\r?\n/).filter((line) => /^(ℹ (tests|pass|fail|skipped|cancelled)|# (tests|pass|fail|skipped)|SECURITY_BROWSER)/.test(line)), evidence: name + ".log" };
  report.results.push(row);
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(row) + "\n");
}
process.exitCode = report.results.every(row => row.status === "PASS") ? 0 : 1;
