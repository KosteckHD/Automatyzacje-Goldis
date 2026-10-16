import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PgRunRepository } from "./pg-run-repository";

for (const active of [true, false]) {
  test(`PZU login acceptance checkpoint ${active ? "pauses atomically" : "rejects a stale lease"}`, async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql.startsWith("UPDATE automation_runs")) {
          assert.match(sql, /status = 'pzu_login' AND execution_id = \$2/);
          assert.match(sql, /worker_session_id = \$3 AND lease_expires_at > \$4/);
          assert.match(sql, /control_state = 'paused'/);
          return { rowCount: active ? 1 : 0, rows: active ? [{ id: runId }] : [] };
        }
        return { rowCount: null, rows: [] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new PgRunRepository(pool, () => ({ runId,
      executionId: "223e4567-e89b-42d3-a456-426614174000", workerSessionId: "323e4567-e89b-42d3-a456-426614174000",
      dispatchId: "423e4567-e89b-42d3-a456-426614174000", intentType: "create", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
    assert.equal(await repository.confirmPzuLoginAndPause(runId), active);
    assert.equal(statements.some(sql => sql.includes("pzu_login_verified_test_paused")), active);
    assert.equal(statements.at(-1), active ? "COMMIT" : "ROLLBACK");
  });
}

test("worker loads the immutable admission snapshot instead of mutable source-row values", async () => {
  const sourceRowId = "123e4567-e89b-42d3-a456-426614174000";
  const snapshot = {
    schemaVersion: 1, sourceRowId, rowNumber: 7, rowVersion: 3,
    companyName: "Snapshot Company", decisionMakerName: "Snapshot Person", nipRaw: "526025027",
    address: "Snapshot Street 1", postalCode: "00-001", city: "Snapshot City", countyCode: null,
    regonRaw: "123456785", regon: "123456785", effectiveRegon: "123456785", issues: [],
  };
  let sql = "";
  const pool = {
    async query(query: string) {
      sql = query;
      return { rowCount: 1, rows: [{
        id: "323e4567-e89b-42d3-a456-426614174000", batch_id: "223e4567-e89b-42d3-a456-426614174000",
        source_row_id: sourceRowId, reference_date: "2026-10-08", tool_id: "oc-policy-verification",
        schema_version: 1, status: "awaiting_portal_adapter", error_code: null, input_snapshot: snapshot,
        decision_maker_name: snapshot.decisionMakerName, address: snapshot.address, postal_code: snapshot.postalCode,
        city: snapshot.city, county_code: null, identity_source_row_id: null, identity_regon: null,
        identity_company_name: null, first_name: null, last_name: null, pesel_ciphertext: null,
        pesel_key_version: null, match_method: null, adapter_version: null,
      }] };
    },
  } as unknown as Pool;
  const context = await new PgRunRepository(pool).load("323e4567-e89b-42d3-a456-426614174000");
  assert.ok(context);
  assert.match(sql, /r\.input_snapshot/);
  assert.match(sql, /r\.reference_date::text AS reference_date/);
  assert.equal(context.run.referenceDate, "2026-10-08");
  assert.doesNotMatch(sql, /s\.(company_name|effective_regon|issues)/);
  assert.equal(context.source.companyName, "Snapshot Company");
  assert.equal(context.source.address, "Snapshot Street 1");
  assert.equal(context.source.rowNumber, 7);
  assert.equal(context.source.effectiveRegon, "123456785");
});

test("worker acknowledges a run pause only with its live lease at a safe boundary", async () => {
  const runId = "323e4567-e89b-42d3-a456-426614174000";
  const executionId = "423e4567-e89b-42d3-a456-426614174000";
  const workerSessionId = "523e4567-e89b-42d3-a456-426614174000";
  const requestedBy = "623e4567-e89b-42d3-a456-426614174000";
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT status, control_state, control_revision")) return { rowCount: 1, rows: [{
        status: "compensa_form", control_state: "pause_requested", control_revision: "4",
        execution_id: executionId, worker_session_id: workerSessionId,
        lease_expires_at: new Date(Date.now() + 60_000), control_requested_by: requestedBy,
      }] };
      if (sql.includes("UPDATE automation_runs SET control_state = 'paused'")) return { rowCount: 1, rows: [{ control_revision: "4" }] };
      return { rowCount: null, rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const repository = new PgRunRepository(pool, () => ({ runId, dispatchId: "723e4567-e89b-42d3-a456-426614174000",
    executionId, workerSessionId, intentType: "recovery", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }));

  assert.equal(await repository.pauseAtSafeBoundary(runId), true);
  assert.ok(statements.some((sql) => sql.includes("control_ack_revision = control_revision")));
  assert.ok(statements.some((sql) => sql.includes("paused_at_safe_checkpoint")));
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
});
