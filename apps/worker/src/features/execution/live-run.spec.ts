import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStatus } from "@goldis/core";
import { LiveRunProcessor } from "./live-run";
import type { RunExecutionLease, DispatchIntent } from "./execution-lease";
import { OneTimeCodeInbox } from "../authentication/code-inbox";

const runId = "11111111-1111-4111-8111-111111111111";
const lease: RunExecutionLease = {
  runId, executionId: "22222222-2222-4222-8222-222222222222",
  workerSessionId: "33333333-3333-4333-8333-333333333333",
  dispatchId: "44444444-4444-4444-8444-444444444444",
  intentType: "resume_auth", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test("SMS wait automatically reconciles a portal that becomes authenticated without a submitted code", async () => {
  const state = fixture("pzu_login");
  const inbox = new OneTimeCodeInbox();
  const challengeId = "66666666-6666-4666-8666-666666666666";
  inbox.register(challengeId, new Date(Date.now() + 5000));
  let observations = 0; let reconciled = false;
  const client = { query: async (sql: string) => {
    if (sql.includes("SELECT id FROM automation_runs")) return { rowCount: 1, rows: [{ id: runId }] };
    if (sql.includes("SELECT return_step FROM auth_challenges")) return { rowCount: 1, rows: [{ return_step: "pzu_login" }] };
    if (sql.includes("portal_authenticated_without_code")) reconciled = true;
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const internals = state.processor as unknown as {
    dependencies: { pool: { connect: () => Promise<typeof client> }; inbox: OneTimeCodeInbox; browser: { sessionId: string } };
    waitForCodeOrAuthentication: (id: string, portal: "pzu") => Promise<Buffer | null>;
  };
  Object.assign(internals.dependencies, { inbox, browser: { sessionId: lease.workerSessionId } });
  internals.dependencies.pool.connect = async () => client;
  Object.assign(state.processor, { currentLease: lease, pzuSession: { ensureAuthenticated: async () => ++observations === 1 ? "waiting_for_sms" : "authenticated" } });
  try {
    assert.equal(await internals.waitForCodeOrAuthentication(challengeId, "pzu"), null);
    assert.equal(reconciled, true); assert.equal(observations, 2);
    assert.throws(() => inbox.submit(challengeId, "123456"));
  } finally { inbox.close(); }
});

test("SMS wait hands a submitted buffer to the portal without reconciling it as an independent login", async () => {
  const state = fixture("pzu_login"); const inbox = new OneTimeCodeInbox();
  const challengeId = "66666666-6666-4666-8666-666666666666";
  inbox.register(challengeId, new Date(Date.now() + 5000));
  inbox.submit(challengeId, "123456");
  const internals = state.processor as unknown as {
    dependencies: { inbox: OneTimeCodeInbox }; waitForCodeOrAuthentication: (id: string, portal: "pzu") => Promise<Buffer | null>;
  };
  internals.dependencies.inbox = inbox;
  Object.assign(state.processor, { currentLease: lease, pzuSession: { ensureAuthenticated: async () => { throw new Error("must not observe after an immediate handoff"); } } });
  try {
    const code = await internals.waitForCodeOrAuthentication(challengeId, "pzu");
    assert.ok(code); assert.equal(code.toString("ascii"), "123456"); code.fill(0);
  } finally { inbox.close(); }
});

test("a lost execution lease stops SMS observation and removes the pending code handoff", async () => {
  const state = fixture("pzu_login"); const inbox = new OneTimeCodeInbox();
  const challengeId = "66666666-6666-4666-8666-666666666666";
  inbox.register(challengeId, new Date(Date.now() + 5000));
  const internals = state.processor as unknown as {
    dependencies: { inbox: OneTimeCodeInbox }; waitForCodeOrAuthentication: (id: string, portal: "pzu") => Promise<Buffer | null>;
  };
  internals.dependencies.inbox = inbox;
  Object.assign(state.processor, { assertLease: async () => { throw new Error("RUN_EXECUTION_LEASE_LOST"); } });
  try {
    await assert.rejects(internals.waitForCodeOrAuthentication(challengeId, "pzu"), /RUN_EXECUTION_LEASE_LOST/);
    assert.throws(() => inbox.submit(challengeId, "123456"));
  } finally { inbox.close(); }
});

/** Unit regression for the production state loop. Portal/DB integration is a separate gate. */
function fixture(initial: RunStatus, safeStep: string | null = null) {
  let status = initial;
  let errorCode: string | null = "SMS_RETRY_QUEUED";
  let delivered = 0; let saved = 0; let resent = 0; let sms = 0; let searches = 0; let interventions = 0;
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
      pauseAtSafeBoundary: async () => false,
      load: async () => ({ status, errorCode, identity, source: { id: identity.sourceRowId }, cancelRequested: false }),
      clearErrorCode: async () => { errorCode = null; },
      saveIdentity: async () => undefined,
      transition: async (_id: string, expected: RunStatus, next: RunStatus, nextError?: string | null) => {
        assert.equal(status, expected); status = next; errorCode = nextError ?? null; transitions.push(next); return true;
      },
      pauseForReview: async (_id: string, expected: RunStatus, next: RunStatus, input: { reasonCode: string }) => {
        assert.equal(status, expected); status = next; errorCode = input.reasonCode; interventions += 1; return true;
      },
    },
    pzuSession: session, compensaSession: session,
    everest: { findIdentity: async () => {
      searches++;
      return searches === 1 ? { kind: "waiting_for_sms", portal: "pzu" } : { kind: "matched", identity };
    } },
    awaitSms: async () => { sms++; return true; },
    form: { prepareInsuredForm: async (_context: unknown, _identity: unknown, _signal: AbortSignal, requireExisting?: boolean) => {
      assert.equal(requireExisting === true, safeStep === "compensa_start_intent" || safeStep === "compensa_offer_draft_open",
        "a persisted start intent must only verify an existing case");
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
        if (sql.includes("last_safe_step")) return { rowCount: 1, rows: [{ last_safe_step: safeStep }] };
        if (sql.includes("external_case_ref")) return { rowCount: 1, rows: [{ external_case_ref: "SYNTH-CASE" }] };
        throw new Error("Unexpected SQL in state-loop regression");
      } },
      staging: { write: async () => ({ fileId: "fixture" }), remove: async () => undefined },
      resultForwarder: { store: async (_id: string, _identity: unknown, _snapshot: unknown, active: RunExecutionLease) => {
        assert.equal(active.executionId, lease.executionId); delivered++; status = "completed";
      } },
    },
  });
  return { processor, summary: () => ({ status, errorCode, delivered, saved, resent, sms, searches, interventions, transitions }) };
}

for (const [name, identityResult, errorCode] of [
  ["not found", { kind: "not_found" }, "IDENTITY_NOT_FOUND"],
  ["missing expected person", { kind: "identity_review", reason: "missing_expected_person", candidateCount: 0 }, "IDENTITY_EXPECTED_PERSON_MISSING"],
  ["missing PESEL", { kind: "identity_review", reason: "missing_pesel", candidateCount: 1 }, "IDENTITY_PESEL_MISSING"],
  ["invalid PESEL", { kind: "identity_review", reason: "invalid_pesel", candidateCount: 1 }, "IDENTITY_PESEL_INVALID"],
  ["unsupported type", { kind: "identity_review", reason: "unsupported_entity_type", candidateCount: 1 }, "IDENTITY_UNSUPPORTED_TYPE"],
] as const) {
  test(`live worker terminalizes ${name} without creating an intervention or a result`, async () => {
    const state = fixture("pzu_login");
    Object.assign(state.processor, { everest: { findIdentity: async () => identityResult } });
    await state.processor.process(runId, { lease, signal: new AbortController().signal, intent: "create" });
    const result = state.summary();
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.interventions, 0);
    assert.equal(result.saved, 0);
    assert.equal(result.delivered, 0);
    assert.ok(result.transitions.includes("failed"));
  });
}

test("live worker keeps a real identity ambiguity in operator review", async () => {
  const state = fixture("pzu_login");
  Object.assign(state.processor, { everest: { findIdentity: async () => ({ kind: "ambiguous", candidateCount: 2 }) } });
  await state.processor.process(runId, { lease, signal: new AbortController().signal, intent: "create" });
  assert.equal(state.summary().status, "identity_review");
  assert.equal(state.summary().errorCode, "IDENTITY_AMBIGUOUS");
  assert.equal(state.summary().interventions, 1);
});

for (const safeStep of ["compensa_start_intent", "compensa_offer_draft_open"]) {
  test(`resume_review przy ${safeStep} wymaga istniejącego formularza`, async () => {
    const state = fixture("compensa_login", safeStep);
    await state.processor.process(runId, { lease, signal: new AbortController().signal, intent: "resume_review" });
    assert.equal(state.summary().status, "completed");
    assert.equal(state.summary().saved, 1);
  });
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

test("scoped PZU login test hands SMS through the production waiter and pauses before identity search", async () => {
  const state = fixture("pzu_login");
  let loginAttempts = 0; let checkpoints = 0;
  const internals = state.processor as unknown as {
    environment: NodeJS.ProcessEnv;
    pzuSession: { signIn: () => Promise<string> };
    repository: { confirmPzuLoginAndPause: (id: string) => Promise<boolean> };
  };
  internals.environment.WORKER_PZU_LOGIN_TEST_RUN_ID = runId;
  internals.pzuSession.signIn = async () => ++loginAttempts === 1 ? "waiting_for_sms" : "authenticated";
  internals.repository.confirmPzuLoginAndPause = async id => { assert.equal(id, runId); checkpoints++; return true; };
  await state.processor.process(runId, { lease, signal: new AbortController().signal, intent: "create" });
  assert.equal(state.summary().sms, 1);
  assert.equal(checkpoints, 1);
  assert.equal(state.summary().searches, 0);
  assert.equal(state.summary().saved, 0);
  assert.equal(state.summary().delivered, 0);
});

test("scoped PZU login test cannot enter another run", async () => {
  const state = fixture("pzu_login");
  Object.assign(state.processor, { environment: { WORKER_PZU_LOGIN_TEST_RUN_ID: "66666666-6666-4666-8666-666666666666" } });
  await state.processor.process(runId, { lease, signal: new AbortController().signal, intent: "create" });
  assert.equal(state.summary().sms, 0);
  assert.equal(state.summary().searches, 0);
  assert.equal(state.summary().saved, 0);
});

for (const scenario of ["missing-save", "uncertain-save", "ufg-failure", "missing-details"] as const) {
  test(`Compensa ${scenario} terminates only this row without saving a result or retaining the lease`, async () => {
    const state = fixture(scenario.startsWith("ufg") || scenario === "missing-details" ? "ufg_verification" : "compensa_form");
    Object.assign(state.processor, scenario === "missing-save" ? {
      saver: { saveInsuredData: async () => ({ kind: "portal_error", errorCode: "PORTAL_SCHEMA_CHANGED" }) },
    } : scenario === "uncertain-save" ? {
      saver: { saveInsuredData: async () => ({ kind: "outcome_uncertain", errorCode: "OFFER_SAVE_UNCONFIRMED" }) },
    } : {
      ufg: { readSnapshot: async () => ({ kind: "portal_error", errorCode: "PORTAL_FAILURE" }) },
    });
    await state.processor.process(runId, { lease, signal: new AbortController().signal, intent: "recovery" });
    assert.equal(state.summary().status, "failed");
    assert.equal(state.summary().delivered, 0);
    assert.equal((state.processor as unknown as { currentLease: unknown }).currentLease, null);
    const next = fixture("compensa_form");
    await next.processor.process(runId, { lease, signal: new AbortController().signal, intent: "recovery" });
    assert.equal(next.summary().status, "completed", "a failed row does not require resolving an intervention before the next row");
  });
}
