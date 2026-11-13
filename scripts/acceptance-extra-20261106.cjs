"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isolatedEnvironment } = require("./test-module.cjs");
const root = path.resolve(__dirname, "..");
const group = process.argv[2] ?? "all";
if (!["all", "native", "fixture"].includes(group)) throw new Error("INVALID_EXTRA_GROUP");
const tag = process.argv[3] ?? "";
if (tag && !/^[a-z0-9-]{1,24}$/.test(tag)) throw new Error("INVALID_EXTRA_TAG");
const dir = path.join(root, "docs/acceptance/2026-11-06-extra" + (group === "all" ? "" : "-" + group) + (tag ? "-" + tag : ""));
fs.mkdirSync(dir, { recursive: true });
const allowed = /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|PROGRAMFILES|ProgramFiles\(x86\)|HOMEDRIVE|HOMEPATH)$/i;
const parent = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
const env = isolatedEnvironment(parent, "security");
env.npm_execpath = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!fs.existsSync(env.npm_execpath)) throw new Error("NPM_CLI_NOT_FOUND");
env.PYTHONUTF8 = "1";
const allTasks = [
  ["native-security-db", "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/Test-GoldisDatabase.ps1", "-NativePostgres", "-Module", "security-db"], 360000],
  ["native-commission-db", "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/Test-GoldisDatabase.ps1", "-NativePostgres", "-Module", "commission"], 360000],
  ...["everest-browser", "compensa-browser", "ufg-browser"].map(name => [name, process.execPath, ["scripts/test-module.cjs", name], 240000]),
  ["production-compose", process.execPath, ["scripts/test-production-compose.cjs"], 45000],
];
const tasks = allTasks.filter(([name]) => group === "all" || (group === "native" ? name.startsWith("native-") : !name.startsWith("native-")));
const report = { startedAt: new Date().toISOString(), scope: "Disposable native PG18 security tests and local portal fixtures. No live portals. Does not replace Linux PG17/Redis restore acceptance.", results: [] };
for (const [name, command, args, timeout] of tasks) {
  const fd = fs.openSync(path.join(dir, name + ".log"), "w");
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", fd, fd], timeout });
  fs.closeSync(fd);
  const row = { name, startedAt, endedAt: new Date().toISOString(), status: result.error ? "INCOMPLETE" : result.status === 0 ? "PASS" : "FAIL", exitCode: result.status, error: result.error?.code ?? null, evidence: name + ".log" };
  report.results.push(row);
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(row) + "\n");
}
process.exitCode = report.results.every(row => row.status === "PASS") ? 0 : 1;
