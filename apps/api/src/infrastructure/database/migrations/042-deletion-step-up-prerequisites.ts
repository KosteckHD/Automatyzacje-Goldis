import { DataTypes, type QueryInterface } from "sequelize";

/** Safe prerequisites for deletion preview/purge: explicit grant plus single-use scoped reauthentication. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("tenant_memberships", "can_delete_data", {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
    }, { transaction });
    await context.addColumn("tenant_memberships", "deletion_grant_version", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE tenant_memberships
         ADD CONSTRAINT tenant_memberships_deletion_grant_version_valid CHECK (deletion_grant_version >= 0)`,
      { transaction },
    );
    await context.createTable("deletion_step_up_grants", {
      grant_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT" },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "user_id" }, onDelete: "CASCADE" },
      session_id: { type: DataTypes.UUID, allowNull: false, references: { model: "user_sessions", key: "session_id" }, onDelete: "CASCADE" },
      credential_revision: { type: DataTypes.INTEGER, allowNull: false },
      deletion_grant_version: { type: DataTypes.INTEGER, allowNull: false },
      scope_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE deletion_step_up_grants
         ADD CONSTRAINT deletion_step_up_revision_valid CHECK (credential_revision > 0),
         ADD CONSTRAINT deletion_step_up_grant_version_valid CHECK (deletion_grant_version >= 0),
         ADD CONSTRAINT deletion_step_up_fingerprint_valid CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT deletion_step_up_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT deletion_step_up_expiry_valid CHECK (expires_at > created_at)`,
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
         'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked', 'intervention.assigned',
         'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved', 'settings.updated'
       ))`,
      { transaction },
    );
    await context.addIndex("deletion_step_up_grants", ["tenant_id", "user_id", "session_id", "expires_at"], {
      name: "deletion_step_up_actor_expiry_idx", transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_STEP_UP_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
