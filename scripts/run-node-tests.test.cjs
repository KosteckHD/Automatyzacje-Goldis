"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { discoverNodeTests } = require("./run-node-tests.cjs");

test("recursive discovery finds spec tests deterministically, excluding integration tests and legacy names", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-node-test-discovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ["z.spec.js", "legacy.test.js", "features/auth/auth.service.spec.js", "features/auth/auth.http.spec.js",
    "features/auth/auth-contract.spec.js", "features/auth/auth.integration.spec.js", "fixtures/helper.js"]) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
  const relative = discoverNodeTests(directory).map((file) => path.relative(directory, file).replace(/\\/g, "/"));
  assert.deepEqual(relative, ["features/auth/auth-contract.spec.js", "features/auth/auth.http.spec.js",
    "features/auth/auth.service.spec.js", "z.spec.js"]);
  const unit = discoverNodeTests(directory, { kind: "unit" }).map((file) => path.relative(directory, file).replace(/\\/g, "/"));
  assert.deepEqual(unit, ["features/auth/auth.service.spec.js", "z.spec.js"]);
  const http = discoverNodeTests(directory, { kind: "http" }).map((file) => path.relative(directory, file).replace(/\\/g, "/"));
  assert.deepEqual(http, ["features/auth/auth.http.spec.js"]);
  const contract = discoverNodeTests(directory, { kind: "contract" }).map((file) => path.relative(directory, file).replace(/\\/g, "/"));
  assert.deepEqual(contract, ["features/auth/auth-contract.spec.js"]);
  const integration = discoverNodeTests(directory, { kind: "integration" }).map((file) => path.relative(directory, file).replace(/\\/g, "/"));
  assert.deepEqual(integration, ["features/auth/auth.integration.spec.js"]);
});

test("recursive discovery rejects missing roots and empty results", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-node-test-empty-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => discoverNodeTests(path.join(directory, "missing")), /NODE_TEST_DIRECTORY_MISSING/);
  assert.throws(() => discoverNodeTests(directory, { kind: "unknown" }), /NODE_TEST_KIND_INVALID/);
  fs.writeFileSync(path.join(directory, "only.js"), "");
  assert.deepEqual(discoverNodeTests(directory), []);
});
