import { DataTypes, type QueryInterface } from "sequelize";

/** Durable parent execution and immutable <=500-row children for a sealed prepared import. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("prepared_set_executions", {
      execution_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false },
      preparation_id: { type: DataTypes.UUID, allowNull: false },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      request_hash: { type: DataTypes.STRING(64), allowNull: false },
      snapshot_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      reference_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },
      cursor_row_number: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      chunk_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      lease_owner: { type: DataTypes.UUID, allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
      next_attempt_at: { type: DataTypes.DATE, allowNull: true },
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE prepared_set_executions
         ADD CONSTRAINT prepared_set_executions_batch_tenant_fk FOREIGN KEY (tenant_id, batch_id)
           REFERENCES import_batches (tenant_id, id) ON DELETE CASCADE,
         ADD CONSTRAINT prepared_set_executions_preparation_fk FOREIGN KEY (preparation_id, batch_id)
           REFERENCES import_preparations (preparation_id, batch_id) ON DELETE RESTRICT,
         ADD CONSTRAINT prepared_set_executions_actor_fk FOREIGN KEY (tenant_id, actor_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT prepared_set_executions_batch_id_uidx UNIQUE (execution_id, batch_id),
         ADD CONSTRAINT prepared_set_executions_key_valid CHECK (length(trim(idempotency_key)) BETWEEN 16 AND 120),
         ADD CONSTRAINT prepared_set_executions_hash_valid CHECK (request_hash ~ '^[0-9a-f]{64}$' AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT prepared_set_executions_status_valid CHECK (status IN ('queued', 'running', 'waiting_attention', 'completed', 'cancelled', 'failed')),
         ADD CONSTRAINT prepared_set_executions_cursor_valid CHECK (cursor_row_number >= 1 AND chunk_count >= 0 AND version > 0),
         ADD CONSTRAINT prepared_set_executions_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
         ADD CONSTRAINT prepared_set_executions_error_valid CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,80}$');
       CREATE UNIQUE INDEX prepared_set_executions_actor_key_uidx
         ON prepared_set_executions (tenant_id, actor_user_id, idempotency_key);
       CREATE UNIQUE INDEX prepared_set_executions_one_active_uidx
         ON prepared_set_executions (tenant_id, batch_id)
         WHERE status IN ('queued', 'running', 'waiting_attention');
       CREATE INDEX prepared_set_executions_claim_idx
         ON prepared_set_executions (status, next_attempt_at, lease_expires_at, created_at)
         WHERE status IN ('queued', 'running', 'waiting_attention');`,
      { transaction },
    );

    await context.createTable("prepared_set_chunks", {
      execution_id: { type: DataTypes.UUID, allowNull: false },
      ordinal: { type: DataTypes.INTEGER, allowNull: false },
      row_numbers: { type: DataTypes.JSONB, allowNull: false },
      first_row_number: { type: DataTypes.INTEGER, allowNull: false },
      last_row_number: { type: DataTypes.INTEGER, allowNull: false },
      input_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },
      child_submission_id: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE prepared_set_chunks
         ADD CONSTRAINT prepared_set_chunks_pk PRIMARY KEY (execution_id, ordinal),
         ADD CONSTRAINT prepared_set_chunks_execution_fk FOREIGN KEY (execution_id)
           REFERENCES prepared_set_executions (execution_id) ON DELETE CASCADE,
         ADD CONSTRAINT prepared_set_chunks_child_fk FOREIGN KEY (child_submission_id)
           REFERENCES run_submissions (submission_id) ON DELETE RESTRICT,
         ADD CONSTRAINT prepared_set_chunks_ordinal_valid CHECK (ordinal > 0),
         ADD CONSTRAINT prepared_set_chunks_rows_valid CHECK (
           jsonb_typeof(row_numbers) = 'array' AND jsonb_array_length(row_numbers) BETWEEN 1 AND 500
           AND first_row_number >= 2 AND last_row_number >= first_row_number
           AND input_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT prepared_set_chunks_status_valid CHECK
           (status IN ('queued', 'submitting', 'running', 'waiting_attention', 'completed', 'cancelled', 'failed')),
         ADD CONSTRAINT prepared_set_chunks_submission_once UNIQUE (execution_id, child_submission_id);
       CREATE INDEX prepared_set_chunks_status_idx ON prepared_set_chunks (execution_id, status, ordinal);`,
      { transaction },
    );

    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
         'login.succeeded', 'login.failed', 'logout.succeeded', 'session.revoked', 'password.changed',
         'import.created', 'import.preparation.started', 'import.preparation.completed', 'import.preparation.cancelled',
         'import.preparation.workflow.started', 'import.preparation.workflow.completed',
         'import.preparation.workflow.cancelled', 'import.preparation.workflow.failed',
         'run.created', 'run.cancelled', 'run.auth_resumed', 'run.review_resumed', 'run.manual_data_corrected',
         'run.submission.created', 'run.submission.cancelled', 'run.submission.group_admitted', 'run.prepared_set.created',
         'run.prepared_set.completed', 'run.prepared_set.cancelled', 'run.prepared_set.failed', 'sms.submitted',
         'regon.correction.proposed', 'regon.correction.reviewed', 'entity.conflict.reviewed',
         'enrichment.job.created', 'enrichment.job.cancelled', 'enrichment.job.completed', 'artifact.downloaded',
         'user.created', 'user.updated', 'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked',
         'intervention.assigned', 'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved',
         'settings.updated'
       ))`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("PREPARED_SET_EXECUTION_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
