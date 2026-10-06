import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createProductionRunProcessor } from "./run-worker";

test("produkcyjny worker waliduje i parkuje run; nie uruchamia pipeline ani adaptera portalu", async () => {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  let currentStatus = "queued";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes("SELECT r.status")) {
        return { rowCount: 1, rows: [{ status: currentStatus, issues: [], effective_regon: "012345678" }] };
      }
      if (sql.startsWith("UPDATE automation_runs SET status = $2")) currentStatus = String(values?.[1]);
      return { rowCount: null, rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;

  await createProductionRunProcessor(pool)({ data: { runId: "11111111-1111-4111-8111-111111111111" } });

  assert.equal(currentStatus, "awaiting_portal_adapter");
  assert.equal(statements.some(({ sql }) => sql.includes("s.effective_regon")), true);
  assert.equal(statements.some(({ sql, values }) => sql.includes("completed") || values?.includes("completed")), false);
  assert.equal(statements.some(({ sql }) => /everest|compensa|ufg|http/i.test(sql)), false);
  assert.equal(statements.filter(({ sql }) => sql.startsWith("INSERT INTO run_events")).length, 2);
});

test("worker nie uruchamia runu bez effective_regon nawet gdy źródłowy REGON istnieje", async () => {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  let currentStatus = "queued";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes("SELECT r.status")) {
        return { rowCount: 1, rows: [{ status: currentStatus, issues: [], effective_regon: null, regon: "012345678", regon_raw: "012345678" }] };
      }
      if (sql.startsWith("UPDATE automation_runs SET status = $2")) currentStatus = String(values?.[1]);
      return { rowCount: null, rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;

  await createProductionRunProcessor(pool)({ data: { runId: "11111111-1111-4111-8111-111111111111" } });

  assert.equal(currentStatus, "failed");
  assert.equal(statements.some(({ sql }) => sql.includes("s.effective_regon")), true);
});

test("worker odrzuca wadliwy identyfikator przed odczytem bazy", async () => {
  let connections = 0;
  const pool = { connect: async () => { connections += 1; throw new Error("UNEXPECTED_DB_ACCESS"); } } as unknown as Pool;
  await assert.rejects(createProductionRunProcessor(pool)({ data: { runId: "bad" } }), /RUN_ID_INVALID/);
  assert.equal(connections, 0);
});
