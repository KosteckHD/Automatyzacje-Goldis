import { DataTypes, Op, type QueryInterface } from "sequelize";

/** Adds short-lived, payload-bound password reauthentication for account and grant changes. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("privileged_action_confirmations", {
      confirmation_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      session_id: { type: DataTypes.UUID, allowNull: false },
      credential_revision: { type: DataTypes.INTEGER, allowNull: false },
      action: { type: DataTypes.STRING(80), allowNull: false },
      target_id: { type: DataTypes.STRING(180), allowNull: true },
      payload_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      idempotency_key: { type: DataTypes.UUID, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      response: { type: DataTypes.JSONB, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE privileged_action_confirmations
         ADD CONSTRAINT privileged_action_confirmation_actor_fk FOREIGN KEY (tenant_id, user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE,
         ADD CONSTRAINT privileged_action_confirmation_session_fk FOREIGN KEY (session_id)
           REFERENCES user_sessions (session_id) ON DELETE CASCADE,
         ADD CONSTRAINT privileged_action_confirmation_revision_valid CHECK (credential_revision > 0),
         ADD CONSTRAINT privileged_action_confirmation_action_valid CHECK (action ~ '^(team|admin)\\.user\\.[a-z.-]+$'),
         ADD CONSTRAINT privileged_action_confirmation_fingerprint_valid CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT privileged_action_confirmation_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT privileged_action_confirmation_expiry_valid CHECK (expires_at > created_at),
         ADD CONSTRAINT privileged_action_confirmation_response_valid CHECK (response IS NULL OR jsonb_typeof(response) IN ('object', 'array', 'string', 'number', 'boolean')); 
       CREATE INDEX privileged_action_confirmation_actor_expiry_idx
         ON privileged_action_confirmations (tenant_id, user_id, session_id, expires_at);
       CREATE INDEX privileged_action_confirmation_cleanup_idx
         ON privileged_action_confirmations (created_at) WHERE consumed_at IS NOT NULL;`,
      { transaction },
    );
    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.addConstraint("audit_events", {
      fields: ["action"], type: "check", name: "audit_event_action_valid",
      where: { action: { [Op.in]: [
        "login.succeeded", "login.failed", "logout.succeeded", "session.revoked", "password.changed",
        "import.created", "import.preparation.started", "import.preparation.completed", "import.preparation.cancelled",
        "import.preparation.workflow.started", "import.preparation.workflow.completed",
        "import.preparation.workflow.cancelled", "import.preparation.workflow.failed",
        "run.created", "run.cancelled", "run.auth_resumed", "run.review_resumed", "run.manual_data_corrected",
        "run.pause_requested", "run.resumed_from_pause", "run.submission.created", "run.submission.cancelled",
        "run.submission.group_admitted", "run.prepared_set.created", "run.prepared_set.completed",
        "run.prepared_set.cancelled", "run.prepared_set.failed", "run.prepared_set.pause_requested",
        "run.prepared_set.resumed", "lead.allocated", "lead.status.updated", "lead.assignment.released", "sms.submitted",
        "regon.correction.proposed", "regon.correction.reviewed", "entity.conflict.reviewed",
        "enrichment.job.created", "enrichment.job.cancelled", "enrichment.job.completed", "artifact.downloaded",
        "user.created", "user.updated", "user.deletion_grant.updated", "deletion.step_up.granted",
        "deletion.preview.created", "deletion.job.created", "deletion.job.completed", "deletion.job.failed",
        "tool.grant.created", "tool.grant.updated", "tool.grant.revoked", "intervention.assigned",
        "intervention.unassigned", "intervention.priority_changed", "intervention.resolved", "settings.updated",
        "privileged_action.confirmed",
      ] } }, transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("PRIVILEGED_ACTION_CONFIRMATIONS_ARE_NOT_SAFE_TO_REVERSE");
}
