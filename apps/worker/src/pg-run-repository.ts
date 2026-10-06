import { randomUUID } from "node:crypto";
import {
  canTransitionRunStatus,
  decryptPesel,
  encryptIdentityForPersistence,
  validateIdentityMatchV1,
  type AutomationErrorCodeV1,
  type IdentityMatchV1,
  type RunStatus,
  type SourceRow,
} from "@goldis/core";
import type { Pool } from "pg";
import type { RunRepository, WorkerRunContext } from "./ports";
import type { RunExecutionLease } from "./execution-lease";

type LoadedRow = {
  id: string;
  batch_id: string;
  source_row_id: string;
  reference_date: string | Date;
  tool_id: string;
  schema_version: number;
  status: RunStatus;
  error_code: AutomationErrorCodeV1 | null;
  row_number: number;
  company_name: string;
  decision_maker_name: string | null;
  nip_raw: string;
  address: string;
  postal_code: string;
  city: string;
  county_code: string | null;
  regon_raw: string;
  regon: string | null;
  effective_regon: string | null;
  issues: string[] | string;
  identity_source_row_id: string | null;
  identity_regon: string | null;
  identity_company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  pesel_ciphertext: string | null;
  pesel_key_version: number | null;
  match_method: IdentityMatchV1["matchMethod"] | null;
  adapter_version: string | null;
};

function dateOnly(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function sourceFromRow(row: LoadedRow): SourceRow & { id: string } {
  const issues = typeof row.issues === "string" ? JSON.parse(row.issues) as unknown : row.issues;
  if (!Array.isArray(issues) || issues.some((issue) => typeof issue !== "string")) throw new Error("RUN_SOURCE_INVALID");
  return {
    id: row.source_row_id,
    rowNumber: row.row_number,
    companyName: row.company_name,
    decisionMakerName: row.decision_maker_name,
    nipRaw: row.nip_raw,
    address: row.address,
    postalCode: row.postal_code,
    city: row.city,
    countyCode: row.county_code ?? null,
    regonRaw: row.regon_raw,
    regon: row.regon,
    effectiveRegon: row.effective_regon,
    issues,
  };
}

/** PostgreSQL checkpoint owner for production Playwright runs. Never logs row or identity values. */
export class PgRunRepository implements RunRepository {
  constructor(private readonly pool: Pool, private readonly activeLease?: () => RunExecutionLease | null) {}

  private leaseMatches(row: { execution_id?: string | null; worker_session_id?: string | null; lease_expires_at?: Date | null }): boolean {
    const lease = this.activeLease?.();
    if (!lease) return this.activeLease === undefined;
    return row.execution_id === lease.executionId && row.worker_session_id === lease.workerSessionId
      && Boolean(row.lease_expires_at) && new Date(row.lease_expires_at!).getTime() > Date.now();
  }

  async clearErrorCode(runId: string, status: RunStatus): Promise<void> {
    const result = await this.pool.query(
      `UPDATE automation_runs SET error_code = NULL, updated_at = $3
       WHERE id = $1 AND status = $2 AND error_code IN ('SMS_RETRY_REQUIRED', 'SMS_RETRY_QUEUED')
         AND ($4::uuid IS NULL OR execution_id = $4)`,
      [runId, status, new Date(), this.activeLease?.()?.executionId ?? null],
    );
    if (result.rowCount !== 1) throw new Error("RUN_STATE_CONFLICT");
  }

  async load(runId: string): Promise<WorkerRunContext | null> {
    const result = await this.pool.query<LoadedRow>(
      `SELECT r.id, r.batch_id, r.source_row_id, r.reference_date, r.tool_id, r.schema_version,
              r.status, r.error_code, s.row_number, s.company_name,
              COALESCE(ov.fields->>'expectedPersonName', s.decision_maker_name) AS decision_maker_name, s.nip_raw,
              COALESCE(ov.fields->>'address', s.address) AS address,
              COALESCE(ov.fields->>'postalCode', s.postal_code) AS postal_code,
              COALESCE(ov.fields->>'city', s.city) AS city, ov.fields->>'countyCode' AS county_code,
              s.regon_raw, s.regon, s.effective_regon, s.issues,
              i.source_row_id AS identity_source_row_id, i.regon AS identity_regon,
              i.company_name AS identity_company_name, i.first_name, i.last_name,
              i.pesel_ciphertext, i.pesel_key_version, i.match_method, i.adapter_version
       FROM automation_runs r
       JOIN source_rows s ON s.id = r.source_row_id
       LEFT JOIN run_identities i ON i.run_id = r.id
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(field_name, field_value) AS fields
         FROM (
           SELECT DISTINCT ON (entry.key) entry.key AS field_name, entry.value AS field_value
           FROM run_manual_data_overrides override
           CROSS JOIN LATERAL jsonb_each(override.fields) entry
           WHERE override.run_id = r.id
           ORDER BY entry.key, override.version DESC
         ) latest_fields
       ) ov ON true
       WHERE r.id = $1`,
      [runId],
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    let identity: IdentityMatchV1 | null = null;
    if (row.identity_source_row_id) {
      if (!row.identity_regon || !row.identity_company_name || !row.first_name || !row.last_name
        || !row.pesel_ciphertext || !row.pesel_key_version || !row.match_method || !row.adapter_version) {
        throw new Error("RUN_IDENTITY_INVALID");
      }
      identity = validateIdentityMatchV1({
        schemaVersion: 1,
        sourceRowId: row.identity_source_row_id,
        regon: row.identity_regon,
        companyName: row.identity_company_name,
        firstName: row.first_name,
        lastName: row.last_name,
        pesel: decryptPesel(
          { ciphertext: row.pesel_ciphertext, keyVersion: row.pesel_key_version },
          { runId, sourceRowId: row.identity_source_row_id },
        ),
        matchMethod: row.match_method,
        adapterVersion: row.adapter_version,
      });
    }
    return {
      run: {
        schemaVersion: row.schema_version as 1,
        runId: row.id,
        sourceRowId: row.source_row_id,
        batchId: row.batch_id,
        referenceDate: dateOnly(row.reference_date),
        toolId: row.tool_id as "oc-policy-verification",
      },
      source: sourceFromRow(row),
      status: row.status,
      errorCode: row.error_code,
      cancelRequested: row.status === "cancelled",
      identity,
    };
  }

  async transition(runId: string, expected: RunStatus, next: RunStatus, errorCode: AutomationErrorCodeV1 | null = null): Promise<boolean> {
    if (!canTransitionRunStatus(expected, next)) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ status: RunStatus; execution_id: string | null; worker_session_id: string | null; lease_expires_at: Date | null }>(
        "SELECT status, execution_id, worker_session_id, lease_expires_at FROM automation_runs WHERE id = $1 FOR UPDATE", [runId],
      );
      if (result.rowCount !== 1 || result.rows[0].status !== expected || !this.leaseMatches(result.rows[0])) {
        await client.query("COMMIT");
        return false;
      }
      const now = new Date();
      const terminal = next === "completed" || next === "no_matching_policies" || next === "cancelled" || next === "failed";
      await client.query(
        `UPDATE automation_runs SET status = $2, current_step = $2, error_code = $3,
           finished_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE NULL END,
           updated_at = $5 WHERE id = $1`,
        [runId, next, errorCode, terminal, now],
      );
      await client.query(
        `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
         VALUES ($1, $2, $3, $3, $4, '{}'::jsonb, $5)`,
        [randomUUID(), runId, next, errorCode, now],
      );
      await client.query("COMMIT");
      return true;
    } catch {
      await client.query("ROLLBACK");
      throw new Error("RUN_CHECKPOINT_FAILED");
    } finally {
      client.release();
    }
  }

  /** Creates one actionable incident and pauses the run in the same transaction. */
  async pauseForReview(runId: string, expected: RunStatus, next: "identity_review" | "waiting_for_manual_data", input: {
    portal: "pzu" | "compensa";
    kind: "identity_review" | "portal_error";
    reasonCode: AutomationErrorCodeV1;
    fieldCode?: string;
  }): Promise<boolean> {
    if (!canTransitionRunStatus(expected, next)) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{ status: RunStatus; execution_id: string | null; worker_session_id: string | null; lease_expires_at: Date | null }>(
        "SELECT status, execution_id, worker_session_id, lease_expires_at FROM automation_runs WHERE id = $1 FOR UPDATE", [runId],
      );
      if (run.rows[0]?.status !== expected || !this.leaseMatches(run.rows[0])) { await client.query("COMMIT"); return false; }
      const now = new Date();
      await client.query(
        "UPDATE automation_runs SET status = $2, current_step = $2, error_code = $3, updated_at = $4 WHERE id = $1",
        [runId, next, input.reasonCode, now],
      );
      await client.query(
        `INSERT INTO manual_interventions
          (intervention_id, run_id, challenge_id, portal, kind, status, reason_code, field_code, created_at, resolved_at, resolved_by, updated_at, revision)
         VALUES ($1, $2, NULL, $3, $4, 'open', $5, $6, $7, NULL, NULL, $7, 1)`,
        [randomUUID(), runId, input.portal, input.kind, input.reasonCode, input.fieldCode ?? null, now],
      );
      await client.query(
        `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
         VALUES ($1, $2, $3, 'operator_review_required', $4, $5::jsonb, $6)`,
        [randomUUID(), runId, next, input.reasonCode, JSON.stringify({ portal: input.portal }), now],
      );
      await client.query("COMMIT");
      return true;
    } catch {
      await client.query("ROLLBACK");
      throw new Error("RUN_CHECKPOINT_FAILED");
    } finally { client.release(); }
  }

  async saveIdentity(runId: string, identityInput: IdentityMatchV1): Promise<void> {
    const identity = validateIdentityMatchV1(identityInput);
    const encrypted = encryptIdentityForPersistence(identity, runId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ status: RunStatus; source_row_id: string; effective_regon: string | null; execution_id: string | null; worker_session_id: string | null; lease_expires_at: Date | null }>(
        `SELECT r.status, r.source_row_id, s.effective_regon, r.execution_id, r.worker_session_id, r.lease_expires_at
         FROM automation_runs r JOIN source_rows s ON s.id = r.source_row_id
         WHERE r.id = $1 FOR UPDATE OF r`, [runId],
      );
      const run = result.rows[0];
      if (result.rowCount !== 1 || !this.leaseMatches(run) || run.status !== "everest_search"
        || run.source_row_id !== identity.sourceRowId || run.effective_regon !== identity.regon) {
        throw new Error("RUN_IDENTITY_STATE_CONFLICT");
      }
      const existing = await client.query<{
        source_row_id: string; regon: string; company_name: string; first_name: string; last_name: string;
        pesel_ciphertext: string; pesel_key_version: number; match_method: string; adapter_version: string;
      }>(
        `SELECT source_row_id, regon, company_name, first_name, last_name, pesel_ciphertext,
                pesel_key_version, match_method, adapter_version
         FROM run_identities WHERE run_id = $1 FOR UPDATE`, [runId],
      );
      if (existing.rowCount) {
        const previous = existing.rows[0];
        const pesel = decryptPesel(
          { ciphertext: previous.pesel_ciphertext, keyVersion: previous.pesel_key_version },
          { runId, sourceRowId: previous.source_row_id },
        );
        if (previous.source_row_id !== identity.sourceRowId || previous.regon !== identity.regon
          || previous.company_name !== identity.companyName || previous.first_name !== identity.firstName
          || previous.last_name !== identity.lastName || pesel !== identity.pesel
          || previous.match_method !== identity.matchMethod || previous.adapter_version !== identity.adapterVersion) {
          throw new Error("RUN_IDENTITY_CONFLICT");
        }
      } else {
        await client.query(
          `INSERT INTO run_identities
             (run_id, source_row_id, regon, company_name, first_name, last_name,
              pesel_ciphertext, pesel_key_version, match_method, adapter_version, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [runId, encrypted.sourceRowId, encrypted.regon, encrypted.companyName,
            encrypted.firstName, encrypted.lastName, encrypted.peselCiphertext,
            encrypted.peselKeyVersion, encrypted.matchMethod, encrypted.adapterVersion, new Date()],
        );
      }
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
      throw new Error("RUN_IDENTITY_CHECKPOINT_FAILED");
    } finally {
      client.release();
    }
  }
}
