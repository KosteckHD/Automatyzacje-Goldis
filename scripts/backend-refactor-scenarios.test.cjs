"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { output, scenarioReport } = require("./backend-refactor-scenarios.cjs");

const root = path.resolve(__dirname, "..");

test("stable scenario manifest covers every backend and tooling test case", () => {
  const expected = JSON.parse(fs.readFileSync(output, "utf8"));
  const actual = scenarioReport();
  assert.deepEqual(actual, expected, "run npm run backend:refactor:scenarios after an intentional test inventory change");
  assert.ok(actual.evidence.testFiles >= 120);
  assert.ok(actual.evidence.scenarioPatterns >= 470);
  assert.ok(actual.evidence.dynamicTitlePatterns > 0);
  assert.equal(actual.cases.some((item) => ["sql", "call.sql", "arg", "file", "key"].includes(item.titlePattern)), false,
    "ordinary regex/assertion .test() calls must not be inventoried as node:test cases");
  assert.deepEqual(actual.evidence.filesWithoutCases, []);
  assert.deepEqual(actual.evidence.duplicateIds, []);
});

test("scenario IDs follow the mapped destination and point to an existing current test", () => {
  const generated = scenarioReport();
  const { cases } = generated;
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  for (const item of cases) {
    assert.match(item.id, /^TC-[a-f0-9]{12}(?:-\d+)?$/);
    assert.ok(item.owner);
    assert.ok(item.stage);
    assert.ok(item.targetPath);
    assert.ok(item.titlePattern);
    assert.ok(fs.existsSync(path.join(root, item.sourcePath)), `missing source test: ${item.sourcePath}`);
  }
  const conditionalSkips = cases.filter((item) => item.skipCondition !== null);
  assert.equal(conditionalSkips.length, generated.evidence.scenariosWithSkipConditions);
  assert.ok(conditionalSkips.length >= 50);
  for (const item of conditionalSkips) {
    assert.ok(item.owner && item.stage, `skip must have a feature owner: ${item.sourcePath}`);
    assert.match(item.skipCondition, /PLAYWRIGHT_INTEGRATION/);
  }
});
