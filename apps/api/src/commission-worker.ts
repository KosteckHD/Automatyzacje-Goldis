import "reflect-metadata";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { QueryTypes } from "sequelize";
import { validateCommissionEngineResultV1 } from "@goldis/core";
import { CommissionEngineClient } from "./features/commissions/commission-engine-client";
import { readCommissionFile } from "./features/commissions/commission-file-store";
import { decryptStoredArtifactBytes, encryptArtifactBytes, type ArtifactCryptoEnvironment } from "./features/results/public";
import { sequelize, configureDefaultDatabaseUrl } from "./infrastructure/database/db";
import { assertSequelizeRuntimeDatabaseRole } from "./infrastructure/database";

const queueName = "commission-comparison";
const maxCombinedWorkbookBytes = 40 * 1024 * 1024;
const publisherId = randomUUID();
type Dispatch = { dispatch_id: string; tenant_id: string; run_id: string; attempt_count: number };
type RunIdentity = { tenant_id: string; run_id: string; owner_user_id: string; active_attempt_token: string };
type RunInput = RunIdentity & { start_date: string; end_date: string; dictionary_version_id: string; snapshot_ciphertext: Buffer; status: string; files: Array<{ file_id: string; source_type: "CRM" | "ASF" | "WARTA"; file_name: string; storage_key: string; sha256: string }> };

function secret(name: string): Promise<string> | string {
  const direct = process.env[name];
  if (direct) return direct.trim();
  const path = process.env[`${name}_FILE`];
  if (path) return readFile(path, "utf8").then((value) => value.trim());
  throw new Error(`${name}_REQUIRED`);
}

async function runtime() {
  const databaseUrl = await secret("DATABASE_URL");
  const redisUrl = await secret("REDIS_URL");
  const keyring = await secret("ARTIFACT_ENCRYPTION_KEYS_BASE64");
  const active = process.env.ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION;
  if (!active || !/^[1-9]\d*$/.test(active)) throw new Error("ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION_INVALID");
  return { databaseUrl, redisUrl, crypto: { APP_ENV: process.env.APP_ENV, ARTIFACT_REQUIRE_ENCRYPTION: "1", ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: active, ARTIFACT_ENCRYPTION_KEYS_BASE64: keyring } satisfies ArtifactCryptoEnvironment };
}

async function claimDispatches(): Promise<Dispatch[]> {
  return sequelize.transaction(async (transaction) => {
    const rows = await sequelize.query<Dispatch>(
      `SELECT dispatch.dispatch_id, dispatch.tenant_id, dispatch.run_id, dispatch.attempt_count FROM commission_dispatches dispatch
        JOIN commission_runs run ON run.tenant_id=dispatch.tenant_id AND run.run_id=dispatch.run_id
        WHERE (dispatch.status = 'pending' AND dispatch.next_attempt_at <= now())
           OR (dispatch.status = 'publishing' AND dispatch.claimed_at < now() - interval '45 seconds')
           OR (dispatch.status = 'published' AND dispatch.updated_at < now() - interval '60 seconds' AND
              (run.status = 'queued' OR
               (run.status IN ('running','cancel_requested') AND
                (run.execution_lease_until IS NULL OR run.execution_lease_until < now()))))
        ORDER BY dispatch.next_attempt_at, dispatch.created_at LIMIT 10 FOR UPDATE OF dispatch SKIP LOCKED`,
      { transaction, type: QueryTypes.SELECT },
    );
    if (!rows.length) return [];
    const ids = rows.map((row) => row.dispatch_id);
    await sequelize.query(
        `UPDATE commission_dispatches SET status='publishing', claimed_at=now(), claimed_by=$2,
           attempt_count=attempt_count+1, updated_at=now()
        WHERE dispatch_id = ANY($1::uuid[])`,
      { bind: [ids, publisherId], transaction },
    );
    return rows;
  });
}

export async function publishOutbox(queue: Queue): Promise<void> {
  const rows = await claimDispatches();
  for (const row of rows) {
    try {
      await queue.add("compare", { dispatchId: row.dispatch_id }, {
        jobId: `${row.dispatch_id}-${row.attempt_count + 1}`, attempts: 3, backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: false, removeOnFail: false,
      });
      await sequelize.query(
        `UPDATE commission_dispatches SET status='published', updated_at=now(), last_error_code=NULL
          WHERE dispatch_id=$1 AND claimed_by=$2 AND status='publishing'`,
        { bind: [row.dispatch_id, publisherId] },
      );
    } catch {
      await sequelize.query(
        `UPDATE commission_dispatches SET status='pending', next_attempt_at=now()+interval '5 seconds',
           last_error_code='QUEUE_PUBLISH_FAILED', updated_at=now()
          WHERE dispatch_id=$1 AND claimed_by=$2 AND status='publishing'`,
        { bind: [row.dispatch_id, publisherId] },
      );
    }
  }
}

async function readRunInput(dispatchId: string): Promise<RunInput | null> {
  const rows = await sequelize.query<RunInput>(
    `SELECT run.tenant_id, run.run_id, run.owner_user_id, run.start_date::text, run.end_date::text,
            run.dictionary_version_id, run.active_attempt_token, run.status, dictionary.snapshot_ciphertext,
            COALESCE(json_agg(json_build_object('file_id', file.file_id, 'source_type', file.source_type,
              'file_name', file.file_name, 'storage_key', file.storage_key, 'sha256', file.sha256)
              ORDER BY file.source_type, file.uploaded_at) FILTER (WHERE file.file_id IS NOT NULL), '[]'::json) AS files
       FROM commission_dispatches dispatch
       JOIN commission_runs run ON run.tenant_id=dispatch.tenant_id AND run.run_id=dispatch.run_id
       JOIN commission_dictionary_versions dictionary ON dictionary.tenant_id=run.tenant_id AND dictionary.dictionary_version_id=run.dictionary_version_id
       JOIN commission_run_files member ON member.tenant_id=run.tenant_id AND member.run_id=run.run_id
       JOIN commission_files file ON file.tenant_id=member.tenant_id AND file.file_id=member.file_id AND file.deleted_at IS NULL
      WHERE dispatch.dispatch_id=$1 AND dispatch.status IN ('publishing','published') AND run.status IN ('running','cancel_requested')
      GROUP BY run.tenant_id, run.run_id, run.owner_user_id, run.start_date, run.end_date,
        run.dictionary_version_id, run.active_attempt_token, run.status, dictionary.snapshot_ciphertext`,
    { bind: [dispatchId], type: QueryTypes.SELECT },
  );
  return rows[0] ?? null;
}

export async function claimRunExecution(dispatchId: string): Promise<RunIdentity | null> {
  const attemptToken = randomUUID();
  return sequelize.transaction(async (transaction) => {
    const references = await sequelize.query<{ tenant_id: string; run_id: string }>(
      "SELECT tenant_id, run_id FROM commission_dispatches WHERE dispatch_id=$1",
      { bind: [dispatchId], type: QueryTypes.SELECT, transaction },
    );
    const reference = references[0];
    if (!reference) return null;
    const rows = await sequelize.query<{ tenant_id: string; run_id: string; owner_user_id: string; status: string; active_attempt_token: string | null; execution_lease_until: Date | null }>(
      `SELECT tenant_id, run_id, owner_user_id, status, active_attempt_token, execution_lease_until
         FROM commission_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
      { bind: [reference.tenant_id, reference.run_id], type: QueryTypes.SELECT, transaction },
    );
    const row = rows[0];
    if (!row) return null;
    const dispatchRows = await sequelize.query<{ status: string }>(
      `SELECT status FROM commission_dispatches
        WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 FOR UPDATE`,
      { bind: [row.tenant_id, row.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
    );
    if (!dispatchRows[0] || !["publishing", "published"].includes(dispatchRows[0].status)) return null;
    if (row.status === "cancel_requested") {
      if (row.execution_lease_until && new Date(row.execution_lease_until).getTime() > Date.now()) return null;
      const cancelled = await sequelize.query<{ run_id: string }>(
        `UPDATE commission_runs SET status='cancelled', progress_stage='cancelled', execution_lease_until=NULL, finished_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND status='cancel_requested' AND active_attempt_token IS NOT DISTINCT FROM $3 RETURNING run_id`,
        { bind: [row.tenant_id, row.run_id, row.active_attempt_token], type: QueryTypes.SELECT, transaction },
      );
      if (cancelled.length !== 1) return null;
      const dispatchCancelled = await sequelize.query<{ dispatch_id: string }>(
        `UPDATE commission_dispatches SET status='cancelled', updated_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND status IN ('publishing','published') RETURNING dispatch_id`,
        { bind: [row.tenant_id, row.run_id], type: QueryTypes.SELECT, transaction },
      );
      if (dispatchCancelled.length !== 1) throw new Error("COMMISSION_DISPATCH_FINALIZATION_CONFLICT");
      await sequelize.query(
        `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome, request_ref, metadata, created_at)
         VALUES ($1,$2,$3,'commission.run.cancelled','commission_run',$4,'succeeded',$5,'{}'::jsonb,now())`,
        { bind: [randomUUID(), row.tenant_id, row.owner_user_id, row.run_id, randomUUID()], transaction },
      );
      return null;
    }
    if (!(row.status === "queued" || row.status === "running")) return null;
    const claimed = await sequelize.query<{ run_id: string }>(
      `UPDATE commission_runs SET status='running', progress_stage='reading_files',
          active_attempt_token=$3, execution_lease_until=now()+interval '90 seconds', started_at=COALESCE(started_at,now())
        WHERE tenant_id=$1 AND run_id=$2 AND
          (status='queued' OR (status='running' AND (execution_lease_until IS NULL OR execution_lease_until < now()))) RETURNING run_id`,
      { bind: [row.tenant_id, row.run_id, attemptToken], type: QueryTypes.SELECT, transaction },
    );
    return claimed.length === 1
      ? { tenant_id: row.tenant_id, run_id: row.run_id, owner_user_id: row.owner_user_id, active_attempt_token: attemptToken }
      : null;
  });
}

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export async function markFailure(input: RunIdentity, dispatchId: string, error: unknown, terminal: boolean): Promise<void> {
  const message = error instanceof Error ? error.message : "COMMISSION_ENGINE_FAILED";
  const code = /^[A-Z0-9_]{1,64}$/.test(message) ? message : "COMMISSION_ENGINE_FAILED";
  let shouldRetry = false;
  await sequelize.transaction(async (transaction) => {
    const current = await sequelize.query<{ status: string; active_attempt_token: string | null }>(
      "SELECT status, active_attempt_token FROM commission_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE",
      { bind: [input.tenant_id, input.run_id], type: QueryTypes.SELECT, transaction },
    );
    if (current[0]?.status === "cancel_requested" && current[0]?.active_attempt_token === input.active_attempt_token) {
      const dispatch = await sequelize.query<{ status: string }>(
        "SELECT status FROM commission_dispatches WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 FOR UPDATE",
        { bind: [input.tenant_id, input.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
      );
      if (!dispatch[0] || !["publishing", "published"].includes(dispatch[0].status)) return;
      const cancelled = await sequelize.query<{ run_id: string }>(
        `UPDATE commission_runs SET status='cancelled', progress_stage='cancelled', execution_lease_until=NULL, finished_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND status='cancel_requested' AND active_attempt_token=$3 RETURNING run_id`,
        { bind: [input.tenant_id, input.run_id, input.active_attempt_token], type: QueryTypes.SELECT, transaction },
      );
      if (cancelled.length !== 1) return;
      const dispatchCancelled = await sequelize.query<{ dispatch_id: string }>(
        `UPDATE commission_dispatches SET status='cancelled', updated_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 AND status IN ('publishing','published') RETURNING dispatch_id`,
        { bind: [input.tenant_id, input.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
      );
      if (dispatchCancelled.length !== 1) throw new Error("COMMISSION_DISPATCH_FINALIZATION_CONFLICT");
      await sequelize.query(
        `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome, request_ref, metadata, created_at)
         VALUES ($1,$2,$3,'commission.run.cancelled','commission_run',$4,'succeeded',$5,'{}'::jsonb,now())`,
        { bind: [randomUUID(), input.tenant_id, input.owner_user_id, input.run_id, randomUUID()], transaction },
      );
      return;
    }
    if (current[0]?.status !== "running" || current[0]?.active_attempt_token !== input.active_attempt_token) return;
    const dispatch = await sequelize.query<{ status: string }>(
      "SELECT status FROM commission_dispatches WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 FOR UPDATE",
      { bind: [input.tenant_id, input.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
    );
    if (!dispatch[0] || !["publishing", "published"].includes(dispatch[0].status)) return;
    const nextStatus = terminal ? "failed" : "queued";
    const changed = await sequelize.query<{ run_id: string }>(
      `UPDATE commission_runs SET status=$4, progress_stage=$4,
          error_code=CASE WHEN $4='failed' THEN $5 ELSE NULL END,
          execution_lease_until=NULL, finished_at=CASE WHEN $4='failed' THEN now() ELSE NULL END
        WHERE tenant_id=$1 AND run_id=$2 AND active_attempt_token=$3 AND status='running' RETURNING run_id`,
      { bind: [input.tenant_id, input.run_id, input.active_attempt_token, nextStatus, code], type: QueryTypes.SELECT, transaction },
    );
    if (changed.length !== 1) return;
    if (terminal) {
      const dispatchFailed = await sequelize.query<{ dispatch_id: string }>(
        `UPDATE commission_dispatches SET status='failed', last_error_code=$4, updated_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 AND status IN ('publishing','published') RETURNING dispatch_id`,
        { bind: [input.tenant_id, input.run_id, dispatchId, code], type: QueryTypes.SELECT, transaction },
      );
      if (dispatchFailed.length !== 1) throw new Error("COMMISSION_DISPATCH_FINALIZATION_CONFLICT");
    } else {
      const dispatchDeferred = await sequelize.query<{ dispatch_id: string }>(
        `UPDATE commission_dispatches SET last_error_code=$4, updated_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 AND status IN ('publishing','published') RETURNING dispatch_id`,
        { bind: [input.tenant_id, input.run_id, dispatchId, code], type: QueryTypes.SELECT, transaction },
      );
      if (dispatchDeferred.length !== 1) throw new Error("COMMISSION_DISPATCH_RETRY_CONFLICT");
      shouldRetry = true;
    }
    if (!terminal) return;
    await sequelize.query(
      `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome, request_ref, metadata, created_at)
       VALUES ($1,$2,$3,'commission.run.failed','commission_run',$4,'failed',$5,jsonb_build_object('errorCode',$6),now())`,
      { bind: [randomUUID(), input.tenant_id, input.owner_user_id, input.run_id, randomUUID(), code], transaction },
    );
  });
  if (shouldRetry) throw error;
}

export async function finalizeCancellation(input: RunIdentity, dispatchId: string): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const current = await sequelize.query<{ status: string; active_attempt_token: string | null }>(
      "SELECT status, active_attempt_token FROM commission_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE",
      { bind: [input.tenant_id, input.run_id], type: QueryTypes.SELECT, transaction },
    );
    if (current[0]?.status !== "cancel_requested" || current[0]?.active_attempt_token !== input.active_attempt_token) return;
    const changed = await sequelize.query<{ run_id: string }>(
      `UPDATE commission_runs SET status='cancelled', progress_stage='cancelled', execution_lease_until=NULL, finished_at=now()
        WHERE tenant_id=$1 AND run_id=$2 AND active_attempt_token=$3 AND status='cancel_requested' RETURNING run_id`,
      { bind: [input.tenant_id, input.run_id, input.active_attempt_token], type: QueryTypes.SELECT, transaction },
    );
    if (changed.length !== 1) return;
    const dispatchCancelled = await sequelize.query<{ dispatch_id: string }>(
      `UPDATE commission_dispatches SET status='cancelled', updated_at=now()
        WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 AND status IN ('publishing','published') RETURNING dispatch_id`,
      { bind: [input.tenant_id, input.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
    );
    if (dispatchCancelled.length !== 1) throw new Error("COMMISSION_DISPATCH_FINALIZATION_CONFLICT");
    await sequelize.query(
      `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome, request_ref, metadata, created_at)
       VALUES ($1,$2,$3,'commission.run.cancelled','commission_run',$4,'succeeded',$5,'{}'::jsonb,now())`,
      { bind: [randomUUID(), input.tenant_id, input.owner_user_id, input.run_id, randomUUID()], transaction },
    );
  });
}

export async function commitRunResult(
  input: RunIdentity,
  dispatchId: string,
  attemptToken: string,
  ciphertext: Buffer,
  bytes: Buffer,
  summary: Record<string, number>,
): Promise<"completed" | "cancelled" | "obsolete"> {
  return sequelize.transaction(async (transaction) => {
    const lockedRun = await sequelize.query<{ status: string; active_attempt_token: string | null }>(
      `SELECT status, active_attempt_token FROM commission_runs
        WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
      { bind: [input.tenant_id, input.run_id], type: QueryTypes.SELECT, transaction },
    );
    const lockedDispatch = await sequelize.query<{ status: string }>(
      `SELECT status FROM commission_dispatches WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 FOR UPDATE`,
      { bind: [input.tenant_id, input.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
    );
    if (
      lockedRun[0]?.status === "cancel_requested" &&
      lockedRun[0].active_attempt_token === attemptToken &&
      ["publishing", "published"].includes(lockedDispatch[0]?.status ?? "")
    ) {
      const cancelled = await sequelize.query<{ run_id: string }>(
        `UPDATE commission_runs SET status='cancelled', progress_stage='cancelled', execution_lease_until=NULL, finished_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND status='cancel_requested' AND active_attempt_token=$3 RETURNING run_id`,
        { bind: [input.tenant_id, input.run_id, attemptToken], type: QueryTypes.SELECT, transaction },
      );
      if (cancelled.length !== 1) throw new Error("COMMISSION_CANCEL_FINALIZATION_CONFLICT");
      const dispatchCancelled = await sequelize.query<{ dispatch_id: string }>(
        `UPDATE commission_dispatches SET status='cancelled', updated_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 AND status IN ('publishing','published') RETURNING dispatch_id`,
        { bind: [input.tenant_id, input.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
      );
      if (dispatchCancelled.length !== 1) throw new Error("COMMISSION_DISPATCH_FINALIZATION_CONFLICT");
      await sequelize.query(
        `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome, request_ref, metadata, created_at)
         VALUES ($1,$2,$3,'commission.run.cancelled','commission_run',$4,'succeeded',$5,'{}'::jsonb,now())`,
        { bind: [randomUUID(), input.tenant_id, input.owner_user_id, input.run_id, randomUUID()], transaction },
      );
      return "cancelled";
    }
    if (
      lockedRun[0]?.status !== "running" || lockedRun[0].active_attempt_token !== attemptToken ||
      !["publishing", "published"].includes(lockedDispatch[0]?.status ?? "")
    ) return "obsolete";
    const lease = await sequelize.query<{ active_attempt_token: string }>(
      `SELECT active_attempt_token FROM commission_runs
        WHERE tenant_id=$1 AND run_id=$2 AND status='running' AND active_attempt_token=$3 AND execution_lease_until > now()`,
      { bind: [input.tenant_id, input.run_id, attemptToken], type: QueryTypes.SELECT, transaction },
    );
    if (lease.length !== 1) return "obsolete";
    const finalStatus = summary.missing_policies > 0 || summary.candidate_policies > 0 || summary.wrong_rate_rows > 0 || summary.unverified_rate_rows > 0 ? "completed_with_findings" : "completed";
    const completed = await sequelize.query<{ run_id: string }>(
      `UPDATE commission_runs SET status=$4, progress_stage='completed', counters=$5::jsonb, result_sha256=$6, error_code=NULL, finished_at=now(),
          execution_lease_until=NULL
        WHERE tenant_id=$1 AND run_id=$2 AND active_attempt_token=$3 AND status='running' AND execution_lease_until > now() RETURNING run_id`,
      { bind: [input.tenant_id, input.run_id, attemptToken, finalStatus, JSON.stringify(summary), hash(bytes)], type: QueryTypes.SELECT, transaction },
    );
    if (completed.length !== 1) throw new Error("COMMISSION_RUN_FINALIZATION_CONFLICT");
    const snapshot = await sequelize.query<{ run_id: string }>(
      `INSERT INTO commission_run_snapshots (tenant_id, run_id, snapshot_ciphertext, sha256, record_count, created_at)
       VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
      { bind: [input.tenant_id, input.run_id, ciphertext, hash(bytes), summary.report_records], type: QueryTypes.SELECT, transaction },
    );
    if (snapshot.length !== 1) throw new Error("COMMISSION_SNAPSHOT_ALREADY_EXISTS");
    const dispatchCompleted = await sequelize.query<{ dispatch_id: string }>(
      `UPDATE commission_dispatches SET status='completed', updated_at=now(), last_error_code=NULL
        WHERE tenant_id=$1 AND run_id=$2 AND dispatch_id=$3 AND status IN ('publishing','published') RETURNING dispatch_id`,
      { bind: [input.tenant_id, input.run_id, dispatchId], type: QueryTypes.SELECT, transaction },
    );
    if (dispatchCompleted.length !== 1) throw new Error("COMMISSION_DISPATCH_FINALIZATION_CONFLICT");
    await sequelize.query(
      `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome, request_ref, metadata, created_at)
       VALUES ($1,$2,$3,'commission.run.completed','commission_run',$4,'succeeded',$5,$6::jsonb,now())`,
      { bind: [randomUUID(), input.tenant_id, input.owner_user_id, input.run_id, randomUUID(), JSON.stringify(summary)], transaction },
    );
    return "completed";
  });
}

async function processJob(job: Job<{ dispatchId: string }>, crypto: ArtifactCryptoEnvironment, engine: CommissionEngineClient): Promise<void> {
  const dispatchId = job.data.dispatchId;
  const claim = await claimRunExecution(dispatchId);
  if (!claim) return;
  const attemptToken = claim.active_attempt_token;
  let input: RunInput | null;
  let preset: Record<string, unknown>;
  try {
    input = await readRunInput(dispatchId);
    if (!input) throw new Error("COMMISSION_RUN_INPUT_UNAVAILABLE");
    if (input.active_attempt_token !== attemptToken) return;
    if (input.status === "cancel_requested") {
      await finalizeCancellation(claim, dispatchId);
      return;
    }
    preset = JSON.parse(
      decryptStoredArtifactBytes(input.dictionary_version_id, input.snapshot_ciphertext, crypto).bytes.toString("utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await markFailure(claim, dispatchId, error, terminal);
    return;
  }
  const files: Array<{ sourceType: string; fileName: string; sha256: string; contentBase64: string }> = [];
  let totalWorkbookBytes = 0;
  let leaseLost = false;
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy || leaseLost) return;
    heartbeatBusy = true;
    try {
      const current = await sequelize.query<{ status: string; active_attempt_token: string }>(
        "SELECT status, active_attempt_token FROM commission_runs WHERE tenant_id=$1 AND run_id=$2",
        { bind: [input.tenant_id, input.run_id], type: QueryTypes.SELECT },
      );
      if (current[0]?.status === "cancel_requested" && current[0].active_attempt_token === attemptToken) {
        await engine.cancel(input.run_id, attemptToken);
        return;
      }
      const renewed = await sequelize.query<{ run_id: string }>(
        `UPDATE commission_runs SET execution_lease_until=now()+interval '90 seconds'
          WHERE tenant_id=$1 AND run_id=$2 AND status='running' AND active_attempt_token=$3
            AND execution_lease_until > now() RETURNING run_id`,
        { bind: [input.tenant_id, input.run_id, attemptToken], type: QueryTypes.SELECT },
      );
      if (renewed.length !== 1) {
        leaseLost = true;
        await engine.cancel(input.run_id, attemptToken);
      }
    } catch {
      leaseLost = true;
      await engine.cancel(input.run_id, attemptToken);
    } finally {
      heartbeatBusy = false;
    }
  }, 20_000);
  try {
    for (const file of input.files) {
      const bytes = await readCommissionFile(file.file_id, file.storage_key, crypto);
      totalWorkbookBytes += bytes.byteLength;
      if (totalWorkbookBytes > maxCombinedWorkbookBytes) throw new Error("COMMISSION_INPUT_TOTAL_SIZE_LIMIT");
      files.push({ sourceType: file.source_type, fileName: file.file_name, sha256: file.sha256, contentBase64: bytes.toString("base64") });
    }
    const result = await engine.execute<Record<string, unknown>>("/internal/v1/compare", {
      schemaVersion: 1, requestId: randomUUID(), executionId: input.run_id, attemptToken: input.active_attempt_token,
      engineVersion: process.env.COMMISSION_ENGINE_VERSION || "python-v1", start: input.start_date, end: input.end_date, preset, files,
    });
    validateCommissionEngineResultV1(result);
    if (leaseLost) throw new Error("COMMISSION_ATTEMPT_LEASE_LOST");
    const bytes = Buffer.from(JSON.stringify(result), "utf8");
    const ciphertext = encryptArtifactBytes(input.run_id, bytes, crypto);
    const summary = result.summary as Record<string, number>;
    await commitRunResult(claim, dispatchId, attemptToken, ciphertext, bytes, summary);
  } catch (error) {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await markFailure(claim, dispatchId, error, terminal);
    return;
  } finally {
    clearInterval(heartbeat);
    await new Promise<void>((resolve) => {
      if (!heartbeatBusy) return resolve();
      const wait = setInterval(() => {
        if (heartbeatBusy) return;
        clearInterval(wait);
        resolve();
      }, 5);
    });
  }
}

export async function startCommissionWorker(): Promise<void> {
  const config = await runtime();
  configureDefaultDatabaseUrl(config.databaseUrl);
  await sequelize.authenticate();
  await assertSequelizeRuntimeDatabaseRole(sequelize, "goldis_commission");
  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const queue = new Queue(queueName, { connection: redis });
  const engine = new CommissionEngineClient();
  const workerRedis = redis.duplicate();
  const worker = new Worker(queueName, (job) => processJob(job, config.crypto, engine), {
    connection: workerRedis,
    concurrency: 1,
    stalledInterval: 100_000,
    maxStalledCount: 3,
  });
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  worker.on("failed", async (job, error) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const input = await readRunInput(job.data.dispatchId).catch(() => null);
    if (input) await markFailure(input, job.data.dispatchId, error, true).catch(() => undefined);
  });
  while (!stopping) {
    await publishOutbox(queue).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  await worker.close(); await queue.close(); await workerRedis.quit(); await redis.quit();
}

if (require.main === module) {
  void startCommissionWorker().catch(async (error) => {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message) ? error.message : "COMMISSION_WORKER_START_FAILED";
    console.error("COMMISSION_WORKER_START_FAILED", code);
    process.exitCode = 1;
  }).finally(async () => { if (process.exitCode !== 1) await sequelize.close().catch(() => undefined); });
}
