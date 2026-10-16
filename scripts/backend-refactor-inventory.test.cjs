"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { report } = require("./backend-refactor-inventory.cjs");
const importEffects = require("./backend-refactor-import-effects.cjs").report;

test("backend inventory assigns every source and test file and proposes unique destinations", () => {
  assert.equal(report.evidence.unresolvedOwners.length, 0);
  assert.deepEqual(report.evidence.duplicateProposedPaths, []);
  assert.deepEqual(report.evidence.unresolvedRelativeImports, []);
  assert.ok(report.files.length > 300);
  const testFiles = report.files.filter((file) => file.kind === "test");
  assert.ok(testFiles.length >= 100);
  for (const file of testFiles) {
    assert.ok(file.owner);
    assert.ok(file.proposedPath);
    assert.ok(Array.isArray(file.covers));
    assert.ok(file.coverageConfidence);
  }
  const sourceFiles = new Set(report.files.map((file) => file.path));
  for (const file of report.files) {
    assert.ok(Array.isArray(file.resolvedInternalImports));
    for (const edge of file.resolvedInternalImports) assert.ok(sourceFiles.has(edge.target));
  }
  assert.ok(report.dependencyGraph.nodes.length > 0);
  for (const edge of report.dependencyGraph.edges) {
    assert.ok(report.dependencyGraph.nodes.includes(edge.from));
    assert.ok(report.dependencyGraph.nodes.includes(edge.to));
    assert.ok(edge.imports.length > 0);
  }
});

test("inventory preserves HTTP test names and records the Health feature owner", () => {
  const httpTest = report.files.find((file) => file.path === "apps/api/src/features/interventions/auth-challenges.http.spec.ts");
  assert.equal(httpTest.proposedPath, httpTest.path);
  assert.ok(httpTest.covers.includes("apps/api/src/features/interventions/auth-challenge.controller.ts"));
  const healthModule = report.files.find((file) => file.path === "apps/api/src/features/health/health.module.ts");
  assert.equal(healthModule.owner, "health");
  assert.equal(healthModule.proposedPath, healthModule.path);
  const authModule = report.files.find((file) => file.path === "apps/api/src/features/auth/auth.module.ts");
  assert.equal(authModule.owner, "auth");
  assert.equal(authModule.proposedPath, authModule.path);
  const teamsHttpSpec = report.files.find((file) => file.path === "apps/api/src/features/teams/team.http.spec.ts");
  assert.equal(teamsHttpSpec.owner, "teams");
  assert.equal(teamsHttpSpec.proposedPath, teamsHttpSpec.path);
});

test("process and durable-job map covers every production backend entrypoint", () => {
  const expectedProcesses = ["api", "migrator", "runtime-grants", "bootstrap-admin", "import-parser",
    "import-parser-child", "enrichment-worker", "portal-worker"];
  assert.deepEqual(report.processes.map((process) => process.id), expectedProcesses);
  assert.deepEqual(report.evidence.missingProcessEvidenceFiles, []);
  assert.deepEqual(report.evidence.missingBackgroundEvidenceFiles, []);
  for (const process of report.processes) {
    assert.ok(process.entrypoint);
    assert.ok(process.references.length > 0);
    assert.match(process.verification, /source-reviewed/);
  }
  const jobs = new Map(report.backgroundJobs.map((job) => [job.id, job]));
  assert.equal(jobs.size, report.backgroundJobs.length);
  for (const id of ["run-dispatch-and-recovery", "submission-dispatch", "import-preparation",
    "preparation-workflow", "prepared-set-execution", "deletion-jobs", "enrichment-jobs",
    "auth-mail-outbox", "portal-worker-heartbeats"]) {
    assert.ok(jobs.has(id), `missing background worker inventory: ${id}`);
  }
  const runQueue = jobs.get("run-dispatch-and-recovery").queue;
  assert.equal(runQueue.name, "oc-verification");
  assert.equal(runQueue.jobName, "verify-row");
  assert.deepEqual(Object.keys(runQueue.payload), ["runId"]);
  assert.equal(runQueue.payloadVersion, "unversioned");
  assert.equal(runQueue.attempts, 1);
  assert.equal(runQueue.workerConcurrency, 1);
  assert.equal(runQueue.maxStalledCount, 1);
  assert.equal(jobs.get("run-dispatch-and-recovery").retry.includes("5s/15s/60s"), true);
  assert.equal(jobs.get("deletion-jobs").maxAttempts, 5);
  assert.match(jobs.get("deletion-jobs").retry, /manual_required/);
  assert.equal(jobs.get("enrichment-jobs").itemLeaseMs, 60000);
  assert.equal(jobs.get("auth-mail-outbox").maxAttempts, 8);
  assert.equal(jobs.get("deletion-jobs").disableEnvironment, "GOLDIS_DELETION_WORKER=0");
});

test("route inventory records custom permission requirements and transport decorators", () => {
  const cancelRun = report.routes.find((route) => route.method === "POST" && route.path === "/runs/:id/cancel");
  assert.deepEqual(cancelRun.permissionRequirements, [{ action: "run:cancel", resource: "route-run" }]);
  const login = report.routes.find((route) => route.method === "POST" && route.path === "/auth/login");
  assert.ok(login.routeDecorators.some((decorator) => decorator.name === "OriginOnly"));
  assert.equal(login.transportContractCandidates.responseCookieWrite, true);
  assert.equal(login.transportContractCandidates.originOnlyDecorator, true);
  const logout = report.routes.find((route) => route.method === "POST" && route.path === "/auth/logout");
  assert.equal(logout.transportContractCandidates.responseCookieWrite, true);
  const internalResult = report.routes.find((route) => route.path === "/internal/worker-runs/:id/result");
  assert.ok(internalResult.controllerGuards.includes("WorkerResultGuard"));
  const healthReady = report.routes.find((route) => route.path === "/health/ready");
  assert.ok(healthReady.requestInputs.some((input) => input.name === "Res"));
  assert.equal(healthReady.transportContractCandidates.responseMode, "manual response object");
  assert.equal(healthReady.transportContractCandidates.manualStatusWrite, true);
});

test("manual route review covers every route without SessionGuard and points to current source/tests", () => {
  const reviewPath = path.join(__dirname, "..", "docs", "backend-refactor", "route-contract-review.json");
  const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  assert.equal(review.schemaVersion, 1);
  assert.equal(review.reviewedAt, "2026-10-16");

  const unguarded = report.routes.filter((route) =>
    ![...route.controllerGuards, ...route.methodGuards].includes("SessionGuard"));
  const entries = new Map(review.entries.map((entry) => [`${entry.method} ${entry.path}`, entry]));
  assert.equal(entries.size, review.entries.length, "route review keys must be unique");
  assert.deepEqual([...entries.keys()].sort(), unguarded.map((route) => `${route.method} ${route.path}`).sort());

  for (const route of unguarded) {
    const entry = entries.get(`${route.method} ${route.path}`);
    assert.equal(entry.controller, route.controller);
    assert.equal(entry.handler, route.handler);
    assert.ok(entry.authorization && entry.request && entry.response && entry.cookiesHeaders);
    assert.ok(entry.testGap, "review must make test coverage gaps explicit");
    assert.ok(["source-reviewed", "source-and-http-tested"].includes(entry.reviewStatus));
    for (const evidencePath of [...entry.sourceEvidence, ...entry.testEvidence]) {
      assert.ok(fs.existsSync(path.join(__dirname, "..", evidencePath)), `missing evidence: ${evidencePath}`);
    }
  }

  const protectedReviews = review.protectedRouteReviews.flatMap((group) => {
    assert.ok(group.authorizationBoundary && group.dataScope && group.transport && group.testGap);
    assert.ok(["source-reviewed", "source-and-http-tested"].includes(group.reviewStatus));
    for (const evidencePath of group.sourceEvidence) {
      assert.ok(fs.existsSync(path.join(__dirname, "..", evidencePath)), `missing source evidence: ${evidencePath}`);
    }
    for (const evidencePath of group.testEvidence) {
      assert.ok(fs.existsSync(path.join(__dirname, "..", evidencePath)), `missing test evidence: ${evidencePath}`);
    }
    return group.routes;
  });
  const protectedKeys = protectedReviews.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(protectedKeys).size, protectedKeys.length, "protected route review keys must be unique");
  assert.equal(protectedReviews.length, 118);
  for (const reviewed of protectedReviews) {
    const route = report.routes.find((candidate) => candidate.method === reviewed.method && candidate.path === reviewed.path);
    assert.ok(route, `missing reviewed route: ${reviewed.method} ${reviewed.path}`);
    assert.equal(route.handler, reviewed.handler);
    assert.ok([...route.controllerGuards, ...route.methodGuards].includes("SessionGuard"));
    assert.ok(reviewed.input && reviewed.response && Number.isInteger(reviewed.status));
  }
});

test("top-level import-effect candidates are reviewed and isolated to direct process startup", () => {
  assert.equal(importEffects.evidence.runtimeSourceFilesScanned, report.files.filter((file) => file.kind === "source").length);
  assert.equal(importEffects.evidence.unguardedCandidateCount, 0);
  assert.deepEqual(importEffects.evidence.unreviewedCandidateFiles, []);
  assert.deepEqual(importEffects.evidence.staleReviewFiles, []);
  assert.equal(importEffects.evidence.candidateCount, 0);
  const candidateArtifactPath = path.join(__dirname, "..", "docs", "backend-refactor", "import-side-effect-candidates.json");
  const candidateArtifact = JSON.parse(fs.readFileSync(candidateArtifactPath, "utf8"));
  assert.deepEqual(candidateArtifact.evidence, importEffects.evidence);
  assert.deepEqual(candidateArtifact.candidates, importEffects.candidates);
  for (const candidate of importEffects.candidates) {
    assert.equal(candidate.review.reviewStatus, "source-reviewed");
    assert.ok(candidate.review.disposition);
    assert.ok(candidate.findings.every((finding) => finding.entrypointGuarded));
  }
});
