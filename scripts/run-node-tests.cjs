"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testPattern = /\.(?:http\.)?spec\.js$/i;
const integrationPattern = /\.integration\.(?:http\.)?spec\.js$/i;
const httpPattern = /\.http\.spec\.js$/i;
const contractPattern = /(?:^|[-.])contract\.spec\.js$/i;
const supportedKinds = new Set(["all", "unit", "http", "contract", "integration"]);

function testKind(file) {
  const name = path.basename(file);
  if (integrationPattern.test(name)) return "integration";
  if (contractPattern.test(name)) return "contract";
  if (httpPattern.test(name)) return "http";
  return "unit";
}

function discoverNodeTests(directory, options = {}) {
  const kind = options.kind ?? "all";
  if (!supportedKinds.has(kind)) throw new Error("NODE_TEST_KIND_INVALID");
  const root = path.resolve(directory);
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) {
    if (error?.code === "ENOENT") throw new Error("NODE_TEST_DIRECTORY_MISSING");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("NODE_TEST_ROOT_MUST_BE_DIRECTORY");
  const found = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && testPattern.test(entry.name)
        && (kind === "all" ? !integrationPattern.test(entry.name) : testKind(entry.name) === kind)) found.push(absolute);
    }
  }
  visit(root);
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

function runNodeTests(directory, options = {}) {
  const files = discoverNodeTests(directory, options);
  if (!files.length) throw new Error("NODE_TEST_DISCOVERY_EMPTY");
  if (options.listOnly) return { files, status: 0 };
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  return { files, status: result.status ?? 1, signal: result.signal ?? null };
}

if (require.main === module) {
  try {
    if (process.argv.length < 3 || process.argv.length > 4) throw new Error("NODE_TEST_RUNNER_USAGE");
    const directory = path.resolve(process.cwd(), process.argv[2]);
    const kind = process.argv[3] ?? "all";
    const result = runNodeTests(directory, { kind });
    process.stdout.write(`NODE_TEST_DISCOVERY_PASS kind=${kind} count=${result.files.length} root=${path.relative(process.cwd(), directory).replace(/\\/g, "/")}\n`);
    process.exitCode = result.status;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "NODE_TEST_RUNNER_FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = { discoverNodeTests, runNodeTests, testKind };
