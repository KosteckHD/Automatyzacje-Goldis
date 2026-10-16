"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { output, runtimeScenarioReport } = require("./backend-refactor-runtime-scenarios.cjs");

const root = path.resolve(__dirname, "..");

test("runtime scenario manifest assigns stable IDs to every parameterized test variant", () => {
  const expected = JSON.parse(fs.readFileSync(output, "utf8"));
  const actual = runtimeScenarioReport();
  assert.deepEqual(actual, expected, "run npm run backend:refactor:runtime-scenarios after changing a parameterized test");
  assert.ok(actual.evidence.declarationFamilies >= 10);
  assert.ok(actual.evidence.runtimeVariants >= actual.evidence.declarationFamilies);
  assert.deepEqual(actual.evidence.missingFamilies, []);
  assert.equal(new Set(actual.cases.map((item) => item.id)).size, actual.cases.length);
  for (const item of actual.cases) {
    assert.match(item.id, /^TV-[a-f0-9]{12}(?:-\d+)?$/);
    assert.ok(item.declarationId && item.owner && item.stage && item.sourcePath && item.targetPath && item.title);
    assert.ok(fs.existsSync(path.join(root, item.sourcePath)));
    assert.ok(["passed-during-inventory", "skipped-by-guard", "opt-in-not-executed"].includes(item.runtimeStatus));
  }
  assert.equal(actual.evidence.fixtureVariantsNotExecuted, 2);
});
