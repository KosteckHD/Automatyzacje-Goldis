"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const tag = process.argv[2] ?? "final";
if (!/^[a-z0-9-]{1,24}$/.test(tag)) throw new Error("INVALID_FINAL_TAG");
const dir = path.join(root, "docs/acceptance/2026-11-06-" + tag);
fs.mkdirSync(dir, { recursive: true });
const allowed = /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|PROGRAMFILES|ProgramFiles\(x86\)|HOMEDRIVE|HOMEPATH)$/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
env.WORKER_LIVE_PORTALS = "0";
env.GOLDIS_ENRICHMENT_PROVIDER = "disabled";
env.GOLDIS_EMAIL_PROVIDER = "disabled";
env.PYTHONUTF8 = "1";
const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!fs.existsSync(npm)) throw new Error("NPM_CLI_NOT_FOUND");
const allTasks = [
  ["npm-test", process.execPath, [npm, "test"], 600000],
  ["build", process.execPath, [npm, "run", "build"], 300000],
  ["backend-style", process.execPath, [npm, "run", "check:backend:style"], 45000],
  ["commission-python", process.env.GOLDIS_ACCEPTANCE_PYTHON || "python", ["-m", "unittest", "discover", "-s", "services/commission-engine/tests", "-v"], 60000],
  ["security-browser", process.execPath, ["apps/web/scripts/security-browser-smoke.cjs"], 180000],
  ["return-to", process.execPath, ["--test", "apps/web/scripts/return-to.test.cjs"], 30000],
  ["production-compose", process.execPath, ["scripts/test-production-compose.cjs"], 45000],
  ["extra-browser-coverage", process.execPath, ["--test",
    path.join(root, "apps/worker/dist/portals/pzu/pzu-sms-detection.spec.js"),
    path.join(root, "apps/worker/dist/portals/compensa/compensa-client-choice.spec.js")], 90000],
];
const tasks = process.argv[3] === "npm-only" ? allTasks.filter(([name]) => name === "npm-test")
  : process.argv[3] === "python-only" ? allTasks.filter(([name]) => name === "commission-python")
  : process.argv[3] === "coverage-only" ? allTasks.filter(([name]) => name === "extra-browser-coverage") : allTasks;
const report = { startedAt: new Date().toISOString(), scope: "Sequential local regression, synthetic data, no live portals or customer services. VPS acceptance remains separate.", results: [] };
for (const [name, command, args, timeout] of tasks) {
  const fd = fs.openSync(path.join(dir, name + ".log"), "w");
  const startedAt = new Date().toISOString();
  const taskEnv = name === "commission-python" ? { ...env, PYTHONPATH: path.join(root, "services/commission-engine/src") }
    : name === "extra-browser-coverage" ? { ...env, PLAYWRIGHT_INTEGRATION: "1" } : env;
  const cwd = name === "extra-browser-coverage" ? path.join(root, "apps/worker") : root;
  const result = spawnSync(command, args, { cwd, env: taskEnv, windowsHide: true, stdio: ["ignore", fd, fd], timeout });
  fs.closeSync(fd);
  const row = { name, startedAt, endedAt: new Date().toISOString(), status: result.error ? "INCOMPLETE" : result.status === 0 ? "PASS" : "FAIL", exitCode: result.status, error: result.error?.code ?? null, evidence: name + ".log" };
  report.results.push(row);
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(row) + "\n");
}
process.exitCode = report.results.every(row => row.status === "PASS") ? 0 : 1;
