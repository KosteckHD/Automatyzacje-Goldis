"use strict";
// Audit harness, not an acceptance test: actual compiled control flow, synthetic
// SQL/crypto/file/engine adapters. No servers, database, credentials or network.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../../..");
const filename = path.join(root, "apps/api/dist/commission-worker.js");
const source = fs.readFileSync(filename, "utf8");
const realRequire = createRequire(filename);

async function reproduce(name) {
  const input = {
    tenant_id: "22222222-2222-4222-8222-222222222222",
    run_id: "11111111-1111-4111-8111-111111111111",
    owner_user_id: "33333333-3333-4333-8333-333333333333",
    dictionary_version_id: "44444444-4444-4444-8444-444444444444",
    active_attempt_token: "synthetic-attempt", snapshot_ciphertext: Buffer.from("synthetic"),
    start_date: "2026-06-01", end_date: "2026-09-30",
    files: [{ file_id: "fixture", source_type: "CRM", file_name: "synthetic.xlsx", storage_key: "fixture", sha256: "a".repeat(64) }],
  };
  const state = {
    runStatus: name === "terminal-replay" ? "completed" : "running",
    dispatchStatus: name === "terminal-replay" ? "completed" : "published",
    snapshotWritten: false, engineCalls: 0, successfulAudit: false,
    finalRunUpdateAffected: null, cancellationInjected: false,
  };
  const initial = { runStatus: state.runStatus, dispatchStatus: state.dispatchStatus };
  const database = {
    async transaction(callback) { return callback({ synthetic: true }); },
    async query(sql) {
      if (sql.includes("SELECT run.tenant_id")) {
        // Honour the actual readRunInput predicate; narrower SQL must fail the probe.
        assert.match(sql, /dispatch\.status IN \('published','completed'\)/);
        return [input];
      }
      if (sql.startsWith("SELECT status FROM commission_runs")) return [{ status: state.runStatus }];
      if (sql.includes("SET status='running'")) {
        assert.ok(!sql.includes("status='queued'"), "probe expects unguarded state transition");
        state.runStatus = "running";
        return [[], 1];
      }
      if (sql.includes("INSERT INTO commission_run_snapshots")) {
        if (name === "cancel-before-publication") {
          // A cancellation commits after the preceding status read, before publication.
          state.runStatus = "cancel_requested";
          state.cancellationInjected = true;
        }
        state.snapshotWritten = true;
        return [[], 1];
      }
      if (sql.includes("UPDATE commission_runs SET status=$4")) {
        state.finalRunUpdateAffected = state.runStatus === "running" ? 1 : 0;
        if (state.finalRunUpdateAffected) state.runStatus = "completed";
        return [[], state.finalRunUpdateAffected];
      }
      if (sql.includes("UPDATE commission_dispatches SET status='completed'")) {
        state.dispatchStatus = "completed";
        return [[], 1];
      }
      if (sql.includes("INSERT INTO audit_events")) {
        state.successfulAudit = true;
        return [[], 1];
      }
      throw Error("UNEXPECTED_SQL_IN_AUDIT_HARNESS");
    },
  };
  const result = {
    schema_version: 1, engine_version: "synthetic", request_id: "r1",
    execution_id: input.run_id, attempt_token: input.active_attempt_token,
    start: input.start_date, end: input.end_date, preset_version: "fixture",
    summary: Object.fromEntries(["policies", "missing_policies", "candidate_policies", "matched_policies", "wrong_rate_rows", "wrong_rate_policies", "checked_rate_rows", "unverified_rate_rows", "report_records", "duplicate_files"].map(key => [key, 0])),
    issues: [], unresolved: [], details: [], policies: [], warnings: [], assumptions: [],
    reverse_audit: { crm_policies_all_dates: 0, report_record_status_counts: {}, rows: [], note: "synthetic" },
  };
  const engine = { async execute() { state.engineCalls++; return result; }, async cancel() {} };
  const customRequire = id => {
    if (id === "./infrastructure/database/db") return { sequelize: database };
    if (id === "./infrastructure/database") return {};
    if (id === "./features/commissions/commission-engine-client") return { CommissionEngineClient: class {} };
    if (id === "./features/commissions/commission-file-store") return { readCommissionFile: async () => Buffer.from("synthetic") };
    if (id === "./features/results/public") return {
      decryptStoredArtifactBytes: () => ({ bytes: Buffer.from("{}") }),
      encryptArtifactBytes: (_id, bytes) => bytes,
    };
    return realRequire(id);
  };
  customRequire.main = undefined;
  const moduleObject = { exports: {} };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: customRequire,
    Buffer, process: { env: {} }, console,
    setInterval: () => 1, clearInterval: () => {}, setTimeout,
  });
  new vm.Script(source + "\nmodule.exports.auditProcessJob = processJob;", { filename }).runInContext(context, { timeout: 3000 });
  await moduleObject.exports.auditProcessJob({ data: { dispatchId: "synthetic-dispatch" } }, {}, engine);
  if (name === "terminal-replay") {
    assert.equal(state.engineCalls, 1);
    assert.equal(state.snapshotWritten, true);
  } else {
    assert.equal(state.finalRunUpdateAffected, 0);
    assert.equal(state.snapshotWritten, true);
    assert.equal(state.successfulAudit, true);
    assert.equal(state.dispatchStatus, "completed");
    assert.equal(state.runStatus, "cancel_requested");
  }
  return { scenario: name, initial, observed: state, evidenceLevel: "compiled worker control flow with synthetic SQL schedule; PostgreSQL/Redis not exercised", vulnerabilityObserved: true };
}

(async () => {
  const results = [];
  for (const name of ["terminal-replay", "cancel-before-publication"]) results.push(await reproduce(name));
  const report = {
    checkedAt: new Date().toISOString(), liveServicesUsed: false,
    compiledWorkerSha256: createHash("sha256").update(source).digest("hex"), results,
  };
  fs.writeFileSync(path.join(__dirname, "worker-state-reproductions.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
})().catch(error => { console.error(error); process.exitCode = 1; });
