import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStatus } from "@goldis/core";
import { LiveRunProcessor } from "./live-run";
import type { RunExecutionLease, DispatchIntent } from "./execution-lease";

const runId = "11111111-1111-4111-8111-111111111111";
const lease: RunExecutionLease = {
  runId, executionId: "22222222-2222-4222-8222-222222222222",
  workerSessionId: "33333333-3333-4333-8333-333333333333",
  dispatchId: "44444444-4444-4444-8444-444444444444",
  intentType: "resume_auth", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

/** Unit regression for the production state loop. Portal/DB integration is a separate gate. */
function fixture(initial: RunStatus) {
  let status = initial;
  let errorCode: string | null = "SMS_RETRY_QUEUED";
  let delivered = 0; let saved = 0; let resent = 0; let sms = 0; let searches = 0;
  const transitions: RunStatus[] = [];
  const identity = { sourceRowId: "55555555-5555-4555-8555-555555555555" };
  const session = {
    resendSmsCodeIfAvailable: async () => { resent++; return "resent"; },
    signIn: async () => "authenticated",
    reopenAfterSmsTimeout: async () => "authenticated",
  };
  const processor = Object.create(LiveRunProcessor.prototype) as LiveRunProcessor;
  Object.assign(processor, {
    currentLease: null, currentSignal: null, environment: {},
    repository: {
      load: async () => ({ status, errorCode, identity, source: { id: identity.sourceRowId }, cancelRequested: false }),
      clearErrorCode: async () => { errorCode = null; },
      saveIdentity: async () => undefined,
      transition: async (_id: string, expected: RunStatus, next: RunStatus) => {
        assert.equal(status, expected); status = next; transitions.push(next); return true;
      },
      pauseForReview: async () => { throw new Error("Unexpected intervention"); },
    },
    pzuSession: session, compensaSession: session,
    everest: { findIdentity: async () => {
      searches++;
      return searches === 1 ? { kind: "waiting_for_sms", portal: "pzu" } : { kind: "matched", identity };
    } },
    awaitSms: async () => { sms++; return true; },
    form: { prepareInsuredForm: async (_context: unknown, _identity: unknown, _signal: AbortSignal, requireExisting?: boolean) => {
      assert.notEqual(requireExisting, true, "a fresh case must open the main Compensa Komunikacja flow");
      return { kind: "ready_to_save" };
    } },
    saver: { saveInsuredData: async () => { saved++; return { kind: "saved" }; } },
    ufg: { readSnapshot: async () => ({ kind: "snapshot", snapshot: { policies: [] } }) },
    stagingCheckpoint: {
      commitSnapshot: async () => { status = "reading_oc"; return true; },
      clearAfterFinalization: async () => undefined,
    },
    dependencies: {
      pool: { query: async (sql: string) => {
        if (sql.includes("SELECT 1 FROM automation_runs")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("last_safe_step")) return { rowCount: 1, rows: [{ last_safe_step: null }] };
        if (sql.includes("external_case_ref")) return { rowCount: 1, rows: [{ external_case_ref: "SYNTH-CASE" }] };
        throw new Error("Unexpected SQL in state-loop regression");
      } },
      staging: { write: async () => ({ fileId: "fixture" }), remove: async () => undefined },
      resultForwarder: { store: async (_id: string, _identity: unknown, _snapshot: unknown, active: RunExecutionLease) => {
        assert.equal(active.executionId, lease.executionId); delivered++; status = "completed";
      } },
    },
  });
  return { processor, summary: () => ({ status, delivered, saved, resent, sms, searches, transitions }) };
}

for (const initial of ["pzu_login", "compensa_login"] as const) {
  test(`resume_auth from ${initial} continues through Compensa and UFG without recovery`, async () => {
    const state = fixture(initial);
    await state.processor.process(runId, { lease, signal: new AbortController().signal, intent: "resume_auth" });
    const result = state.summary();
    assert.equal(result.status, "completed"); assert.equal(result.delivered, 1); assert.equal(result.saved, 1); assert.equal(result.resent, initial === "pzu_login" ? 1 : 0);
    assert.ok(result.transitions.includes("compensa_form")); assert.ok(result.transitions.includes("ufg_verification"));
    assert.equal(result.sms, initial === "pzu_login" ? 1 : 0);
  });
}

for (const intent of ["resume_auth", "result_delivery"] as DispatchIntent[]) {
  test(`${intent} cannot enter an unrelated portal stage`, async () => {
    const state = fixture("compensa_form");
    await state.processor.process(runId, { lease, signal: new AbortController().signal, intent });
    assert.equal(state.summary().saved, 0); assert.equal(state.summary().delivered, 0);
  });
}
