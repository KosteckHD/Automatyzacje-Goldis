import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { Pool, type PoolClient } from "pg";
import { invalidateStaleAuthChallenges } from "./auth-challenges";
import { BrowserSession } from "./browser";
import { OneTimeCodeInbox, startWorkerCodeReceiver } from "./code-inbox";
import { LiveRunProcessor } from "./live-run";
import { loadPortalRuntimeConfig } from "./portal-runtime-config";
import { WorkerResultForwarder } from "./result-forwarder";
import { acquireRunExecution, ownsRunExecution, releaseRunExecution, renewRunExecution, type DispatchIntent, type RunExecutionLease } from "./execution-lease";
import { WorkerResultStagingStore } from "./result-staging";
import { PgResultStagingCheckpoint } from "./result-staging-checkpoint";

const queueName = "oc-verification";

function redisConnection() {
  const value = process.env.REDIS_URL;
  if (!value) throw new Error("REDIS_URL is required");
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis: or rediss:");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export async function validateAndParkRun(pool: Pool, runId: string, executionId?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ status: string; execution_id: string | null; lease_expires_at: Date | null; issues: unknown; effective_regon: string | null }>(
      `SELECT r.status, r.execution_id, r.lease_expires_at, s.issues, s.effective_regon FROM automation_runs r
       JOIN source_rows s ON s.id = r.source_row_id WHERE r.id = $1 FOR UPDATE OF r`,
      [runId],
    );
    if (found.rowCount !== 1 || !["queued", "validating"].includes(found.rows[0].status)) {
      await client.query("COMMIT");
      return;
    }
    const row = found.rows[0];
    if (executionId && (row.execution_id !== executionId || !row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= Date.now())) {
      await client.query("COMMIT");
      return;
    }
    const valid = Array.isArray(row.issues) && row.issues.length === 0 && Boolean(row.effective_regon);
    const now = new Date();
    if (row.status === "queued") {
      await client.query(
        "UPDATE automation_runs SET status = 'validating', current_step = 'validating', updated_at = $2 WHERE id = $1 AND ($3::uuid IS NULL OR execution_id = $3)",
        [runId, now, executionId ?? null],
      );
      await client.query(
        "INSERT INTO run_events (id, run_id, status, step, error_code, created_at) VALUES ($1, $2, 'validating', 'validating', NULL, $3)",
        [randomUUID(), runId, now],
      );
    }
    const status = valid ? "awaiting_portal_adapter" : "failed";
    const errorCode = valid ? null : "INPUT_INVALID";
    await client.query(
      "UPDATE automation_runs SET status = $2, current_step = $2, error_code = $3, updated_at = $4 WHERE id = $1 AND ($5::uuid IS NULL OR execution_id = $5)",
      [runId, status, errorCode, now, executionId ?? null],
    );
    await client.query(
      "INSERT INTO run_events (id, run_id, status, step, error_code, created_at) VALUES ($1, $2, $3, $3, $4, $5)",
      [randomUUID(), runId, status, errorCode, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Stores a safe technical retry or a durable operator incident without leaking exception text. */
export async function recordProcessorFailure(pool: Pool, runId: string, lease: RunExecutionLease): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      status: string; execution_id: string | null; worker_session_id: string | null; lease_expires_at: Date | null;
      technical_cycle_id: string | null; technical_attempt_count: number;
    }>(
      `SELECT status, execution_id, worker_session_id, lease_expires_at, technical_cycle_id, technical_attempt_count
       FROM automation_runs WHERE id = $1 FOR UPDATE`, [runId],
    );
    const row = locked.rows[0];
    if (!row || row.execution_id !== lease.executionId || row.worker_session_id !== lease.workerSessionId
      || !row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= Date.now()
      || ["completed", "cancelled", "failed", "no_matching_policies", "identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(row.status)) {
      await client.query("COMMIT");
      return;
    }
    const safeRetry = ["queued", "validating", "awaiting_portal_adapter", "reading_oc", "export_ready"].includes(row.status);
    const retryNumber = Number(row.technical_attempt_count);
    const now = new Date();
    if (safeRetry && retryNumber < 2) {
      const intent = row.status === "reading_oc" || row.status === "export_ready" ? "result_delivery" : "recovery";
      const cycleId = row.technical_cycle_id ?? randomUUID();
      const nextAttemptAt = new Date(now.getTime() + (retryNumber === 0 ? 5_000 : 15_000));
      const fenced = await client.query(
        `UPDATE automation_runs SET technical_cycle_id = $2, technical_attempt_count = $3, updated_at = $4
         WHERE id = $1 AND execution_id = $5 AND lease_expires_at > $4`,
        [runId, cycleId, retryNumber + 1, now, lease.executionId],
      );
      if (fenced.rowCount !== 1) { await client.query("COMMIT"); return; }
      const unresolved = await client.query<{ dispatch_id: string }>(
        `SELECT dispatch_id FROM run_dispatch_outbox WHERE run_id = $1
         AND status IN ('pending', 'publishing', 'published') FOR UPDATE`, [runId],
      );
      if (unresolved.rowCount) {
        await client.query(
          `UPDATE run_dispatch_outbox SET intent_type = $3, status = 'pending', next_attempt_at = $2,
             claimed_at = NULL, claimed_by = NULL, updated_at = $2 WHERE dispatch_id = $1`,
          [unresolved.rows[0].dispatch_id, nextAttemptAt, intent],
        );
      } else {
        await client.query(
          `INSERT INTO run_dispatch_outbox
             (dispatch_id, run_id, intent_type, status, attempt_count, next_attempt_at, claimed_at, claimed_by,
              last_error_code, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', 0, $4, NULL, NULL, NULL, $5, $5)`,
          [randomUUID(), runId, intent, nextAttemptAt, now],
        );
      }
      await client.query(
        `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
         VALUES ($1, $2, $3, 'technical_retry_scheduled', NULL, $4::jsonb, $5)`,
        [randomUUID(), runId, row.status, JSON.stringify({ delaySeconds: retryNumber === 0 ? 5 : 15, attempt: retryNumber + 1 }), now],
      );
      await client.query("COMMIT");
      return;
    }
    const fenced = await client.query(
      `UPDATE automation_runs SET status = 'waiting_for_manual_data', current_step = 'waiting_for_manual_data',
         error_code = 'PORTAL_FAILURE', updated_at = $2 WHERE id = $1 AND execution_id = $3 AND lease_expires_at > $2`,
      [runId, now, lease.executionId],
    );
    if (fenced.rowCount !== 1) { await client.query("COMMIT"); return; }
    const existing = await client.query(
      "SELECT intervention_id FROM manual_interventions WHERE run_id = $1 AND status = 'open' FOR UPDATE", [runId],
    );
    if (!existing.rowCount) {
      await client.query(
        `INSERT INTO manual_interventions
           (intervention_id, run_id, challenge_id, portal, kind, status, reason_code, created_at, resolved_at, resolved_by, updated_at, revision)
         VALUES ($1, $2, NULL, NULL, 'portal_error', 'open', 'PORTAL_FAILURE', $3, NULL, NULL, $3, 1)`,
        [randomUUID(), runId, now],
      );
    }
    await client.query(
      `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
       VALUES ($1, $2, 'waiting_for_manual_data', 'operator_review_required', 'PORTAL_FAILURE', $3::jsonb, $4)`,
      [randomUUID(), runId, JSON.stringify({ dispatchId: lease.dispatchId }), now],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
    throw new Error("RUN_FAILURE_CHECKPOINT_UNAVAILABLE");
  } finally { client.release(); }
}

/** Production queue boundary consumes durable dispatches and fences the full worker execution. */
export async function deliverStagedResult(
  pool: Pool,
  runId: string,
  lease: RunExecutionLease,
  signal: AbortSignal,
  forwarder: WorkerResultForwarder,
  staging: WorkerResultStagingStore | null,
): Promise<void> {
  if (signal.aborted || !await ownsRunExecution(pool, lease)) return;
  const run = await pool.query<{ status: string }>("SELECT status FROM automation_runs WHERE id = $1", [runId]);
  const status = run.rows[0]?.status;
  if (status === "reading_oc") {
    const checkpoint = new PgResultStagingCheckpoint(pool);
    const staged = await checkpoint.load(runId);
    if (staged) {
      if (!staging) throw new Error("WORKER_STAGING_CONFIG_INVALID");
      const payload = await staging.read(runId, staged.sourceRowId, staged.metadata);
      if (signal.aborted || !await ownsRunExecution(pool, lease)) return;
      await forwarder.store(runId, payload.identity, payload.snapshot, lease);
      await staging.remove(staged.metadata.fileId);
      await checkpoint.clearAfterFinalization(runId, lease, staged.metadata.fileId);
      return;
    }
    const snapshot = await pool.query("SELECT 1 FROM oc_snapshots WHERE run_id = $1", [runId]);
    if (snapshot.rowCount !== 1) throw new Error("WORKER_STAGING_RESULT_UNAVAILABLE");
    await forwarder.finalize(runId, lease);
    return;
  }
  if (status === "export_ready") {
    await forwarder.finalize(runId, lease);
    const checkpoint = new PgResultStagingCheckpoint(pool);
    const staged = await checkpoint.load(runId);
    if (staged && staging) {
      await staging.remove(staged.metadata.fileId);
      await checkpoint.clearAfterFinalization(runId, lease, staged.metadata.fileId);
    }
  }
}

export function createProductionRunProcessor(
  pool: Pool,
  live?: LiveRunProcessor,
  workerSessionId = randomUUID(),
  deliverResult?: (runId: string, lease: RunExecutionLease, signal: AbortSignal) => Promise<void>,
  shutdownSignal?: AbortSignal,
) {
  return async (job: { id?: string; data: { runId: string } }): Promise<void> => {
    if (shutdownSignal?.aborted) return;
    if (!/^[0-9a-f-]{36}$/i.test(job.data.runId)) throw new Error("RUN_ID_INVALID");
    const dispatchMatch = /^dispatch-([0-9a-f-]{36})$/i.exec(job.id ?? "");
    if (!dispatchMatch) {
      // Compatibility for an already-enqueued legacy job. New work always carries a durable dispatch ID.
      await validateAndParkRun(pool, job.data.runId);
      // Legacy jobs are parked, never allowed to enter Playwright without a durable dispatch/lease.
      return;
    }
    const lease = await acquireRunExecution(pool, {
      runId: job.data.runId, dispatchId: dispatchMatch[1], workerSessionId,
    });
    if (!lease) return;
    const stop = new AbortController();
    const onShutdown = () => stop.abort();
    shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
    if (shutdownSignal?.aborted) stop.abort();
    let heartbeatActive = true;
    const heartbeat = (async () => {
      while (heartbeatActive && !stop.signal.aborted) {
        await new Promise<void>((resolve) => {
          const onAbort = () => { clearTimeout(timer); stop.signal.removeEventListener("abort", onAbort); resolve(); };
          const timer = setTimeout(() => { stop.signal.removeEventListener("abort", onAbort); resolve(); }, 10_000);
          timer.unref();
          stop.signal.addEventListener("abort", onAbort, { once: true });
        });
        if (!heartbeatActive || stop.signal.aborted) return;
        try {
          if (!await renewRunExecution(pool, lease)) {
            stop.abort();
            return;
          }
        } catch {
          stop.abort();
          return;
        }
      }
    })();
    try {
      if (!stop.signal.aborted && (lease.intentType === "create" || lease.intentType === "recovery")) {
        await validateAndParkRun(pool, job.data.runId, lease.executionId);
      }
      if (lease.intentType === "result_delivery" && deliverResult && !stop.signal.aborted) {
        await deliverResult(job.data.runId, lease, stop.signal);
      } else if (live && !stop.signal.aborted) {
        await live.process(job.data.runId, { lease, signal: stop.signal, intent: lease.intentType as DispatchIntent });
      }
    } catch (error) {
      // A fenced worker has lost authority; it must not write or click again.
      if (error instanceof Error && error.message === "RUN_EXECUTION_LEASE_LOST") return;
      await recordProcessorFailure(pool, job.data.runId, lease);
    } finally {
      shutdownSignal?.removeEventListener("abort", onShutdown);
      heartbeatActive = false;
      stop.abort();
      await heartbeat;
      await releaseRunExecution(pool, lease).catch(() => undefined);
    }
  };
}

export async function startRunWorker() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!process.env.WORKER_PROFILE_DIR) throw new Error("WORKER_PROFILE_DIR is required");
  const headlessSetting = process.env.WORKER_HEADLESS ?? "1";
  if (headlessSetting !== "0" && headlessSetting !== "1") throw new Error("WORKER_HEADLESS_INVALID");
  const browserChannel = process.env.WORKER_BROWSER_CHANNEL;
  if (browserChannel && browserChannel !== "chrome" && browserChannel !== "msedge") {
    throw new Error("WORKER_BROWSER_CHANNEL_INVALID");
  }
  // One browser owner for the worker lifetime; portal adapters reuse it across jobs.
  const browser = new BrowserSession({
    profileDirectory: process.env.WORKER_PROFILE_DIR,
    headless: headlessSetting === "1",
    ...(browserChannel === "chrome" || browserChannel === "msedge" ? { channel: browserChannel } : {}),
  });
  const poolMax = Number(process.env.WORKER_DB_POOL_MAX ?? "8");
  if (!Number.isInteger(poolMax) || poolMax < 4 || poolMax > 32) throw new Error("WORKER_DB_POOL_MAX_INVALID");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: poolMax });
  const inbox = new OneTimeCodeInbox();
  const liveSetting = process.env.WORKER_LIVE_PORTALS ?? "0";
  if (liveSetting !== "0" && liveSetting !== "1") throw new Error("WORKER_LIVE_PORTALS_INVALID");
  let portalConfigValid = false;
  let codeReceiver: Awaited<ReturnType<typeof startWorkerCodeReceiver>> | null = null;
  let portalOwner: PoolClient | null = null;
  let live: LiveRunProcessor | undefined;
  let staging: WorkerResultStagingStore | null = null;
  let resultForwarder: WorkerResultForwarder | null = null;
  try {
    portalOwner = await pool.connect();
    const ownership = await portalOwner.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(205746858, 1) AS acquired",
    );
    if (ownership.rows[0]?.acquired !== true) throw new Error("PORTAL_WORKER_ALREADY_RUNNING");
    await invalidateStaleAuthChallenges(pool, browser.sessionId);
    if (process.env.WORKER_STAGING_DIR && process.env.WORKER_STAGING_KEY_VERSION) staging = new WorkerResultStagingStore();
    resultForwarder = new WorkerResultForwarder();
    if (liveSetting === "1") {
      if (!staging) throw new Error("WORKER_STAGING_CONFIG_INVALID");
      const config = await loadPortalRuntimeConfig(process.env.WORKER_PORTAL_CONFIG_PATH ?? "");
      live = new LiveRunProcessor({ pool, browser, inbox, config, resultForwarder, staging });
      portalConfigValid = true;
    }
    const serviceSecret = process.env.WORKER_AUTH_SECRET;
    if (!serviceSecret) throw new Error("WORKER_AUTH_SECRET_REQUIRED");
    codeReceiver = await startWorkerCodeReceiver({
      host: process.env.WORKER_INTERNAL_HOST ?? "0.0.0.0",
      port: Number(process.env.WORKER_INTERNAL_PORT ?? "3022"),
      serviceSecret,
      inbox,
    });
    await pool.query(
      `INSERT INTO worker_runtime_status (worker_id, mode, portal_config_valid, observed_at)
       VALUES ('portal-worker', $1, $2, now())
       ON CONFLICT (worker_id) DO UPDATE SET mode = EXCLUDED.mode,
         portal_config_valid = EXCLUDED.portal_config_valid, observed_at = EXCLUDED.observed_at`,
      [liveSetting === "1" ? "live" : "off", portalConfigValid],
    );
  } catch {
    inbox.close();
    await codeReceiver?.close();
    await browser.close();
    staging?.destroyKey();
    if (portalOwner) {
      await portalOwner.query("SELECT pg_advisory_unlock(205746858, 1)").catch(() => undefined);
      portalOwner.release();
    }
    await pool.end();
    throw new Error("RUN_WORKER_PRIVATE_SERVICES_START_FAILED");
  }
  const workerSessionId = browser.sessionId;
  const shutdownController = new AbortController();
  const worker = new Worker<{ runId: string }>(queueName, createProductionRunProcessor(
    pool, live, workerSessionId,
    (runId, lease, signal) => deliverStagedResult(pool, runId, lease, signal, resultForwarder!, staging),
    shutdownController.signal,
  ), {
    connection: redisConnection(),
    concurrency: 1,
    maxStalledCount: 1,
  });
  worker.on("failed", () => console.error("RUN_WORKER_JOB_FAILED"));
  worker.on("error", () => console.error("RUN_WORKER_CONNECTION_ERROR"));
  let heartbeatPending = false;
  const runtimeHeartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    void pool.query(
      `UPDATE worker_runtime_status SET observed_at = now()
       WHERE worker_id = 'portal-worker' AND mode = $1 AND portal_config_valid = $2`,
      [liveSetting === "1" ? "live" : "off", portalConfigValid],
    ).catch(() => undefined).finally(() => { heartbeatPending = false; });
  }, 10_000);
  runtimeHeartbeat.unref();
  const shutdown = async () => {
    shutdownController.abort();
    clearInterval(runtimeHeartbeat);
    await worker.pause(true);
    inbox.close();
    await worker.close();
    await codeReceiver?.close();
    await browser.close();
    staging?.destroyKey();
    await pool.query("DELETE FROM worker_runtime_status WHERE worker_id = 'portal-worker'").catch(() => undefined);
    await portalOwner?.query("SELECT pg_advisory_unlock(205746858, 1)").catch(() => undefined);
    portalOwner?.release();
    await pool.end();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return { worker, pool, browser, inbox, codeReceiver, shutdown };
}

if (require.main === module) {
  startRunWorker().catch(() => {
    console.error("RUN_WORKER_START_FAILED");
    process.exitCode = 1;
  });
}
