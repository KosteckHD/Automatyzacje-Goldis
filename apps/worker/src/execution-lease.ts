import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const intents = ["create", "resume_auth", "resume_review", "recovery", "result_delivery"] as const;
export type DispatchIntent = typeof intents[number];
export type RunExecutionLease = Readonly<{
  runId: string;
  dispatchId: string;
  executionId: string;
  workerSessionId: string;
  intentType: DispatchIntent;
  leaseExpiresAt: string;
}>;

/** Atomically consumes a durable dispatch and takes the run's single fenced execution lease. */
export async function acquireRunExecution(
  pool: Pool,
  input: Readonly<{ runId: string; dispatchId: string; workerSessionId: string; now?: Date; leaseMs?: number }>,
): Promise<RunExecutionLease | null> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 60_000;
  if (!uuidPattern.test(input.runId) || !uuidPattern.test(input.dispatchId) || !uuidPattern.test(input.workerSessionId)
    || !Number.isFinite(now.getTime()) || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new Error("RUN_LEASE_INPUT_INVALID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query<{ status: string; execution_id: string | null; lease_expires_at: Date | null }>(
      "SELECT status, execution_id, lease_expires_at FROM automation_runs WHERE id = $1 FOR UPDATE", [input.runId],
    );
    if (run.rowCount !== 1 || ["completed", "cancelled", "failed", "no_matching_policies"].includes(run.rows[0].status)) {
      await client.query("COMMIT");
      return null;
    }
    const dispatch = await client.query<{ run_id: string; intent_type: string; status: string }>(
      `SELECT run_id, intent_type, status FROM run_dispatch_outbox WHERE dispatch_id = $1 FOR UPDATE`, [input.dispatchId],
    );
    const row = dispatch.rows[0];
    if (dispatch.rowCount !== 1 || row.run_id !== input.runId
      || !intents.includes(row.intent_type as DispatchIntent) || !["publishing", "published"].includes(row.status)) {
      await client.query("COMMIT");
      return null;
    }
    const currentLease = run.rows[0].lease_expires_at ? new Date(run.rows[0].lease_expires_at).getTime() : 0;
    if (run.rows[0].execution_id && currentLease > now.getTime()) {
      await client.query("COMMIT");
      return null;
    }
    const executionId = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseMs);
    const leased = await client.query(
      `UPDATE automation_runs SET execution_id = $2, worker_session_id = $3, lease_expires_at = $4,
         heartbeat_at = $5, started_at = COALESCE(started_at, $5), updated_at = $5
       WHERE id = $1 AND (execution_id IS NULL OR lease_expires_at <= $5)`,
      [input.runId, executionId, input.workerSessionId, expiresAt, now],
    );
    if (leased.rowCount !== 1) { await client.query("COMMIT"); return null; }
    const consumed = await client.query(
      `UPDATE run_dispatch_outbox SET status = 'consumed', claimed_at = NULL, claimed_by = NULL, updated_at = $3
       WHERE dispatch_id = $1 AND run_id = $2 AND status IN ('publishing', 'published')`,
      [input.dispatchId, input.runId, now],
    );
    if (consumed.rowCount !== 1) throw new Error("RUN_DISPATCH_NOT_CONSUMED");
    await client.query("COMMIT");
    return {
      runId: input.runId, dispatchId: input.dispatchId, executionId, workerSessionId: input.workerSessionId,
      intentType: row.intent_type as DispatchIntent, leaseExpiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && error.message === "RUN_LEASE_INPUT_INVALID") throw error;
    throw new Error("RUN_LEASE_ACQUIRE_FAILED");
  } finally { client.release(); }
}

/** Heartbeats cannot revive an expired or replaced fencing token. */
export async function renewRunExecution(pool: Pool, lease: RunExecutionLease, now = new Date(), leaseMs = 60_000): Promise<boolean> {
  if (!uuidPattern.test(lease.runId) || !uuidPattern.test(lease.executionId) || !Number.isFinite(now.getTime())
    || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error("RUN_LEASE_INPUT_INVALID");
  const expiresAt = new Date(now.getTime() + leaseMs);
  const result = await pool.query(
    `UPDATE automation_runs SET heartbeat_at = $3, lease_expires_at = $4, updated_at = $3
     WHERE id = $1 AND execution_id = $2 AND lease_expires_at > $3
       AND status NOT IN ('cancelled', 'failed', 'completed', 'no_matching_policies')`,
    [lease.runId, lease.executionId, now, expiresAt],
  );
  return result.rowCount === 1;
}

/** A portal action must verify its fencing token immediately before the irreversible action. */
export async function ownsRunExecution(pool: Pool, lease: RunExecutionLease, now = new Date()): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM automation_runs
     WHERE id = $1 AND execution_id = $2 AND worker_session_id = $3 AND lease_expires_at > $4
       AND status NOT IN ('cancelled', 'failed', 'completed', 'no_matching_policies')`,
    [lease.runId, lease.executionId, lease.workerSessionId, now],
  );
  return result.rowCount === 1;
}

export async function releaseRunExecution(pool: Pool, lease: RunExecutionLease, now = new Date()): Promise<void> {
  await pool.query(
    `UPDATE automation_runs SET execution_id = NULL, worker_session_id = NULL, lease_expires_at = NULL,
       heartbeat_at = $3, updated_at = $3 WHERE id = $1 AND execution_id = $2`,
    [lease.runId, lease.executionId, now],
  );
}
