import { DataTypes, type QueryInterface } from "sequelize";

/** Stores a short-lived, tenant/session-bound read-only summary before any purge may be authorized. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    // Invalidate fingerprints issued before previews became server-authoritative.
    await context.sequelize.query("DELETE FROM deletion_step_up_grants", { transaction });
    await context.createTable("deletion_previews", {
      preview_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT" },
      actor_user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "user_id" }, onDelete: "CASCADE" },
      session_id: { type: DataTypes.UUID, allowNull: false, references: { model: "user_sessions", key: "session_id" }, onDelete: "CASCADE" },
      target_type: { type: DataTypes.STRING(20), allowNull: false },
      target_id: { type: DataTypes.UUID, allowNull: true },
      scope_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      summary: { type: DataTypes.JSONB, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      step_up_issued_at: { type: DataTypes.DATE, allowNull: true },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE deletion_previews
         ADD CONSTRAINT deletion_preview_target_valid CHECK (
           target_type IN ('artifact', 'run', 'import', 'tenant')
           AND ((target_type = 'tenant' AND target_id IS NULL) OR (target_type <> 'tenant' AND target_id IS NOT NULL))
         ),
         ADD CONSTRAINT deletion_preview_fingerprint_valid CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT deletion_preview_summary_object CHECK (jsonb_typeof(summary) = 'object'),
         ADD CONSTRAINT deletion_preview_expiry_valid CHECK (expires_at > created_at)` ,
      { transaction },
    );
    await context.addIndex("deletion_previews", ["tenant_id", "actor_user_id", "session_id", "expires_at"], {
      name: "deletion_preview_actor_expiry_idx", transaction,
    });
    await context.addColumn("deletion_step_up_grants", "preview_id", {
      type: DataTypes.UUID, allowNull: false,
      references: { model: "deletion_previews", key: "preview_id" }, onDelete: "CASCADE",
    }, { transaction });
    await context.addIndex("deletion_step_up_grants", ["preview_id", "consumed_at"], {
      name: "deletion_step_up_preview_idx", transaction,
    });
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
         'deletion.preview.created', 'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked',
         'intervention.assigned', 'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved',
         'settings.updated'
       ))`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_PREVIEW_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
