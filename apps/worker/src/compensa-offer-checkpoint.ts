import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RunExecutionLease } from "./execution-lease";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const caseReferencePattern = /^[\p{L}\p{N}._/-]{1,200}$/u;

export type CompensaOfferCheckpoint =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "save_intent"; caseReference: string }>
  | Readonly<{ kind: "save_confirmed_absent"; caseReference: string }>
  | Readonly<{ kind: "saved"; caseReference: string }>;

export type BeginCompensaSaveResult = "started" | "already_saved" | "reconcile_required" | "state_conflict";

/** Durable boundary around the non-idempotent Compensa insured-data Save action. */
export interface CompensaOfferCheckpointStore {
  load(runId: string): Promise<CompensaOfferCheckpoint | null>;
  recordDraftReference(runId: string, caseReference: string): Promise<boolean>;
  beginSave(runId: string, caseReference: string, adapterVersion: string): Promise<BeginCompensaSaveResult>;
  confirmSaveAbsent(runId: string, caseReference: string): Promise<boolean>;
  recordSaved(runId: string, caseReference: string): Promise<boolean>;
}

function validateRunId(runId: string): void {
  if (!uuidPattern.test(runId)) throw new Error("COMPENSA_OFFER_INPUT_INVALID");
}

function validateAdapterVersion(adapterVersion: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(adapterVersion)) throw new Error("COMPENSA_OFFER_INPUT_INVALID");
}

function validateCaseReference(caseReference: string): string {
  const normalized = caseReference.trim();
  if (!caseReferencePattern.test(normalized)) throw new Error("COMPENSA_OFFER_CASE_REFERENCE_INVALID");
  return normalized;
}

/** PostgreSQL implementation uses migration-007 columns and one transaction per transition. */
export class PgCompensaOfferCheckpointStore implements CompensaOfferCheckpointStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly activeLease?: () => RunExecutionLease | null,
  ) {}

  private leaseMatches(row: { execution_id: string | null; worker_session_id: string | null; lease_expires_at: Date | null }): boolean {
    const lease = this.activeLease?.();
    if (!lease) return this.activeLease === undefined;
    return row.execution_id === lease.executionId && row.worker_session_id === lease.workerSessionId
      && Boolean(row.lease_expires_at) && new Date(row.lease_expires_at!).getTime() > Date.now();
  }

  async load(runId: string): Promise<CompensaOfferCheckpoint | null> {
    validateRunId(runId);
    const result = await this.pool.query<{ status: string; last_safe_step: string | null; external_case_ref: string | null }>(
      "SELECT status, last_safe_step, external_case_ref FROM automation_runs WHERE id = $1",
      [runId],
    );
    if (result.rowCount !== 1 || result.rows[0].status !== "compensa_form") return null;
    const row = result.rows[0];
    if (row.last_safe_step === "compensa_insured_data_saved" && row.external_case_ref) {
      return { kind: "saved", caseReference: row.external_case_ref };
    }
    if (!row.external_case_ref) return { kind: "ready" };
    if (row.last_safe_step === "compensa_insured_save_intent") {
      return { kind: "save_intent", caseReference: row.external_case_ref };
    }
    if (row.last_safe_step === "compensa_insured_save_confirmed_absent") {
      return { kind: "save_confirmed_absent", caseReference: row.external_case_ref };
    }
    return { kind: "ready" };
  }

  /** Capture the portal's draft reference before saving the insured-person form. */
  async recordDraftReference(runId: string, caseReference: string): Promise<boolean> {
    validateRunId(runId);
    const normalizedReference = validateCaseReference(caseReference);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await this.selectLockedRun(client, runId);
      if (!selected || !this.leaseMatches(selected) || !["compensa_login", "compensa_form"].includes(selected.status)) {
        await client.query("COMMIT");
        return false;
      }
      if (selected.external_case_ref) {
        const matches = selected.external_case_ref === normalizedReference;
        await client.query("COMMIT");
        return matches;
      }
      if (selected.status === "compensa_login" && selected.last_safe_step !== "compensa_start_intent") {
        await client.query("COMMIT");
        return false;
      }
      if (selected.status === "compensa_form" && selected.last_safe_step
        && !["compensa_start_intent", "compensa_offer_draft_open"].includes(selected.last_safe_step)) {
        await client.query("COMMIT");
        return false;
      }
      const now = this.validNow();
      await client.query(
        `UPDATE automation_runs SET external_case_ref = $2, last_safe_step = 'compensa_offer_draft_open', updated_at = $3
         WHERE id = $1 AND status = $4
           AND ($5::uuid IS NULL OR (execution_id = $5 AND lease_expires_at > $3))`,
        [runId, normalizedReference, now, selected.status, this.activeLease?.()?.executionId ?? null],
      );
      await this.insertEvent(client, runId, "compensa_offer_draft_open", now, {}, selected.status);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Atomically records the intent; a retry with an outstanding intent must reconcile first. */
  async beginSave(runId: string, caseReference: string, adapterVersion: string): Promise<BeginCompensaSaveResult> {
    validateRunId(runId);
    const normalizedReference = validateCaseReference(caseReference);
    validateAdapterVersion(adapterVersion);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this.selectLockedRun(client, runId);
      if (!row || !this.leaseMatches(row) || row.status !== "compensa_form" || row.external_case_ref !== normalizedReference) {
        await client.query("COMMIT");
        return "state_conflict";
      }
      if (row.last_safe_step === "compensa_insured_data_saved") {
        await client.query("COMMIT");
        return "already_saved";
      }
      if (row.last_safe_step === "compensa_insured_save_intent") {
        await client.query("COMMIT");
        return "reconcile_required";
      }
      if (!["compensa_offer_draft_open", "compensa_insured_save_confirmed_absent"].includes(row.last_safe_step ?? "")) {
        await client.query("COMMIT");
        return "state_conflict";
      }

      const now = this.validNow();
      await client.query(
        `UPDATE automation_runs SET last_safe_step = 'compensa_insured_save_intent', updated_at = $2
         WHERE id = $1 AND status = 'compensa_form'
           AND ($3::uuid IS NULL OR (execution_id = $3 AND lease_expires_at > $2))`,
        [runId, now, this.activeLease?.()?.executionId ?? null],
      );
      await this.insertEvent(client, runId, "compensa_insured_save_intent", now, { adapterVersion });
      await client.query("COMMIT");
      return "started";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Only a conclusive portal lookup may release an uncertain save intent for another click. */
  async confirmSaveAbsent(runId: string, caseReference: string): Promise<boolean> {
    validateRunId(runId);
    const normalizedReference = validateCaseReference(caseReference);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this.selectLockedRun(client, runId);
      if (!row || !this.leaseMatches(row) || row.status !== "compensa_form" || row.last_safe_step !== "compensa_insured_save_intent"
        || row.external_case_ref !== normalizedReference) {
        await client.query("COMMIT");
        return false;
      }
      const now = this.validNow();
      await client.query(
        `UPDATE automation_runs SET last_safe_step = 'compensa_insured_save_confirmed_absent', updated_at = $2
         WHERE id = $1 AND status = 'compensa_form'
           AND ($3::uuid IS NULL OR (execution_id = $3 AND lease_expires_at > $2))`,
        [runId, now, this.activeLease?.()?.executionId ?? null],
      );
      await this.insertEvent(client, runId, "compensa_insured_save_confirmed_absent", now);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordSaved(runId: string, caseReference: string): Promise<boolean> {
    validateRunId(runId);
    const normalizedReference = validateCaseReference(caseReference);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this.selectLockedRun(client, runId);
      if (!row || !this.leaseMatches(row)) {
        await client.query("COMMIT");
        return false;
      }
      if (row.status === "compensa_form" && row.last_safe_step === "compensa_insured_data_saved"
        && row.external_case_ref === normalizedReference) {
        await client.query("COMMIT");
        return true;
      }
      if (row.status !== "compensa_form" || row.external_case_ref !== normalizedReference
        || !["compensa_insured_save_intent", "compensa_insured_save_confirmed_absent"].includes(row.last_safe_step ?? "")) {
        await client.query("COMMIT");
        return false;
      }
      const now = this.validNow();
      await client.query(
        `UPDATE automation_runs SET last_safe_step = 'compensa_insured_data_saved', updated_at = $2
         WHERE id = $1 AND status = 'compensa_form'
           AND ($3::uuid IS NULL OR (execution_id = $3 AND lease_expires_at > $2))`,
        [runId, now, this.activeLease?.()?.executionId ?? null],
      );
      await this.insertEvent(client, runId, "compensa_insured_data_saved", now);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async selectLockedRun(client: PoolClient, runId: string) {
    const selected = await client.query<{
      status: string; last_safe_step: string | null; external_case_ref: string | null;
      execution_id: string | null; worker_session_id: string | null; lease_expires_at: Date | null;
    }>(
      "SELECT status, last_safe_step, external_case_ref, execution_id, worker_session_id, lease_expires_at FROM automation_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    return selected.rowCount === 1 ? selected.rows[0] : null;
  }

  private async insertEvent(
    client: PoolClient,
    runId: string,
    step: string,
    now: Date,
    metadata: Readonly<Record<string, string>> = {},
    status = "compensa_form",
  ): Promise<void> {
    await client.query(
      `INSERT INTO run_events (id, run_id, status, step, error_code, actor_id, metadata, created_at)
       VALUES ($1, $2, $6, $3, NULL, NULL, $4::jsonb, $5)`,
      [randomUUID(), runId, step, JSON.stringify(metadata), now, status],
    );
  }

  private validNow(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("COMPENSA_OFFER_CLOCK_INVALID");
    return now;
  }
}
