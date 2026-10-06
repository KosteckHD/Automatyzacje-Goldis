import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { AuthChallengeError, createAuthChallenge, fingerprintPortalAccount, invalidateStaleAuthChallenges, pauseExpiredAuthChallenge, recordAuthChallengeOutcome, type AuthChallengeInput } from "./auth-challenges";

const initial: AuthChallengeInput = {
  runId: "11111111-1111-4111-8111-111111111111",
  portal: "pzu",
  accountKey: "a".repeat(64),
  browserSessionId: "22222222-2222-4222-8222-222222222222",
  returnStep: "pzu_login",
  now: new Date("2026-09-30T10:00:00.000Z"),
  expiresAt: new Date("2026-09-30T10:05:00.000Z"),
};

function makePool(options: { initialStatus?: string; rejectRunUpdate?: boolean; existing?: Record<string, unknown>; previousAttempts?: number } = {}) {
  let status = options.initialStatus ?? "pzu_login";
  let challenge: Record<string, unknown> | null = options.existing ?? null;
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT status, current_auth_challenge_id FROM automation_runs")) {
        return { rowCount: 1, rows: [{ status, current_auth_challenge_id: challenge?.challenge_id ?? null }] };
      }
      if (sql.startsWith("SELECT status FROM automation_runs")) {
        return { rowCount: 1, rows: [{ status }] };
      }
      if (sql.startsWith("SELECT COALESCE(MAX(attempt_count)")) {
        return { rowCount: 1, rows: [{ attempt_count: options.previousAttempts ?? 0 }] };
      }
      if (sql.startsWith("UPDATE auth_challenges")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT challenge_id, run_id, browser_session_id") && sql.includes("WHERE challenge_id = $1")) {
        return { rowCount: challenge ? 1 : 0, rows: challenge ? [{ ...challenge }] : [] };
      }
      if (sql.startsWith("SELECT challenge_id, run_id")) {
        const active = challenge && ["active", "claimed", "submitted"].includes(String(challenge.status))
          && challenge.account_key === values?.[0] && challenge.portal === values?.[1]
          ? [{ ...challenge }]
          : [];
        return { rowCount: active.length, rows: active };
      }
      if (sql.startsWith("INSERT INTO auth_challenges")) {
        challenge = {
          challenge_id: values?.[0], run_id: values?.[1], portal: values?.[2], account_key: values?.[3],
          browser_session_id: values?.[4], return_step: values?.[5], status: "active", attempt_count: values?.[6],
          attempt_limit: values?.[7], expires_at: values?.[8], mfa_cycle_id: values?.[10],
        };
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE automation_runs SET status")) {
        if (options.rejectRunUpdate || status !== values?.[1]) return { rowCount: 0, rows: [] };
        status = "waiting_for_sms";
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, state: () => ({ status, challenge }) };
}

function makeOutcomePool(options: { attemptCount?: number; attemptLimit?: number; challengeStatus?: string; runStatus?: string } = {}) {
  const challengeId = "33333333-3333-4333-8333-333333333333";
  const state = {
    challengeStatus: options.challengeStatus ?? "submitted",
    runStatus: options.runStatus ?? "waiting_for_sms",
    currentChallengeId: challengeId as string | null,
    interventionStatus: "open",
    interventionReason: null as string | null,
    errorCode: null as string | null,
  };
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT run_id FROM auth_challenges")) {
        return { rowCount: 1, rows: [{ run_id: initial.runId }] };
      }
      if (sql.startsWith("SELECT status, current_auth_challenge_id FROM automation_runs")) {
        return { rowCount: 1, rows: [{ status: state.runStatus, current_auth_challenge_id: state.currentChallengeId }] };
      }
      if (sql.startsWith("SELECT run_id, portal, return_step")) {
        return {
          rowCount: 1,
          rows: [{ run_id: initial.runId, portal: "pzu", return_step: "pzu_login", status: state.challengeStatus,
            attempt_count: options.attemptCount ?? 1, attempt_limit: options.attemptLimit ?? 5 }],
        };
      }
      if (sql.startsWith("UPDATE auth_challenges SET status = 'consumed'")) {
        state.challengeStatus = "consumed";
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE manual_interventions SET status = 'resolved'")) {
        state.interventionStatus = "resolved";
        state.interventionReason = String(values?.[1] ?? "");
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE manual_interventions SET reason_code")) {
        state.interventionReason = String(values?.[1] ?? "");
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE automation_runs SET status")) {
        state.runStatus = String(values?.[1] ?? "");
        state.errorCode = values?.[2] ? String(values[2]) : null;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, state };
}

test("odcisk konta zależy od klucza i portalu; nie zwraca loginu", () => {
  const first = fingerprintPortalAccount("pzu", "synthetic-user", "k".repeat(32));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, "synthetic-user");
  assert.notEqual(first, fingerprintPortalAccount("compensa", "synthetic-user", "k".repeat(32)));
  assert.notEqual(first, fingerprintPortalAccount("pzu", "synthetic-user", "z".repeat(32)));
  assert.throws(() => fingerprintPortalAccount("pzu", "synthetic-user", "short"), /AUTH_CHALLENGE_INPUT_INVALID/);
});

test("worker zapisuje jedno wyzwanie i interwencję atomowo, a retry zwraca to samo wyzwanie", async () => {
  const fake = makePool();
  const created = await createAuthChallenge(fake.pool, initial);
  const retried = await createAuthChallenge(fake.pool, initial);

  assert.equal(created.challengeId, retried.challengeId);
  assert.equal(created.attemptCount, 0);
  assert.equal(created.attemptLimit, 5);
  assert.equal(created.portal, "pzu");
  assert.equal("accountKey" in created, false);
  assert.equal(fake.state().status, "waiting_for_sms");
  assert.equal(fake.statements.filter(({ sql }) => sql.startsWith("INSERT INTO auth_challenges")).length, 1);
  assert.equal(fake.statements.filter(({ sql }) => sql.startsWith("INSERT INTO manual_interventions")).length, 1);
  assert.equal(fake.statements.filter(({ sql }) => sql.startsWith("INSERT INTO run_events")).length, 1);
  assert.equal(fake.statements.filter(({ sql }) => sql === "COMMIT").length, 2);
  assert.equal(fake.statements.some(({ values }) => values?.includes("synthetic-user") || values?.some((value) => typeof value === "string" && /\b\d{6}\b/.test(value))), false);
});

test("licznik prób jest przenoszony między wyzwaniami tego samego runu i blokuje limit", async () => {
  const retriedAfterRejection = makePool({ previousAttempts: 2 });
  const nextChallenge = await createAuthChallenge(retriedAfterRejection.pool, initial);
  assert.equal(nextChallenge.attemptCount, 2);
  const insert = retriedAfterRejection.statements.find(({ sql }) => sql.startsWith("INSERT INTO auth_challenges"));
  assert.equal(insert?.values?.[6], 2);

  const atLimit = makePool({ previousAttempts: 5 });
  await assert.rejects(createAuthChallenge(atLimit.pool, initial), (error: unknown) =>
    error instanceof AuthChallengeError && error.code === "AUTH_CHALLENGE_ATTEMPT_LIMIT");
  assert.equal(atLimit.statements.some(({ sql }) => sql.startsWith("INSERT INTO auth_challenges")), false);
  assert.equal(atLimit.statements.at(-1)?.sql, "ROLLBACK");
});

test("odpowiedź portalu zużywa challenge; błędny kod wznawia login aż do limitu", async () => {
  const accepted = makeOutcomePool();
  const acceptedResult = await recordAuthChallengeOutcome(accepted.pool, "33333333-3333-4333-8333-333333333333", "accepted", initial.now);
  assert.equal(acceptedResult.outcome, "accepted");
  assert.equal(accepted.state.challengeStatus, "consumed");
  assert.equal(accepted.state.interventionStatus, "resolved");
  assert.equal(accepted.state.interventionReason, "SMS_CODE_ACCEPTED");
  assert.equal(accepted.state.runStatus, "pzu_login");

  const rejected = makeOutcomePool({ attemptCount: 2 });
  const rejectedResult = await recordAuthChallengeOutcome(rejected.pool, "33333333-3333-4333-8333-333333333333", "rejected", initial.now);
  assert.equal(rejectedResult.outcome, "rejected");
  assert.equal(rejected.state.runStatus, "pzu_login");
  assert.equal(rejected.state.interventionReason, "SMS_CODE_REJECTED");
  assert.equal(rejected.statements.some(({ sql, values }) => sql.startsWith("INSERT INTO run_events")
    && values?.[3] === "sms_code_rejected"), true);

  const exhausted = makeOutcomePool({ attemptCount: 5, attemptLimit: 5 });
  const exhaustedResult = await recordAuthChallengeOutcome(exhausted.pool, "33333333-3333-4333-8333-333333333333", "rejected", initial.now);
  assert.equal(exhaustedResult.outcome, "attempt_limit_reached");
  assert.equal(exhausted.state.runStatus, "waiting_for_manual_data");
  assert.equal(exhausted.state.errorCode, "SMS_ATTEMPT_LIMIT");
  assert.equal(exhausted.statements.some(({ sql, values }) => sql.startsWith("INSERT INTO run_events")
    && values?.[3] === "sms_attempt_limit"), true);

  const expired = makeOutcomePool();
  const expiredResult = await recordAuthChallengeOutcome(expired.pool, "33333333-3333-4333-8333-333333333333", "expired", initial.now);
  assert.equal(expiredResult.outcome, "expired");
  assert.equal(expired.state.runStatus, "waiting_for_manual_data");
  assert.equal(expired.state.errorCode, "SMS_RETRY_REQUIRED");
  assert.equal(expired.state.interventionStatus, "open");
  assert.equal(expired.state.interventionReason, "SMS_TIMEOUT");
  assert.equal(expired.statements.some(({ sql, values }) => sql.startsWith("INSERT INTO run_events")
    && values?.[3] === "sms_code_expired"), true);
  assert.equal(JSON.stringify([...accepted.statements, ...rejected.statements, ...exhausted.statements]).includes("407219"), false);
});

test("worker odrzuca ponowne zamknięcie challenge lub outcome przy innym stanie runu", async () => {
  const alreadyConsumed = makeOutcomePool({ challengeStatus: "consumed" });
  await assert.rejects(recordAuthChallengeOutcome(alreadyConsumed.pool, "33333333-3333-4333-8333-333333333333", "accepted", initial.now),
    (error: unknown) => error instanceof AuthChallengeError && error.code === "RUN_STATE_CONFLICT");
  const wrongRunState = makeOutcomePool({ runStatus: "cancelled" });
  await assert.rejects(recordAuthChallengeOutcome(wrongRunState.pool, "33333333-3333-4333-8333-333333333333", "accepted", initial.now),
    (error: unknown) => error instanceof AuthChallengeError && error.code === "RUN_STATE_CONFLICT");
});

test("drugie run nie może utworzyć aktywnego wyzwania dla tego samego konta i portalu", async () => {
  const existing = {
    challenge_id: "33333333-3333-4333-8333-333333333333",
    run_id: initial.runId,
    portal: "pzu",
    status: "active",
    account_key: initial.accountKey,
    browser_session_id: initial.browserSessionId,
    return_step: "pzu_login",
    expires_at: initial.expiresAt,
    attempt_count: 0,
    attempt_limit: 5,
  };
  const fake = makePool({ existing });
  await assert.rejects(createAuthChallenge(fake.pool, {
    ...initial,
    runId: "44444444-4444-4444-8444-444444444444",
  }), (error: unknown) => error instanceof AuthChallengeError && error.code === "AUTH_CHALLENGE_ALREADY_ACTIVE");
  assert.equal(fake.statements.some(({ sql }) => sql.startsWith("INSERT INTO auth_challenges")), false);
  assert.equal(fake.statements.at(-1)?.sql, "ROLLBACK");
});

test("worker wycofuje challenge i interwencję, gdy nie uda się checkpoint statusu runu", async () => {
  const fake = makePool({ rejectRunUpdate: true });
  await assert.rejects(createAuthChallenge(fake.pool, initial), (error: unknown) =>
    error instanceof AuthChallengeError && error.code === "RUN_STATE_CONFLICT");
  assert.equal(fake.statements.at(-1)?.sql, "ROLLBACK");
});

test("worker odrzuca błędny identyfikator sesji lub portalowy krok zanim połączy się z DB", async () => {
  let connections = 0;
  const pool = { connect: async () => { connections += 1; throw new Error("UNEXPECTED_DB_ACCESS"); } } as unknown as Pool;
  await assert.rejects(createAuthChallenge(pool, { ...initial, browserSessionId: "not-a-uuid" }), /AUTH_CHALLENGE_INPUT_INVALID/);
  await assert.rejects(createAuthChallenge(pool, { ...initial, portal: "compensa", returnStep: "pzu_login" }), /AUTH_CHALLENGE_INPUT_INVALID/);
  assert.equal(connections, 0);
});

test("restart unieważnia stare wyzwanie i wznawia run na zapamiętanym kroku portalu", async () => {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const challengeId = "77777777-7777-4777-8777-777777777777";
  const runId = "88888888-8888-4888-8888-888888888888";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT challenge_id, run_id FROM auth_challenges")) {
        return { rowCount: 1, rows: [{ challenge_id: challengeId, run_id: runId }] };
      }
      if (sql.startsWith("SELECT status, current_auth_challenge_id FROM automation_runs")) {
        return { rowCount: 1, rows: [{ status: "waiting_for_sms", current_auth_challenge_id: challengeId }] };
      }
      if (sql.startsWith("SELECT challenge_id, run_id, portal, return_step")) {
        return {
          rowCount: 1,
          rows: [{ challenge_id: challengeId, run_id: runId, portal: "compensa", return_step: "compensa_login", expires_at: "2026-09-30T10:05:00.000Z", browser_session_id: "22222222-2222-4222-8222-222222222222", status: "active" }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const now = new Date("2026-09-30T10:01:00.000Z");
  const reconciled = await invalidateStaleAuthChallenges(pool, "99999999-9999-4999-8999-999999999999", now);

  assert.deepEqual(reconciled, [{ runId, portal: "compensa", returnStep: "compensa_login", reason: "worker_restarted" }]);
  assert.deepEqual(statements.find(({ sql }) => sql.startsWith("UPDATE auth_challenges"))?.values?.slice(0, 2), [challengeId, "invalidated"]);
  assert.deepEqual(statements.find(({ sql }) => sql.startsWith("UPDATE automation_runs"))?.values?.slice(0, 2), [runId, "compensa_login"]);
  assert.equal(statements.some(({ sql }) => sql.startsWith("INSERT INTO run_events")), true);
  assert.equal(statements.at(-1)?.sql, "COMMIT");
});

test("wygaśnięte wyzwanie zostawia otwarte zgłoszenie i wstrzymuje zadanie", async () => {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT challenge_id, run_id FROM auth_challenges")) {
        return { rowCount: 1, rows: [{ challenge_id: "77777777-7777-4777-8777-777777777777", run_id: initial.runId }] };
      }
      if (sql.startsWith("SELECT status, current_auth_challenge_id FROM automation_runs")) {
        return { rowCount: 1, rows: [{ status: "waiting_for_sms", current_auth_challenge_id: "77777777-7777-4777-8777-777777777777" }] };
      }
      if (sql.startsWith("SELECT challenge_id, run_id, portal, return_step")) {
        return {
          rowCount: 1,
          rows: [{ challenge_id: "77777777-7777-4777-8777-777777777777", run_id: initial.runId, portal: "pzu", return_step: "pzu_login", expires_at: "2026-09-30T09:59:00.000Z", browser_session_id: initial.browserSessionId, status: "active" }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const result = await invalidateStaleAuthChallenges(pool, initial.browserSessionId, initial.now);
  assert.equal(result[0].reason, "challenge_expired");
  assert.deepEqual(statements.find(({ sql }) => sql.startsWith("UPDATE auth_challenges"))?.values?.slice(0, 2), ["77777777-7777-4777-8777-777777777777", "expired"]);
  assert.equal(statements.some(({ sql, values }) => sql.startsWith("UPDATE manual_interventions") && sql.includes("SMS_TIMEOUT") && values?.[0] === "77777777-7777-4777-8777-777777777777"), true);
  assert.deepEqual(statements.find(({ sql }) => sql.startsWith("UPDATE automation_runs"))?.values?.slice(0, 2), [initial.runId, "waiting_for_manual_data"]);
});

test("timeout bez wysłanego SMS tworzy pauzę tylko raz i nie ponawia kodu", async () => {
  const challengeId = "77777777-7777-4777-8777-777777777777";
  const now = new Date("2026-09-30T10:06:00.000Z");
  const statements: string[] = [];
  let challengeStatus = "active";
  let runStatus = "waiting_for_sms";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (sql.startsWith("SELECT run_id FROM auth_challenges")) return { rowCount: 1, rows: [{ run_id: initial.runId }] };
      if (sql.startsWith("SELECT status, current_auth_challenge_id FROM automation_runs")) return {
        rowCount: 1, rows: [{ status: runStatus, current_auth_challenge_id: challengeId }],
      };
      if (sql.startsWith("SELECT run_id, portal, status, expires_at")) return {
        rowCount: 1, rows: [{ run_id: initial.runId, portal: "pzu", status: challengeStatus, expires_at: initial.expiresAt }],
      };
      if (sql.startsWith("UPDATE auth_challenges")) challengeStatus = "expired";
      if (sql.startsWith("UPDATE automation_runs")) runStatus = "waiting_for_manual_data";
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  assert.equal(await pauseExpiredAuthChallenge(pool, challengeId, now), true);
  assert.equal(runStatus, "waiting_for_manual_data");
  assert.equal(statements.some((sql) => sql.includes("reason_code = 'SMS_TIMEOUT'")), true);
  const eventCount = statements.filter((sql) => sql.startsWith("INSERT INTO run_events")).length;
  assert.equal(await pauseExpiredAuthChallenge(pool, challengeId, now), false);
  assert.equal(statements.filter((sql) => sql.startsWith("INSERT INTO run_events")).length, eventCount);
});
