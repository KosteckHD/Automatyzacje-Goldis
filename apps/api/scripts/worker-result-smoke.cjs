const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

/** Called only after migration of the runner's disposable database. Uses real HTTP and DB. */
module.exports = async function verifyWorkerResults() {
  const { Module } = require("@nestjs/common");
  const { NestFactory } = require("@nestjs/core");
  const models = require("../dist/db");
  const { WorkerResultController, WorkerResultGuard } = require("../dist/worker-results");
  const { persistOcSnapshot } = require("../dist/oc-snapshot-store");
  const { WorkerExecutionConflict } = require("../dist/worker-execution");
  const { getVerifiedArtifactDownload } = require("../dist/artifact-download");
  const root = await mkdtemp(join(tmpdir(), "goldis-worker-result-smoke-"));
  const overrides = {
    WORKER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": randomBytes(32).toString("base64") })).toString("base64"),
    API_EXPORT_DIR: root,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const identity = (sourceRowId) => ({ schemaVersion: 1, sourceRowId, regon: "012345678", companyName: "Synthetic Company",
    firstName: "Test", lastName: "Person", pesel: "90010100016", matchMethod: "unique_business_identity", adapterVersion: "fixture-v1" });
  const policy = (ordinal) => ({ sourceOrdinal: ordinal, insuredName: "Test Person", policyTypeAndNumber: `OC SYNTH-${ordinal}`,
    contractType: "OC", insuredClaimCount: 0, vehicleRegistration: "SYNTH001", vehicleGroup: "Synthetic", vehicleMake: "Synthetic",
    vehicleModel: "Synthetic", insurer: "Synthetic", coverageFrom: "2020-01-01", coverageTo: "2030-01-01" });
  const snapshot = (count = 1) => ({ schemaVersion: 1, totalCount: count, capturedAt: new Date().toISOString(), parserVersion: "fixture-v1",
    policies: Array.from({ length: count }, (_, index) => policy(index + 1)) });
  async function seeded(status = "reading_oc") {
    const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
    const admin = await models.User.findOne({ where: { usernameNormalized: "synthetic.bootstrap.admin" } });
    const now = new Date(); const batchId = randomUUID(); const sourceRowId = randomUUID(); const runId = randomUUID();
    await models.ImportBatch.create({ id: batchId, fileName: "synthetic.xlsx", sha256: "a".repeat(64), totalRows: 1, invalidRows: 0,
      createdAt: now, toolId: "oc-policy-verification", tenantId: tenant.tenantId, ownerUserId: admin.userId });
    await models.SourceRow.create({ id: sourceRowId, batchId, rowNumber: 1, companyName: "Synthetic Company", decisionMakerName: null,
      nipRaw: "", address: "Test 1", postalCode: "00-000", city: "Test City", regonRaw: "012345678", regon: "012345678", effectiveRegon: "012345678", issues: [] });
    await models.AutomationRun.create({ id: runId, batchId, sourceRowId, rowNumber: 1, toolId: "oc-policy-verification", status,
      currentStep: status, referenceDate: "2026-09-30", createdAt: now, updatedAt: now });
    const run = { runId, sourceRowId, batchId };
    const execution = { executionId: randomUUID(), workerSessionId: randomUUID() };
    await models.AutomationRun.update({ ...execution, leaseExpiresAt: new Date(Date.now() + 60_000) }, { where: { id: run.runId } });
    return { ...run, execution };
  }
  class WorkerResultSmokeModule {}
  Module({ controllers: [WorkerResultController], providers: [WorkerResultGuard] })(WorkerResultSmokeModule);
  let app;
  try {
    app = await NestFactory.create(WorkerResultSmokeModule, { logger: false });
    app.setGlobalPrefix("api"); await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    const post = (run, body, authenticated = true) => fetch(`${origin}/api/internal/worker-runs/${run.runId}/result`, {
      method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${overrides.WORKER_AUTH_SECRET}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const payload = (run) => ({ execution: run.execution, identity: identity(run.sourceRowId), snapshot: snapshot() });
    const normal = await seeded();
    assert.equal((await post(normal, payload(normal), false)).status, 403);
    const missingExecution = payload(normal); delete missingExecution.execution;
    assert.equal((await post(normal, missingExecution)).status, 400);
    assert.equal((await post(normal, payload(normal))).status, 200);
    assert.equal((await models.AutomationRun.findByPk(normal.runId)).status, "completed");
    assert.equal((await post(normal, payload(normal))).status, 200);
    assert.equal(await models.ExportArtifact.count({ where: { runId: normal.runId } }), 1);
    const artifact = await getVerifiedArtifactDownload(normal.runId);
    assert.ok(artifact.bytes.byteLength > 0);
    const ExcelJS = require("exceljs"); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(artifact.bytes);
    assert.ok(workbook.worksheets.some((sheet) => sheet.getSheetValues().flat(2).includes("90010100016")));
    for (const scenario of ["expired", "replaced", "cancelled"]) {
      const run = await seeded(scenario === "cancelled" ? "cancelled" : "reading_oc");
      await models.AutomationRun.update(scenario === "expired" ? { leaseExpiresAt: new Date(Date.now() - 1) }
        : scenario === "replaced" ? { executionId: randomUUID() } : {}, { where: { id: run.runId } });
      assert.equal((await post(run, payload(run))).status, 409);
      assert.equal(await models.RunIdentity.count({ where: { runId: run.runId } }), 0);
      assert.equal(await models.OcSnapshot.count({ where: { runId: run.runId } }), 0);
    }
    const interrupted = await seeded();
    await models.AutomationRun.update({ leaseExpiresAt: new Date(Date.now() + 1_000) }, { where: { id: interrupted.runId } });
    let hookCalled = false;
    await assert.rejects(persistOcSnapshot(interrupted.runId, identity(interrupted.sourceRowId), snapshot(60), {
      execution: interrupted.execution,
      afterPolicyChunk: async () => { hookCalled = true; await new Promise((resolve) => setTimeout(resolve, 1_100)); },
    }), WorkerExecutionConflict);
    assert.equal(hookCalled, true);
    assert.equal(await models.RunIdentity.count({ where: { runId: interrupted.runId } }), 0);
    assert.equal(await models.OcPolicyRecord.count({ where: { runId: interrupted.runId } }), 0);
    console.log("WORKER_RESULT_DB_HTTP_SMOKE_PASS guard=true stale=blocked expired=blocked cancelled=blocked midWrite=rollback xlsx=verified replay=one_artifact");
  } finally {
    if (app) await app.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
};
