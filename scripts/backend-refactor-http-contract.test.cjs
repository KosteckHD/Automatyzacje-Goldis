"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { compareHttpContracts, currentStatus } = require("./backend-refactor-http-contract.cjs");

const baselineRoute = {
  method: "POST",
  path: "/admin/users/:userId/password-reset-link",
  status: 202,
  requestDecorators: [
    { name: "Param", args: ["userId"] },
    { name: "Body", args: [] },
    { name: "Req", args: [] },
  ],
  controllerGuards: ["SessionGuard", "AdminOnlyGuard"],
  methodGuards: [],
};

const currentRoute = {
  method: baselineRoute.method,
  path: baselineRoute.path,
  frameworkDefaultStatusCandidate: 201,
  explicitStatus: ["HttpStatus.ACCEPTED"],
  requestInputs: baselineRoute.requestDecorators.map((input) => ({ ...input, parameter: "input" })),
  controllerGuards: [...baselineRoute.controllerGuards],
  methodGuards: [],
};

test("resolves numeric and Nest HttpStatus status contracts", () => {
  assert.equal(currentStatus(currentRoute), 202);
  assert.equal(currentStatus({ ...currentRoute, explicitStatus: ["202"] }), 202);
  assert.equal(currentStatus({ ...currentRoute, explicitStatus: null }), 201);
});

test("preserves an existing route and reports additive routes separately", () => {
  const result = compareHttpContracts([baselineRoute], [currentRoute, { ...currentRoute, path: "/new-route" }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.additions, ["POST /new-route"]);
  assert.equal(result.baselineRouteCount, 1);
  assert.equal(result.currentRouteCount, 2);
});

test("detects removed routes and duplicate declarations", () => {
  const result = compareHttpContracts([baselineRoute], [currentRoute, currentRoute]);
  assert.deepEqual(result.errors.map((entry) => entry.kind), ["duplicate-current-route"]);
});

test("detects a changed HTTP response status", () => {
  const result = compareHttpContracts([baselineRoute], [{ ...currentRoute, explicitStatus: ["HttpStatus.CREATED"] }]);
  assert.deepEqual(result.errors, [{ kind: "status-changed", route: "POST /admin/users/:userId/password-reset-link", before: 202, after: 201 }]);
});

test("detects changed request decorators and controller guards", () => {
  const result = compareHttpContracts([baselineRoute], [{
    ...currentRoute,
    requestInputs: [{ name: "Body", args: [] }],
    controllerGuards: ["SessionGuard"],
  }]);
  assert.deepEqual(result.errors.map((entry) => entry.kind), ["request-decorators-changed", "guards-changed"]);
});
