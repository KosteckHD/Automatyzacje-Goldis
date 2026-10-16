import type { QueryInterface } from "sequelize";

/** Extend the append-only audit allowlist for preparation lifecycle events. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
         'login.succeeded', 'login.failed', 'logout.succeeded', 'session.revoked', 'password.changed',
         'import.created', 'import.preparation.started', 'import.preparation.completed', 'import.preparation.cancelled',
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
  throw new Error("IMPORT_PREPARATION_AUDIT_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
