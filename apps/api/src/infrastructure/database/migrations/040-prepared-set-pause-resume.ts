import type { QueryInterface } from "sequelize";

/** Adds a safe-boundary pause/resume state for durable whole-import executions. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("prepared_set_executions", "prepared_set_executions_status_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE prepared_set_executions
         ADD CONSTRAINT prepared_set_executions_status_valid CHECK
           (status IN ('queued', 'running', 'waiting_attention', 'pause_requested', 'paused', 'completed', 'cancelled', 'failed'))`,
      { transaction },
    );
    await context.sequelize.query(
      `DROP INDEX prepared_set_executions_one_active_uidx;
       CREATE UNIQUE INDEX prepared_set_executions_one_active_uidx
         ON prepared_set_executions (tenant_id, batch_id)
         WHERE status IN ('queued', 'running', 'waiting_attention', 'pause_requested', 'paused');
       DROP INDEX prepared_set_executions_claim_idx;
       CREATE INDEX prepared_set_executions_claim_idx
         ON prepared_set_executions (status, next_attempt_at, lease_expires_at, created_at)
         WHERE status IN ('queued', 'running', 'waiting_attention', 'pause_requested');`,
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
         'user.created', 'user.updated', 'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked',
         'intervention.assigned', 'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved',
         'settings.updated'
       ))`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("PREPARED_SET_PAUSE_RESUME_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
