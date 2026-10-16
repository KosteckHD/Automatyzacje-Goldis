import { DataTypes, type QueryInterface } from "sequelize";

/** Durable deletion intent and tombstones. Processing policy is implemented separately. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("deletion_jobs", {
      job_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT" },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      session_id: { type: DataTypes.UUID, allowNull: false },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      preview_id: { type: DataTypes.UUID, allowNull: false },
      step_up_grant_id: { type: DataTypes.UUID, allowNull: false },
      step_up_token_hash: { type: DataTypes.STRING(64), allowNull: false },
      target_type: { type: DataTypes.STRING(20), allowNull: false },
      target_id: { type: DataTypes.UUID, allowNull: false },
      scope_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      next_attempt_at: { type: DataTypes.DATE, allowNull: false },
      lease_owner: { type: DataTypes.UUID, allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      summary: { type: DataTypes.JSONB, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE deletion_jobs
         ADD CONSTRAINT deletion_jobs_idempotency_valid CHECK (length(trim(idempotency_key)) BETWEEN 16 AND 120),
         ADD CONSTRAINT deletion_jobs_fingerprint_valid CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT deletion_jobs_step_up_hash_valid CHECK (step_up_token_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT deletion_jobs_target_valid CHECK (target_type IN ('run', 'import', 'tenant') AND target_id IS NOT NULL),
         ADD CONSTRAINT deletion_jobs_status_valid CHECK (status IN ('queued', 'processing', 'verifying', 'completed', 'failed_retryable', 'manual_required')),
         ADD CONSTRAINT deletion_jobs_version_valid CHECK (version > 0 AND attempt_count BETWEEN 0 AND 100),
         ADD CONSTRAINT deletion_jobs_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
         ADD CONSTRAINT deletion_jobs_summary_object CHECK (jsonb_typeof(summary) = 'object');
       CREATE UNIQUE INDEX deletion_jobs_actor_idempotency_uidx
         ON deletion_jobs (tenant_id, actor_user_id, idempotency_key);
       CREATE INDEX deletion_jobs_claim_idx ON deletion_jobs (status, next_attempt_at, lease_expires_at, created_at)
         WHERE status IN ('queued', 'failed_retryable', 'processing', 'verifying');
       CREATE INDEX deletion_jobs_target_idx ON deletion_jobs (tenant_id, target_type, target_id, created_at DESC);`,
      { transaction },
    );
    await context.createTable("deletion_job_files", {
      file_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      job_id: { type: DataTypes.UUID, allowNull: false, references: { model: "deletion_jobs", key: "job_id" }, onDelete: "CASCADE" },
      artifact_id: { type: DataTypes.UUID, allowNull: false },
      storage_key: { type: DataTypes.TEXT, allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      state: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      removed_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE deletion_job_files
         ADD CONSTRAINT deletion_job_files_sha256_valid CHECK (sha256 ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT deletion_job_files_key_valid CHECK (storage_key ~ '^artifacts/[0-9a-f-]{36}\\.xlsx$'),
         ADD CONSTRAINT deletion_job_files_state_valid CHECK ((state = 'pending' AND removed_at IS NULL) OR (state = 'removed' AND removed_at IS NOT NULL)),
         ADD CONSTRAINT deletion_job_files_job_artifact_unique UNIQUE (job_id, artifact_id);
       CREATE INDEX deletion_job_files_pending_idx ON deletion_job_files (job_id, state, file_id);`,
      { transaction },
    );
    await context.createTable("resource_tombstones", {
      tombstone_id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT" },
      resource_type: { type: DataTypes.STRING(20), allowNull: false },
      resource_id: { type: DataTypes.UUID, allowNull: false },
      job_id: { type: DataTypes.UUID, allowNull: false, references: { model: "deletion_jobs", key: "job_id" }, onDelete: "RESTRICT" },
      state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      completed_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE resource_tombstones
         ADD CONSTRAINT resource_tombstones_type_valid CHECK (resource_type IN ('artifact', 'run', 'import', 'tenant')),
         ADD CONSTRAINT resource_tombstones_state_valid CHECK ((state = 'active' AND completed_at IS NULL) OR (state IN ('completed', 'manual_required') AND completed_at IS NOT NULL)),
         ADD CONSTRAINT resource_tombstones_target_unique UNIQUE (tenant_id, resource_type, resource_id);
       CREATE INDEX resource_tombstones_job_idx ON resource_tombstones (job_id, state);`,
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
         'run.prepared_set.completed', 'run.prepared_set.cancelled', 'run.prepared_set.failed',
         'run.prepared_set.pause_requested', 'run.prepared_set.resumed', 'sms.submitted',
         'regon.correction.proposed', 'regon.correction.reviewed', 'entity.conflict.reviewed',
         'enrichment.job.created', 'enrichment.job.cancelled', 'enrichment.job.completed', 'artifact.downloaded',
         'user.created', 'user.updated', 'user.deletion_grant.updated', 'deletion.step_up.granted',
         'deletion.preview.created', 'deletion.job.created', 'deletion.job.completed', 'deletion.job.failed',
         'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked', 'intervention.assigned',
         'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved', 'settings.updated'
       ))`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_JOB_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
