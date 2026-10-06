import { createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Portal } from "./browser";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const accountKeyPattern = /^[0-9a-f]{64}$/;
const activeStatuses = ["active", "claimed", "submitted"] as const;

export type AuthChallengeInput = Readonly<{
  challengeId?: string;
  runId: string;
  portal: Portal;
  accountKey: string;
  browserSessionId: string;
  returnStep: "pzu_login" | "compensa_login";
  expiresAt: Date;
  now?: Date;
  attemptLimit?: number;
}>;

export type AuthChallengeMetadata = Readonly<{
  challengeId: string;
  runId: string;
  portal: Portal;
  expiresAt: string;
  attemptCount: number;
  attemptLimit: number;
}>;

export type ReconciledAuthChallenge = Readonly<{
  runId: string;
  portal: Portal;
  returnStep: "pzu_login" | "compensa_login";
  reason: "worker_restarted" | "challenge_expired";
}>;

export class AuthChallengeError extends Error {
  constructor(
    readonly code: "AUTH_CHALLENGE_INPUT_INVALID" | "RUN_NOT_FOUND" | "RUN_STATE_CONFLICT" | "AUTH_CHALLENGE_ALREADY_ACTIVE" | "AUTH_CHALLENGE_ATTEMPT_LIMIT",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "AuthChallengeError";
  }
}

/** Fingerprints a configured portal account without persisting its username or password. */
export function fingerprintPortalAccount(portal: Portal, accountIdentity: string, key: string | Buffer): string {
  const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key, "utf8");
  if (!accountIdentity.trim() || keyBytes.length < 32) throw new AuthChallengeError("AUTH_CHALLENGE_INPUT_INVALID");
  return createHmac("sha256", keyBytes).update(`${portal}\0${accountIdentity}`).digest("hex");
}

function validate(input: AuthChallengeInput): { now: Date; attemptLimit: number } {
  const now = input.now ?? new Date();
  const attemptLimit = input.attemptLimit ?? 5;
  const expectedStep = input.portal === "pzu" ? "pzu_login" : "compensa_login";
  if (!uuidPattern.test(input.runId)
    || (input.challengeId !== undefined && !uuidPattern.test(input.challengeId))
    || (input.portal !== "pzu" && input.portal !== "compensa")
    || !accountKeyPattern.test(input.accountKey)
    || !uuidPattern.test(input.browserSessionId)
    || input.returnStep !== expectedStep
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(input.expiresAt.getTime())
    || input.expiresAt.getTime() <= now.getTime()
    || !Number.isInteger(attemptLimit) || attemptLimit < 1 || attemptLimit > 10) {
    throw new AuthChallengeError("AUTH_CHALLENGE_INPUT_INVALID");
  }
  return { now, attemptLimit };
}

async function lockRunRowsInOrder(client: PoolClient, runIds: readonly string[]): Promise<Map<string, { status: string; currentChallengeId: string | null }>> {
  const statuses = new Map<string, { status: string; currentChallengeId: string | null }>();
  for (const runId of [...new Set(runIds)].sort()) {
    const result = await client.query<{ status: string; current_auth_challenge_id: string | null }>(
      "SELECT status, current_auth_challenge_id FROM automation_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    if (result.rowCount === 1) statuses.set(runId, {
      status: result.rows[0].status,
      currentChallengeId: result.rows[0].current_auth_challenge_id ?? null,
    });
  }
  return statuses;
}

async function expirePreviousChallenges(client: PoolClient, input: AuthChallengeInput, now: Date): Promise<void> {
  const expired = await client.query<{ challenge_id: string }>(
    `UPDATE auth_challenges
       SET status = 'expired', updated_at = $3
     WHERE account_key = $1 AND portal = $2
       AND status = ANY($4::varchar[]) AND expires_at <= $3
     RETURNING challenge_id`,
    [input.accountKey, input.portal, now, [...activeStatuses]],
  );
  if (expired.rowCount) {
    await client.query(
      `UPDATE manual_interventions SET status = 'expired', resolved_at = $2
       WHERE challenge_id = ANY($1::uuid[]) AND status = 'open'`,
      [expired.rows.map(({ challenge_id }) => challenge_id), now],
    );
  }
}

/** Stores challenge metadata and the waiting state atomically. The SMS value is accepted later and is never an input here. */
export async function createAuthChallenge(pool: Pool, input: AuthChallengeInput): Promise<AuthChallengeMetadata> {
  const { now, attemptLimit } = validate(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const staleRunIds = await client.query<{ run_id: string }>(
      `SELECT DISTINCT run_id FROM auth_challenges
       WHERE account_key = $1 AND portal = $2 AND status = ANY($3::varchar[]) AND expires_at <= $4`,
      [input.accountKey, input.portal, [...activeStatuses], now],
    );
    const runStatuses = await lockRunRowsInOrder(client, [input.runId, ...staleRunIds.rows.map(({ run_id }) => run_id)]);
    const runLock = runStatuses.get(input.runId);
    if (!runLock) throw new AuthChallengeError("RUN_NOT_FOUND");
    const runStatus = runLock.status;

    await expirePreviousChallenges(client, input, now);
    const existing = await client.query<{
      challenge_id: string;
      run_id: string;
      browser_session_id: string;
      return_step: string;
      mfa_cycle_id: string | null;
      expires_at: Date;
      attempt_count: number;
      attempt_limit: number;
    }>(
      `SELECT challenge_id, run_id, browser_session_id, return_step, expires_at, attempt_count, attempt_limit
       FROM auth_challenges
       WHERE account_key = $1 AND portal = $2 AND status = ANY($3::varchar[]) AND expires_at > $4
       ORDER BY created_at DESC LIMIT 1`,
      [input.accountKey, input.portal, [...activeStatuses], now],
    );
    if (existing.rowCount) {
      const reference = existing.rows[0];
      if (reference.run_id !== input.runId) throw new AuthChallengeError("AUTH_CHALLENGE_ALREADY_ACTIVE");
      const locked = await client.query<{
        challenge_id: string; run_id: string; browser_session_id: string; return_step: string;
        mfa_cycle_id: string | null; expires_at: Date; attempt_count: number; attempt_limit: number;
      }>(
        `SELECT challenge_id, run_id, browser_session_id, return_step, mfa_cycle_id,
                expires_at, attempt_count, attempt_limit
         FROM auth_challenges WHERE challenge_id = $1 FOR UPDATE`,
        [reference.challenge_id],
      );
      const challenge = locked.rows[0];
      if (!challenge || challenge.run_id !== input.runId || challenge.browser_session_id !== input.browserSessionId
        || challenge.return_step !== input.returnStep || runStatus !== "waiting_for_sms") {
        throw new AuthChallengeError("AUTH_CHALLENGE_ALREADY_ACTIVE");
      }
      await client.query(
        `UPDATE automation_runs SET current_auth_challenge_id = $2 WHERE id = $1`,
        [input.runId, challenge.challenge_id],
      );
      await client.query("COMMIT");
      return {
        challengeId: challenge.challenge_id,
        runId: challenge.run_id,
        portal: input.portal,
        expiresAt: new Date(challenge.expires_at).toISOString(),
        attemptCount: challenge.attempt_count,
        attemptLimit: challenge.attempt_limit,
      };
    }

    const priorAttemptsResult = await client.query<{ attempt_count: number }>(
      "SELECT COALESCE(MAX(attempt_count), 0)::int AS attempt_count FROM auth_challenges WHERE run_id = $1 AND portal = $2",
      [input.runId, input.portal],
    );
    const attemptCount = Number(priorAttemptsResult.rows[0]?.attempt_count ?? 0);
    if (!Number.isInteger(attemptCount) || attemptCount < 0 || attemptCount >= attemptLimit) {
      throw new AuthChallengeError("AUTH_CHALLENGE_ATTEMPT_LIMIT");
    }
    if (runStatus !== input.returnStep) throw new AuthChallengeError("RUN_STATE_CONFLICT");

    const reusableCycle = runStatuses.size > 0 && runStatus === input.returnStep
      ? await client.query<{
        auth_cycle_id: string | null; auth_cycle_portal: Portal | null; auth_cycle_started_at: Date | null;
        auth_cycle_expires_at: Date | null; error_code?: string | null;
      }>(
        `SELECT auth_cycle_id, auth_cycle_portal, auth_cycle_started_at, auth_cycle_expires_at, error_code
         FROM automation_runs WHERE id = $1`, [input.runId],
      )
      : { rowCount: 0, rows: [] as Array<{ auth_cycle_id: string | null; auth_cycle_portal: Portal | null; auth_cycle_started_at: Date | null; auth_cycle_expires_at: Date | null; error_code?: string | null }> };
    const previousCycle = reusableCycle.rows[0];
    const reasonCode = previousCycle?.error_code === "SMS_CODE_REJECTED" ? "SMS_CODE_REJECTED" : "SMS_REQUIRED";
    const reuse = previousCycle?.auth_cycle_id && previousCycle.auth_cycle_portal === input.portal
      && previousCycle.auth_cycle_expires_at && new Date(previousCycle.auth_cycle_expires_at).getTime() > now.getTime();
    const cycleId = reuse ? previousCycle.auth_cycle_id! : randomUUID();
    const cycleStartedAt = reuse ? previousCycle.auth_cycle_started_at! : now;
    const cycleExpiresAt = reuse && previousCycle.auth_cycle_expires_at
      ? new Date(Math.min(input.expiresAt.getTime(), new Date(previousCycle.auth_cycle_expires_at).getTime()))
      : input.expiresAt;
    if (cycleExpiresAt.getTime() <= now.getTime()) throw new AuthChallengeError("AUTH_CHALLENGE_INPUT_INVALID");

    const challengeId = input.challengeId ?? randomUUID();
    const interventionId = randomUUID();
    await client.query(
      `INSERT INTO auth_challenges
         (challenge_id, run_id, portal, account_key, browser_session_id, return_step, status,
          attempt_count, attempt_limit, expires_at, claimed_at, consumed_at, created_at, updated_at, mfa_cycle_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, NULL, NULL, $10, $10, $11)`,
      [challengeId, input.runId, input.portal, input.accountKey, input.browserSessionId, input.returnStep,
        attemptCount, attemptLimit, cycleExpiresAt, now, cycleId],
    );
    await client.query(
      `INSERT INTO manual_interventions
         (intervention_id, run_id, challenge_id, portal, kind, status, reason_code, created_at, resolved_at, resolved_by, updated_at, revision)
       VALUES ($1, $2, $3, $4, 'sms', 'open', $6, $5, NULL, NULL, $5, 1)`,
      [interventionId, input.runId, challengeId, input.portal, now, reasonCode],
    );
    const updated = await client.query(
      `UPDATE automation_runs SET status = 'waiting_for_sms', current_step = 'waiting_for_sms',
         error_code = $9, current_auth_challenge_id = $3, auth_cycle_id = $4, auth_cycle_portal = $5,
         auth_cycle_started_at = $6, auth_cycle_expires_at = $7, updated_at = $8
       WHERE id = $1 AND status = $2`,
      [input.runId, input.returnStep, challengeId, cycleId, input.portal, cycleStartedAt, cycleExpiresAt, now,
        reasonCode === "SMS_CODE_REJECTED" ? reasonCode : null],
    );
    if (updated.rowCount !== 1) throw new AuthChallengeError("RUN_STATE_CONFLICT");
    await client.query(
      `INSERT INTO run_events (id, run_id, status, step, error_code, actor_id, metadata, created_at)
       VALUES ($1, $2, 'waiting_for_sms', 'waiting_for_sms', NULL, NULL, $3::jsonb, $4)`,
      [randomUUID(), input.runId, JSON.stringify({ challengeId, portal: input.portal, expiresAt: cycleExpiresAt.toISOString(), attemptLimit }), now],
    );
    await client.query("COMMIT");
    return {
      challengeId,
      runId: input.runId,
      portal: input.portal,
      expiresAt: cycleExpiresAt.toISOString(),
      attemptCount,
      attemptLimit,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof AuthChallengeError) throw error;
    if ((error as { code?: string })?.code === "23505") throw new AuthChallengeError("AUTH_CHALLENGE_ALREADY_ACTIVE");
    throw new AuthChallengeError("RUN_STATE_CONFLICT", { cause: error });
  } finally {
    client.release();
  }
}

export type AuthChallengeOutcome = "accepted" | "rejected" | "expired";

/** Expires an unused code and leaves an actionable SMS incident for an administrator. */
export async function pauseExpiredAuthChallenge(pool: Pool, challengeId: string, now = new Date()): Promise<boolean> {
  if (!uuidPattern.test(challengeId) || !Number.isFinite(now.getTime())) throw new AuthChallengeError("AUTH_CHALLENGE_INPUT_INVALID");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reference = await client.query<{ run_id: string }>(
      "SELECT run_id FROM auth_challenges WHERE challenge_id = $1", [challengeId],
    );
    if (reference.rowCount !== 1) { await client.query("COMMIT"); return false; }
    const run = await client.query<{ status: string; current_auth_challenge_id: string | null }>(
      "SELECT status, current_auth_challenge_id FROM automation_runs WHERE id = $1 FOR UPDATE",
      [reference.rows[0].run_id],
    );
    if (run.rowCount !== 1 || run.rows[0].current_auth_challenge_id !== challengeId
      || run.rows[0].status !== "waiting_for_sms") {
      await client.query("COMMIT");
      return false;
    }
    const challenge = await client.query<{ run_id: string; portal: Portal; status: string; expires_at: Date }>(
      "SELECT run_id, portal, status, expires_at FROM auth_challenges WHERE challenge_id = $1 FOR UPDATE", [challengeId],
    );
    if (challenge.rowCount !== 1 || challenge.rows[0].run_id !== reference.rows[0].run_id
      || new Date(challenge.rows[0].expires_at).getTime() > now.getTime()
      || !["active", "claimed"].includes(challenge.rows[0].status)) {
      await client.query("COMMIT");
      return false;
    }
    const runId = reference.rows[0].run_id;
    await client.query("UPDATE auth_challenges SET status = 'expired', updated_at = $2 WHERE challenge_id = $1", [challengeId, now]);
    await client.query(
      "UPDATE manual_interventions SET reason_code = 'SMS_TIMEOUT', revision = revision + 1, updated_at = $2 WHERE challenge_id = $1 AND status = 'open'",
      [challengeId, now],
    );
    await client.query(
      `UPDATE automation_runs SET status = 'waiting_for_manual_data', current_step = 'waiting_for_manual_data',
         error_code = 'SMS_RETRY_REQUIRED', updated_at = $2 WHERE id = $1`, [runId, now],
    );
    await client.query(
      `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
       VALUES ($1, $2, 'waiting_for_manual_data', 'sms_timeout', 'SMS_RETRY_REQUIRED', $3::jsonb, $4)`,
      [randomUUID(), runId, JSON.stringify({ portal: challenge.rows[0].portal, challengeId }), now],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof AuthChallengeError) throw error;
    throw new AuthChallengeError("RUN_STATE_CONFLICT", { cause: error });
  } finally { client.release(); }
}

/** Closes an uncertain attempt so a later run cannot reuse or claim its code. */
export async function invalidateUncertainAuthChallenge(pool: Pool, challengeId: string, now = new Date()): Promise<void> {
  if (!uuidPattern.test(challengeId) || !Number.isFinite(now.getTime())) throw new AuthChallengeError("AUTH_CHALLENGE_INPUT_INVALID");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reference = await client.query<{ run_id: string }>(
      "SELECT run_id FROM auth_challenges WHERE challenge_id = $1", [challengeId],
    );
    if (reference.rowCount !== 1) { await client.query("COMMIT"); return; }
    const run = await client.query<{ status: string; current_auth_challenge_id: string | null }>(
      "SELECT status, current_auth_challenge_id FROM automation_runs WHERE id = $1 FOR UPDATE",
      [reference.rows[0].run_id],
    );
    if (run.rowCount !== 1 || run.rows[0].current_auth_challenge_id !== challengeId) {
      await client.query("COMMIT");
      return;
    }
    const challenge = await client.query<{ portal: Portal; status: string; run_id: string }>(
      "SELECT portal, status, run_id FROM auth_challenges WHERE challenge_id = $1 FOR UPDATE", [challengeId],
    );
    if (challenge.rowCount === 1 && challenge.rows[0].run_id === reference.rows[0].run_id
      && activeStatuses.includes(challenge.rows[0].status as typeof activeStatuses[number])) {
      await client.query(
        `UPDATE auth_challenges SET status = 'invalidated', updated_at = $2 WHERE challenge_id = $1`,
        [challengeId, now],
      );
      await client.query(
        `UPDATE manual_interventions SET reason_code = 'SMS_DELIVERY_UNCERTAIN', revision = revision + 1, updated_at = $2
         WHERE challenge_id = $1 AND status = 'open'`, [challengeId, now],
      );
      const updated = run.rows[0].status === "waiting_for_sms" ? await client.query(
        `UPDATE automation_runs SET status = 'waiting_for_manual_data', current_step = 'waiting_for_manual_data',
           error_code = 'SMS_DELIVERY_UNCERTAIN', updated_at = $2
         WHERE id = $1 AND status = 'waiting_for_sms'`, [reference.rows[0].run_id, now],
      ) : { rowCount: 0 };
      if (updated.rowCount === 1) await client.query(
        `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
         VALUES ($1, $2, 'waiting_for_manual_data', 'sms_delivery_uncertain', 'SMS_DELIVERY_UNCERTAIN', $3::jsonb, $4)`,
        [randomUUID(), reference.rows[0].run_id, JSON.stringify({ portal: challenge.rows[0].portal, challengeId }), now],
      );
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
    throw new AuthChallengeError("RUN_STATE_CONFLICT");
  } finally {
    client.release();
  }
}

export type AuthChallengeOutcomeResult = Readonly<{
  runId: string;
  portal: Portal;
  returnStep: "pzu_login" | "compensa_login";
  outcome: AuthChallengeOutcome | "attempt_limit_reached";
  attemptCount: number;
  attemptLimit: number;
}>;

/** Closes one submitted SMS attempt without persisting the code and resumes at the portal login step. */
export async function recordAuthChallengeOutcome(
  pool: Pool,
  challengeId: string,
  outcome: AuthChallengeOutcome,
  now = new Date(),
): Promise<AuthChallengeOutcomeResult> {
  if (!uuidPattern.test(challengeId) || !["accepted", "rejected", "expired"].includes(outcome) || !Number.isFinite(now.getTime())) {
    throw new AuthChallengeError("AUTH_CHALLENGE_INPUT_INVALID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reference = await client.query<{ run_id: string }>(
      "SELECT run_id FROM auth_challenges WHERE challenge_id = $1", [challengeId],
    );
    if (reference.rowCount !== 1) throw new AuthChallengeError("RUN_NOT_FOUND");
    const runResult = await client.query<{ status: string; current_auth_challenge_id: string | null }>(
      "SELECT status, current_auth_challenge_id FROM automation_runs WHERE id = $1 FOR UPDATE",
      [reference.rows[0].run_id],
    );
    if (runResult.rowCount !== 1 || runResult.rows[0].current_auth_challenge_id !== challengeId) {
      throw new AuthChallengeError("RUN_STATE_CONFLICT", { cause: new Error("OUTCOME_RUN_CHALLENGE_NOT_CURRENT") });
    }
    const challengeResult = await client.query<{
      run_id: string; portal: Portal; return_step: "pzu_login" | "compensa_login"; status: string;
      attempt_count: number; attempt_limit: number;
    }>(
      `SELECT run_id, portal, return_step, status, attempt_count, attempt_limit
       FROM auth_challenges WHERE challenge_id = $1 FOR UPDATE`,
      [challengeId],
    );
    if (challengeResult.rowCount !== 1) throw new AuthChallengeError("RUN_NOT_FOUND");
    const challenge = challengeResult.rows[0];
    if (challenge.run_id !== reference.rows[0].run_id) throw new AuthChallengeError("RUN_STATE_CONFLICT");
    const expectedStep = challenge.portal === "pzu" ? "pzu_login" : "compensa_login";
    if (challenge.status !== "submitted" || challenge.return_step !== expectedStep
      || !Number.isInteger(challenge.attempt_count) || challenge.attempt_count < 1
      || !Number.isInteger(challenge.attempt_limit) || challenge.attempt_count > challenge.attempt_limit) {
      throw new AuthChallengeError("RUN_STATE_CONFLICT", { cause: new Error("OUTCOME_CHALLENGE_STATE_INVALID") });
    }
    if (runResult.rowCount !== 1 || runResult.rows[0].status !== "waiting_for_sms") {
      throw new AuthChallengeError("RUN_STATE_CONFLICT", { cause: new Error("OUTCOME_RUN_STATE_INVALID") });
    }

    await client.query(
      `UPDATE auth_challenges SET status = 'consumed', consumed_at = $2, updated_at = $2
       WHERE challenge_id = $1 AND status = 'submitted'`,
      [challengeId, now],
    );
    const limitReached = outcome === "rejected" && challenge.attempt_count >= challenge.attempt_limit;
    const needsResend = outcome === "expired";
    const reasonCode = outcome === "accepted" ? "SMS_CODE_ACCEPTED"
      : needsResend ? "SMS_TIMEOUT" : limitReached ? "SMS_ATTEMPT_LIMIT" : "SMS_CODE_REJECTED";
    if (!limitReached && !needsResend) await client.query(
      `UPDATE manual_interventions SET status = 'resolved', reason_code = $2, resolved_at = $3, revision = revision + 1, updated_at = $3
       WHERE challenge_id = $1 AND status = 'open'`,
      [challengeId, reasonCode, now],
    );
    else await client.query(
      `UPDATE manual_interventions SET reason_code = $2, revision = revision + 1, updated_at = $3
       WHERE challenge_id = $1 AND status = 'open'`, [challengeId, reasonCode, now],
    );

    const nextStatus = limitReached || needsResend ? "waiting_for_manual_data" : challenge.return_step;
    const errorCode = limitReached ? "SMS_ATTEMPT_LIMIT" : needsResend ? "SMS_RETRY_REQUIRED"
      : outcome === "rejected" ? "SMS_CODE_REJECTED" : null;
    const updated = await client.query(
      `UPDATE automation_runs SET status = $2::text, current_step = $2::text, error_code = $3::text,
         finished_at = NULL,
         updated_at = $4::timestamptz
       WHERE id = $1 AND status = 'waiting_for_sms'`,
      [challenge.run_id, nextStatus, errorCode, now],
    );
    if (updated.rowCount !== 1) {
      throw new AuthChallengeError("RUN_STATE_CONFLICT", { cause: new Error("OUTCOME_RUN_UPDATE_MISMATCH") });
    }
    const step = limitReached ? "sms_attempt_limit" : needsResend ? "sms_code_expired"
      : outcome === "accepted" ? "sms_code_accepted" : "sms_code_rejected";
    await client.query(
      `INSERT INTO run_events (id, run_id, status, step, error_code, actor_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7)`,
      [randomUUID(), challenge.run_id, nextStatus, step, errorCode,
        JSON.stringify({ challengeId, portal: challenge.portal, attemptCount: challenge.attempt_count, attemptLimit: challenge.attempt_limit }), now],
    );
    await client.query("COMMIT");
    return {
      runId: challenge.run_id,
      portal: challenge.portal,
      returnStep: challenge.return_step,
      outcome: limitReached ? "attempt_limit_reached" : outcome,
      attemptCount: challenge.attempt_count,
      attemptLimit: challenge.attempt_limit,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof AuthChallengeError) throw error;
    throw new AuthChallengeError("RUN_STATE_CONFLICT", { cause: error });
  } finally {
    client.release();
  }
}

/** Invalidates challenges owned by a previous browser process and resumes waiting runs at the saved login step. */
export async function invalidateStaleAuthChallenges(
  pool: Pool,
  currentBrowserSessionId: string,
  now = new Date(),
): Promise<readonly ReconciledAuthChallenge[]> {
  if (!uuidPattern.test(currentBrowserSessionId) || !Number.isFinite(now.getTime())) {
    throw new AuthChallengeError("AUTH_CHALLENGE_INPUT_INVALID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const references = await client.query<{ challenge_id: string; run_id: string }>(
      `SELECT challenge_id, run_id FROM auth_challenges
       WHERE status = ANY($1::varchar[])
         AND (browser_session_id <> $2 OR expires_at <= $3)
       ORDER BY run_id, challenge_id`,
      [[...activeStatuses], currentBrowserSessionId, now],
    );
    const reconciled: ReconciledAuthChallenge[] = [];
    const runLocks = await lockRunRowsInOrder(client, references.rows.map(({ run_id }) => run_id));
    for (const reference of references.rows) {
      const runLock = runLocks.get(reference.run_id);
      if (!runLock) continue;
      const result = await client.query<{
        challenge_id: string; run_id: string; portal: Portal; return_step: "pzu_login" | "compensa_login";
        expires_at: Date; browser_session_id: string; status: string;
      }>(
        `SELECT challenge_id, run_id, portal, return_step, expires_at, browser_session_id, status
         FROM auth_challenges WHERE challenge_id = $1 FOR UPDATE`, [reference.challenge_id],
      );
      const challenge = result.rows[0];
      if (!challenge || challenge.run_id !== reference.run_id
        || !activeStatuses.includes(challenge.status as typeof activeStatuses[number])) continue;
      const expired = new Date(challenge.expires_at).getTime() <= now.getTime();
      const restarted = challenge.browser_session_id !== currentBrowserSessionId;
      if (!expired && !restarted) continue;
      const isCurrent = runLock.currentChallengeId === challenge.challenge_id;
      const uncertain = isCurrent && !expired && (challenge.status === "claimed" || challenge.status === "submitted");
      const reason = expired ? "challenge_expired" : "worker_restarted";
      await client.query(
        `UPDATE auth_challenges SET status = $2, updated_at = $3
         WHERE challenge_id = $1 AND status = ANY($4::varchar[])`,
        [challenge.challenge_id, expired ? "expired" : "invalidated", now, [...activeStatuses]],
      );
      if (expired && isCurrent) {
        await client.query(
          `UPDATE manual_interventions SET reason_code = 'SMS_TIMEOUT', revision = revision + 1, updated_at = $2
           WHERE challenge_id = $1 AND status = 'open'`, [challenge.challenge_id, now],
        );
      } else if (uncertain) {
        await client.query(
          `UPDATE manual_interventions SET reason_code = 'SMS_DELIVERY_UNCERTAIN', revision = revision + 1, updated_at = $2
           WHERE challenge_id = $1 AND status = 'open'`, [challenge.challenge_id, now],
        );
      } else {
        await client.query(
          `UPDATE manual_interventions SET status = 'expired', resolved_at = $2, revision = revision + 1, updated_at = $2
           WHERE challenge_id = $1 AND status = 'open'`, [challenge.challenge_id, now],
        );
      }
      if (isCurrent && runLock.status === "waiting_for_sms") {
        const nextStatus = expired || uncertain ? "waiting_for_manual_data" : challenge.return_step;
        const errorCode = expired ? "SMS_RETRY_REQUIRED" : uncertain ? "SMS_DELIVERY_UNCERTAIN" : null;
        const resumed = await client.query(
          `UPDATE automation_runs SET status = $2, current_step = $2, error_code = $3,
             current_auth_challenge_id = CASE WHEN $2 = 'waiting_for_manual_data' THEN current_auth_challenge_id ELSE NULL END,
             updated_at = $4
           WHERE id = $1 AND status = 'waiting_for_sms'`,
          [challenge.run_id, nextStatus, errorCode, now],
        );
        if (resumed.rowCount === 1) {
          await client.query(
            `INSERT INTO run_events (id, run_id, status, step, error_code, actor_id, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7)`,
            [randomUUID(), challenge.run_id, nextStatus,
              expired ? "sms_timeout" : uncertain ? "sms_delivery_uncertain" : challenge.return_step,
              errorCode, JSON.stringify({ challengeId: challenge.challenge_id, reason }), now],
          );
          reconciled.push({ runId: challenge.run_id, portal: challenge.portal, returnStep: challenge.return_step, reason });
        }
      }
    }
    await client.query("COMMIT");
    return reconciled;
  } catch {
    await client.query("ROLLBACK");
    throw new AuthChallengeError("RUN_STATE_CONFLICT");
  } finally {
    client.release();
  }
}
