import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { RunExecutionLease } from "./execution-lease";
import type { StagedResultMetadata } from "./result-staging";

export class PgResultStagingCheckpoint {
  constructor(private readonly pool: Pool) {}

  async commitSnapshot(runId: string, sourceRowId: string, lease: RunExecutionLease, metadata: StagedResultMetadata): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{
        status: string; source_row_id: string; last_safe_step: string | null;
        execution_id: string | null; worker_session_id: string | null; lease_expires_at: Date | null;
      }>(
        `SELECT status, source_row_id, last_safe_step, execution_id, worker_session_id, lease_expires_at
         FROM automation_runs WHERE id = $1 FOR UPDATE`, [runId],
      );
      const row = run.rows[0];
      if (run.rowCount !== 1 || row.status !== "ufg_verification" || row.source_row_id !== sourceRowId
        || row.last_safe_step !== "ufg_verification_intent" || row.execution_id !== lease.executionId
        || row.worker_session_id !== lease.workerSessionId || !row.lease_expires_at
        || new Date(row.lease_expires_at).getTime() <= Date.now()) {
        await client.query("COMMIT");
        return false;
      }
      const now = new Date();
      const update = await client.query(
        `UPDATE automation_runs SET status = 'reading_oc', current_step = 'reading_oc',
           staging_file_id = $2, staging_sha256 = $3, staging_key_version = $4,
           staging_format_version = $5, updated_at = $6
         WHERE id = $1 AND execution_id = $7 AND lease_expires_at > $6`,
        [runId, metadata.fileId, metadata.sha256, metadata.keyVersion, metadata.formatVersion, now, lease.executionId],
      );
      if (update.rowCount !== 1) { await client.query("COMMIT"); return false; }
      await client.query(
        `INSERT INTO run_events (id, run_id, status, step, error_code, metadata, created_at)
         VALUES ($1, $2, 'reading_oc', 'snapshot_staged', NULL, $3::jsonb, $4)`,
        [randomUUID(), runId, JSON.stringify({ fileId: metadata.fileId, sha256: metadata.sha256, keyVersion: metadata.keyVersion, formatVersion: metadata.formatVersion }), now],
      );
      await client.query("COMMIT");
      return true;
    } catch {
      await client.query("ROLLBACK");
      throw new Error("WORKER_STAGING_CHECKPOINT_FAILED");
    } finally { client.release(); }
  }

  async load(runId: string): Promise<Readonly<{ sourceRowId: string; metadata: StagedResultMetadata }> | null> {
    const result = await this.pool.query<{
      source_row_id: string; staging_file_id: string | null; staging_sha256: string | null;
      staging_key_version: number | null; staging_format_version: number | null;
    }>(
      `SELECT r.source_row_id, r.staging_file_id, r.staging_sha256, r.staging_key_version, r.staging_format_version
       FROM automation_runs r WHERE r.id = $1`, [runId],
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row.source_row_id || !row.staging_file_id || !row.staging_sha256
      || !row.staging_key_version || !row.staging_format_version) return null;
    return {
      sourceRowId: row.source_row_id,
      metadata: {
        fileId: row.staging_file_id, sha256: row.staging_sha256,
        keyVersion: row.staging_key_version, formatVersion: row.staging_format_version,
      },
    };
  }

  async clearAfterFinalization(runId: string, lease: RunExecutionLease, fileId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE automation_runs SET staging_file_id = NULL, staging_sha256 = NULL,
         staging_key_version = NULL, staging_format_version = NULL, updated_at = $4
       WHERE id = $1 AND execution_id = $2 AND status IN ('completed', 'no_matching_policies') AND staging_file_id = $3`,
      [runId, lease.executionId, fileId, new Date()],
    );
    return result.rowCount === 1;
  }
}
