import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { PgCompensaOfferCheckpointStore } from "./compensa-offer-checkpoint";

const runId = "11111111-1111-4111-8111-111111111111";
const reference = "SYNTH-CASE-42";

function makePool(options: { failEventInsert?: boolean; status?: string; lastSafeStep?: string | null } = {}) {
  const state: { row: { status: string; last_safe_step: string | null; external_case_ref: string | null }; events: string[] } = {
    row: { status: options.status ?? "compensa_form", last_safe_step: options.lastSafeStep ?? null, external_case_ref: null }, events: [],
  };
  let workingRow: typeof state.row | null = null;
  let workingEvents: string[] = [];
  const execute = async (sql: string, values: readonly unknown[] = [], transaction = false) => {
    const row = transaction ? workingRow : state.row;
    if (sql.startsWith("SELECT status, last_safe_step, external_case_ref")) {
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    }
    if (sql.startsWith("UPDATE automation_runs SET external_case_ref")) {
      if (row) { row.external_case_ref = String(values[1]); row.last_safe_step = "compensa_offer_draft_open"; }
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    if (sql.startsWith("UPDATE automation_runs SET last_safe_step = 'compensa_insured_save_intent'")) {
      if (row) row.last_safe_step = "compensa_insured_save_intent";
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    if (sql.startsWith("UPDATE automation_runs SET last_safe_step = 'compensa_insured_save_intent', adapter_version")) {
      if (row) row.last_safe_step = "compensa_insured_save_intent";
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    if (sql.startsWith("UPDATE automation_runs SET last_safe_step = 'compensa_insured_save_confirmed_absent'")) {
      if (row) row.last_safe_step = "compensa_insured_save_confirmed_absent";
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    if (sql.startsWith("UPDATE automation_runs SET last_safe_step = 'compensa_insured_data_saved'")) {
      if (row) row.last_safe_step = "compensa_insured_data_saved";
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    if (sql.startsWith("INSERT INTO run_events")) {
      if (options.failEventInsert) throw new Error("SYNTHETIC_EVENT_WRITE_FAILED");
      (transaction ? workingEvents : state.events).push(String(values[2]));
      return { rowCount: 1, rows: [] };
    }
    throw new Error("UNEXPECTED_SQL");
  };
  const client = {
    query: async (sql: string, values?: readonly unknown[]) => {
      if (sql === "BEGIN") { workingRow = { ...state.row }; workingEvents = []; return { rowCount: null, rows: [] }; }
      if (sql === "COMMIT") {
        if (workingRow) state.row = workingRow;
        state.events.push(...workingEvents);
        workingRow = null; workingEvents = [];
        return { rowCount: null, rows: [] };
      }
      if (sql === "ROLLBACK") { workingRow = null; workingEvents = []; return { rowCount: null, rows: [] }; }
      return execute(sql, values, true);
    },
    release() {},
  };
  const pool = { query: (sql: string, values?: readonly unknown[]) => execute(sql, values), connect: async () => client };
  return { pool: pool as unknown as Pool, state };
}

test("Compensa Save checkpoint serializuje intent, referencję draftu i wynik bez zduplikowanych zdarzeń", async () => {
  const fake = makePool();
  const store = new PgCompensaOfferCheckpointStore(fake.pool, () => new Date("2026-09-30T10:00:00Z"));
  assert.deepEqual(await store.load(runId), { kind: "ready" });
  assert.equal(await store.recordDraftReference(runId, reference), true);
  assert.deepEqual(await store.load(runId), { kind: "ready" });
  assert.equal(await store.beginSave(runId, reference, "compensa-test-v1"), "started");
  assert.deepEqual(await store.load(runId), { kind: "save_intent", caseReference: reference });
  assert.equal(await store.beginSave(runId, reference, "compensa-test-v1"), "reconcile_required");
  assert.equal(await store.recordSaved(runId, reference), true);
  assert.deepEqual(await store.load(runId), { kind: "saved", caseReference: reference });
  assert.equal(await store.recordSaved(runId, reference), true, "powtórne potwierdzenie jest idempotentne");
  assert.equal(await store.beginSave(runId, reference, "compensa-test-v1"), "already_saved");
  assert.deepEqual(fake.state.events, [
    "compensa_offer_draft_open", "compensa_insured_save_intent", "compensa_insured_data_saved",
  ]);
});

test("przechwycenie numeru szkicu po start-intent jest trwałe przed uzupełnianiem i nie tworzy drugiego szkicu", async () => {
  const fake = makePool({ status: "compensa_login", lastSafeStep: "compensa_start_intent" });
  const store = new PgCompensaOfferCheckpointStore(fake.pool);
  assert.equal(await store.recordDraftReference(runId, reference), true);
  assert.equal(fake.state.row.last_safe_step, "compensa_offer_draft_open");
  assert.equal(fake.state.row.external_case_ref, reference);
  assert.equal(await store.recordDraftReference(runId, reference), true, "ponowny odczyt potwierdza tę samą sprawę");
  assert.equal(await store.recordDraftReference(runId, "SYNTH-OTHER"), false, "inna sprawa nie zastępuje szkicu runu");
  assert.equal(fake.state.events.filter((step) => step === "compensa_offer_draft_open").length, 1);
});

test("Compensa Save retry może ruszyć po intent dopiero po transakcyjnym potwierdzeniu braku zapisu", async () => {
  const fake = makePool();
  const store = new PgCompensaOfferCheckpointStore(fake.pool);
  await store.recordDraftReference(runId, reference);
  await store.beginSave(runId, reference, "compensa-test-v1");
  assert.equal(await store.confirmSaveAbsent(runId, "SYNTH-OTHER"), false);
  assert.equal(await store.confirmSaveAbsent(runId, reference), true);
  assert.deepEqual(await store.load(runId), { kind: "save_confirmed_absent", caseReference: reference });
  assert.equal(await store.beginSave(runId, reference, "compensa-test-v1"), "started");
});

test("Compensa checkpoint atomically rolls back intent when audit event persistence fails", async () => {
  const fake = makePool({ failEventInsert: true });
  const store = new PgCompensaOfferCheckpointStore(fake.pool);
  await assert.rejects(store.recordDraftReference(runId, reference), /SYNTHETIC_EVENT_WRITE_FAILED/);
  assert.equal(fake.state.row.external_case_ref, null);
  assert.equal(fake.state.row.last_safe_step, null);
  assert.deepEqual(fake.state.events, []);
});

test("Compensa checkpoint rejects malformed case references", async () => {
  const fake = makePool();
  const store = new PgCompensaOfferCheckpointStore(fake.pool);
  await assert.rejects(store.recordDraftReference(runId, "synthetic\nPII"), /COMPENSA_OFFER_CASE_REFERENCE_INVALID/);
});
