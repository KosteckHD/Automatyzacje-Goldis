import type { QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
         'login.succeeded', 'login.failed', 'logout.succeeded', 'session.revoked', 'password.changed',
         'import.created', 'run.created', 'run.cancelled', 'run.auth_resumed', 'run.review_resumed',
         'run.manual_data_corrected', 'sms.submitted', 'regon.correction.proposed', 'regon.correction.reviewed',
         'entity.conflict.reviewed', 'enrichment.job.created', 'enrichment.job.cancelled', 'enrichment.job.completed',
         'artifact.downloaded', 'user.created', 'user.updated', 'tool.grant.created', 'tool.grant.updated',
         'tool.grant.revoked', 'intervention.assigned', 'intervention.unassigned', 'intervention.priority_changed',
         'intervention.resolved', 'settings.updated'
       ))`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("ENRICHMENT_JOB_AUDIT_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
