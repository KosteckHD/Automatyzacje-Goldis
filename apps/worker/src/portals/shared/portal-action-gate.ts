import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/** Durable, one-shot intents before Compensa can create a draft or start UFG. */
export class PgPortalActionGate {
  constructor(private readonly pool: Pool, private readonly beforeAction?: () => Promise<void>) {}

  async authorizeStart(input: Readonly<{ runId: string; sourceRowId: string; identitySourceRowId: string; adapterVersion: string }>): Promise<boolean> {
    if (input.sourceRowId !== input.identitySourceRowId) return false;
    await this.beforeAction?.();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ status: string; source_row_id: string; last_safe_step: string | null }>(
        "SELECT status, source_row_id, last_safe_step FROM automation_runs WHERE id = $1 FOR UPDATE", [input.runId],
      );
      const run = result.rows[0];
      if (result.rowCount !== 1 || run.status !== "compensa_login" || run.source_row_id !== input.sourceRowId
        || run.last_safe_step !== null) {
        await client.query("COMMIT");
        return false;
      }
      const now = new Date();
      await client.query(
        "UPDATE automation_runs SET last_safe_step = 'compensa_start_intent', updated_at = $2 WHERE id = $1",
        [input.runId, now],
      );
      await client.query(
        `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
         VALUES ($1,$2,'compensa_login','compensa_start_intent',NULL,$3::jsonb,$4)`,
        [randomUUID(), input.runId, JSON.stringify({ adapterVersion: input.adapterVersion }), now],
      );
      await client.query("COMMIT");
      return true;
    } catch {
      await client.query("ROLLBACK");
      throw new Error("COMPENSA_START_CHECKPOINT_FAILED");
    } finally {
      client.release();
    }
  }

  async authorizeUfg(input: Readonly<{ runId: string; caseReference: string; parserVersion: string }>): Promise<boolean> {
    await this.beforeAction?.();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ status: string; last_safe_step: string | null; external_case_ref: string | null }>(
        "SELECT status, last_safe_step, external_case_ref FROM automation_runs WHERE id = $1 FOR UPDATE", [input.runId],
      );
      const run = result.rows[0];
      if (result.rowCount !== 1 || run.status !== "ufg_verification"
        || run.last_safe_step !== "compensa_insured_data_saved"
        || run.external_case_ref !== input.caseReference) {
        await client.query("COMMIT");
        return false;
      }
      const now = new Date();
      await client.query(
        "UPDATE automation_runs SET last_safe_step = 'ufg_verification_intent', updated_at = $2 WHERE id = $1",
        [input.runId, now],
      );
      await client.query(
        `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
         VALUES ($1,$2,'ufg_verification','ufg_verification_intent',NULL,$3::jsonb,$4)`,
        [randomUUID(), input.runId, JSON.stringify({ parserVersion: input.parserVersion }), now],
      );
      await client.query("COMMIT");
      return true;
    } catch {
      await client.query("ROLLBACK");
      throw new Error("UFG_CHECKPOINT_FAILED");
    } finally {
      client.release();
    }
  }
}
