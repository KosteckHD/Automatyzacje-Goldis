import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import type { RunExecutionLease } from "../../features/execution/execution-lease";
import { PgPortalActionGate } from "./portal-action-gate";

const runId = "11111111-1111-4111-8111-111111111111";
const sourceRowId = "22222222-2222-4222-8222-222222222222";
const lease: RunExecutionLease = {
  runId, executionId: "33333333-3333-4333-8333-333333333333",
  workerSessionId: "44444444-4444-4444-8444-444444444444",
  dispatchId: "55555555-5555-4555-8555-555555555555",
  intentType: "create", leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
};

for (const action of ["start", "ufg"] as const) {
  for (const loseAfterPrecheck of [false, true]) {
    test(`${action} intent is fenced inside the transaction (lease lost after precheck=${loseAfterPrecheck})`, async () => {
      const statements: string[] = [];
      let ownsLease = true;
      let checked = false;
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          if (sql.startsWith("SELECT status")) return { rowCount: 1, rows: [{
            status: action === "start" ? "compensa_login" : "ufg_verification",
            source_row_id: sourceRowId, last_safe_step: action === "start" ? null : "compensa_insured_data_saved",
            external_case_ref: "CASE/1",
          }] };
          if (sql.startsWith("SELECT id FROM automation_runs")) {
            assert.deepEqual(values, [runId, lease.executionId, lease.workerSessionId]);
            assert.match(sql, /lease_expires_at > clock_timestamp\(\)/);
            assert.match(sql, /FOR UPDATE/);
            checked = true;
            return { rowCount: ownsLease ? 1 : 0, rows: [] };
          }
          if (/^(UPDATE|INSERT)/.test(sql)) assert.equal(checked, true);
          return { rowCount: 1, rows: [] };
        }, release() {},
      };
      const gate = new PgPortalActionGate({ connect: async () => client } as unknown as Pool,
        async () => { assert.equal(ownsLease, true); ownsLease = !loseAfterPrecheck; }, () => lease);
      const execute = () => action === "start"
        ? gate.authorizeStart({ runId, sourceRowId, identitySourceRowId: sourceRowId, adapterVersion: "test-v1" })
        : gate.authorizeUfg({ runId, caseReference: "CASE/1", parserVersion: "test-v1" });
      if (loseAfterPrecheck) {
        await assert.rejects(execute, /RUN_EXECUTION_LEASE_LOST/);
        assert.equal(statements.some(sql => /^(UPDATE|INSERT)/.test(sql)), false);
        assert.equal(statements.at(-1), "ROLLBACK");
      } else {
        assert.equal(await execute(), true);
        assert.equal(statements.filter(sql => /^(UPDATE|INSERT)/.test(sql)).length, 2);
        assert.equal(statements.at(-1), "COMMIT");
      }
    });
  }
}
