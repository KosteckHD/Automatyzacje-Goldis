"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { compareHttpContracts } = require("./backend-refactor-http-contract.cjs");

const root = path.resolve(__dirname, "..");
const baseline = JSON.parse(fs.readFileSync(path.join(root, "docs/backend-refactor/legacy-http-contract.json"), "utf8"));
const current = JSON.parse(fs.readFileSync(path.join(root, "docs/backend-refactor/inventory.json"), "utf8"));
const result = compareHttpContracts(baseline.routes, current.routes);

if (result.errors.length) {
  process.stderr.write(`${JSON.stringify({ ...result, errors: result.errors }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `LEGACY_HTTP_CONTRACT_PASS baseline=${result.baselineRouteCount} current=${result.currentRouteCount} removed=0 statusChanges=0 requestDecoratorChanges=0 guardChanges=0 additive=${result.additions.length}\n`,
  );
}
