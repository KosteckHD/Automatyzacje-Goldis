import { DataTypes, type QueryInterface } from "sequelize";

/** Per-run pause requests are acknowledged only at a worker-owned safe action boundary. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("automation_runs", "control_state", {
      type: DataTypes.STRING(24), allowNull: false, defaultValue: "running",
    }, { transaction });
    await context.addColumn("automation_runs", "control_revision", {
      type: DataTypes.BIGINT, allowNull: false, defaultValue: 0,
    }, { transaction });
    await context.addColumn("automation_runs", "control_ack_revision", {
      type: DataTypes.BIGINT, allowNull: false, defaultValue: 0,
    }, { transaction });
    await context.addColumn("automation_runs", "control_requested_by", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "control_requested_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "control_acknowledged_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "control_checkpoint_status", { type: DataTypes.STRING(40), allowNull: true }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE automation_runs
         ADD CONSTRAINT automation_runs_control_state_valid CHECK (control_state IN ('running', 'pause_requested', 'paused')),
         ADD CONSTRAINT automation_runs_control_revision_valid CHECK
           (control_revision >= 0 AND control_ack_revision >= 0 AND control_ack_revision <= control_revision),
         ADD CONSTRAINT automation_runs_control_ack_valid CHECK
           ((control_state <> 'pause_requested' OR control_ack_revision < control_revision)
             AND (control_state <> 'paused' OR (control_ack_revision = control_revision
               AND control_acknowledged_at IS NOT NULL AND control_checkpoint_status IS NOT NULL)));
       CREATE INDEX automation_runs_pause_control_idx ON automation_runs (control_state, status, updated_at)
         WHERE control_state <> 'running';`,
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
         'run.pause_requested', 'run.resumed_from_pause',
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
  throw new Error("RUN_CONTROL_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
