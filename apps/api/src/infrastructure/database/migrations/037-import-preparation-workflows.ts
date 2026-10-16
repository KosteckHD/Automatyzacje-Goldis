import { DataTypes, type QueryInterface } from "sequelize";

/** Durable orchestration from prepared rows through registry jobs to a sealed follow-up revision. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("import_preparation_workflows", {
      workflow_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false },
      source_preparation_id: { type: DataTypes.UUID, allowNull: false },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      status: { type: DataTypes.STRING(32), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      lease_owner: { type: DataTypes.UUID, allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
      next_attempt_at: { type: DataTypes.DATE, allowNull: true },
      reanalysis_preparation_id: { type: DataTypes.UUID, allowNull: true },
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE import_preparation_workflows
         ADD CONSTRAINT import_preparation_workflows_batch_tenant_fk FOREIGN KEY (tenant_id, batch_id)
           REFERENCES import_batches (tenant_id, id) ON DELETE CASCADE,
         ADD CONSTRAINT import_preparation_workflows_source_fk FOREIGN KEY (source_preparation_id, batch_id)
           REFERENCES import_preparations (preparation_id, batch_id) ON DELETE CASCADE,
         ADD CONSTRAINT import_preparation_workflows_reanalysis_fk FOREIGN KEY (reanalysis_preparation_id, batch_id)
           REFERENCES import_preparations (preparation_id, batch_id) ON DELETE SET NULL (reanalysis_preparation_id),
         ADD CONSTRAINT import_preparation_workflows_actor_fk FOREIGN KEY (tenant_id, actor_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT import_preparation_workflows_status_valid CHECK
           (status IN ('queued', 'starting_registry', 'waiting_registry', 'starting_reanalysis', 'waiting_reanalysis',
             'completed', 'completed_with_attention', 'cancelled', 'failed')),
         ADD CONSTRAINT import_preparation_workflows_version_valid CHECK (version > 0),
         ADD CONSTRAINT import_preparation_workflows_idempotency_valid CHECK (length(trim(idempotency_key)) BETWEEN 16 AND 120),
         ADD CONSTRAINT import_preparation_workflows_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
         ADD CONSTRAINT import_preparation_workflows_error_valid CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,80}$');
       CREATE UNIQUE INDEX import_preparation_workflows_actor_idempotency_uidx
         ON import_preparation_workflows (batch_id, actor_user_id, idempotency_key);
       CREATE UNIQUE INDEX import_preparation_workflows_one_active_uidx
         ON import_preparation_workflows (tenant_id, batch_id)
         WHERE status IN ('queued', 'starting_registry', 'waiting_registry', 'starting_reanalysis', 'waiting_reanalysis');
       CREATE INDEX import_preparation_workflows_claim_idx
         ON import_preparation_workflows (status, next_attempt_at, lease_expires_at, created_at)
         WHERE status IN ('queued', 'starting_registry', 'waiting_registry', 'starting_reanalysis', 'waiting_reanalysis');`,
      { transaction },
    );

    await context.createTable("import_preparation_workflow_jobs", {
      workflow_id: { type: DataTypes.UUID, allowNull: false },
      job_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false },
      chunk_number: { type: DataTypes.INTEGER, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE import_preparation_workflow_jobs
         ADD CONSTRAINT import_preparation_workflow_jobs_pk PRIMARY KEY (workflow_id, chunk_number),
         ADD CONSTRAINT import_preparation_workflow_jobs_workflow_fk FOREIGN KEY (workflow_id)
           REFERENCES import_preparation_workflows (workflow_id) ON DELETE CASCADE,
         ADD CONSTRAINT import_preparation_workflow_jobs_job_fk FOREIGN KEY (job_id, batch_id)
           REFERENCES enrichment_jobs (job_id, batch_id) ON DELETE CASCADE,
         ADD CONSTRAINT import_preparation_workflow_jobs_chunk_valid CHECK (chunk_number > 0);
       CREATE UNIQUE INDEX import_preparation_workflow_jobs_job_uidx
         ON import_preparation_workflow_jobs (workflow_id, job_id);`,
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
         'run.submission.created', 'run.submission.cancelled', 'run.submission.group_admitted', 'sms.submitted',
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
  throw new Error("IMPORT_PREPARATION_WORKFLOW_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
