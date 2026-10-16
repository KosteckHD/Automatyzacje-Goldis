"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workspaces = new Map([
  ["@goldis/core", "packages/core"],
  ["@goldis/api", "apps/api"],
  ["@goldis/worker", "apps/worker"],
]);

function cleanWorkspaceDist(workspaceName) {
  const workspace = workspaces.get(workspaceName);
  if (!workspace) throw new Error("CLEAN_DIST_WORKSPACE_NOT_ALLOWLISTED");
  const workspaceRoot = path.resolve(root, workspace);
  const target = path.resolve(workspaceRoot, "dist");
  const expected = path.join(workspaceRoot, "dist");
  if (target !== expected || path.dirname(target) !== workspaceRoot || !target.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("CLEAN_DIST_TARGET_OUTSIDE_WORKSPACE");
  }
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("CLEAN_DIST_TARGET_NOT_DIRECTORY");
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("CLEAN_DIST_USAGE");
    const target = cleanWorkspaceDist(process.argv[2]);
    process.stdout.write(`WORKSPACE_DIST_CLEANED ${path.relative(root, target).replace(/\\/g, "/")}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CLEAN_DIST_FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = { cleanWorkspaceDist };
