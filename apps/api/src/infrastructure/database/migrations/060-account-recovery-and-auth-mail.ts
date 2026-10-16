import { DataTypes, Op, type QueryInterface } from "sequelize";

const auditActions = [
  "login.succeeded", "login.failed", "logout.succeeded", "session.revoked", "password.changed",
  "import.created", "import.preparation.started", "import.preparation.completed", "import.preparation.cancelled",
  "import.preparation.workflow.started", "import.preparation.workflow.completed",
  "import.preparation.workflow.cancelled", "import.preparation.workflow.failed",
  "run.created", "run.cancelled", "run.auth_resumed", "run.review_resumed", "run.manual_data_corrected",
  "run.pause_requested", "run.resumed_from_pause", "run.submission.created", "run.submission.cancelled",
  "run.submission.group_admitted", "run.prepared_set.created", "run.prepared_set.completed",
  "run.prepared_set.cancelled", "run.prepared_set.failed", "run.prepared_set.pause_requested", "run.prepared_set.resumed",
  "lead.allocated", "lead.status.updated", "lead.assignment.released", "sms.submitted",
  "regon.correction.proposed", "regon.correction.reviewed", "entity.conflict.reviewed", "enrichment.job.created",
  "enrichment.job.cancelled", "enrichment.job.completed", "artifact.downloaded", "user.created", "user.updated",
  "user.deletion_grant.updated", "deletion.step_up.granted", "deletion.preview.created", "deletion.job.created",
  "deletion.job.completed", "deletion.job.failed", "tool.grant.created", "tool.grant.updated", "tool.grant.revoked",
  "intervention.assigned", "intervention.unassigned", "intervention.priority_changed", "intervention.resolved",
  "settings.updated", "privileged_action.confirmed", "auth.recovery.requested", "auth.recovery.completed",
  "auth.recovery.email.requested", "auth.recovery.email.verified", "auth.recovery.email.changed",
  "auth.recovery.admin_link.requested",
];

/** Adds verified recovery addresses, one-time recovery tokens, and encrypted mail queue rows. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("users", "recovery_email", { type: DataTypes.STRING(254), allowNull: true }, { transaction });
    await context.addColumn("users", "recovery_email_normalized", { type: DataTypes.STRING(254), allowNull: true }, { transaction });
    await context.addColumn("users", "recovery_email_verified_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await context.addColumn("users", "recovery_email_revision", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, { transaction });
    await context.addColumn("users", "pending_recovery_email", { type: DataTypes.STRING(254), allowNull: true }, { transaction });
    await context.addColumn("users", "pending_recovery_email_normalized", { type: DataTypes.STRING(254), allowNull: true }, { transaction });
    await context.addColumn("users", "pending_recovery_email_revision", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE users
         ADD CONSTRAINT users_recovery_email_pair CHECK (
           (recovery_email IS NULL) = (recovery_email_normalized IS NULL)
           AND (recovery_email IS NULL) = (recovery_email_verified_at IS NULL)
           AND (pending_recovery_email IS NULL) = (pending_recovery_email_normalized IS NULL)
           AND recovery_email_revision >= 0 AND pending_recovery_email_revision >= 0
           AND (recovery_email IS NULL OR (length(trim(recovery_email)) > 0 AND recovery_email_normalized = lower(recovery_email_normalized)))
           AND (pending_recovery_email IS NULL OR (length(trim(pending_recovery_email)) > 0 AND pending_recovery_email_normalized = lower(pending_recovery_email_normalized)))
         );
       CREATE UNIQUE INDEX users_recovery_email_normalized_uidx
         ON users (recovery_email_normalized) WHERE recovery_email_normalized IS NOT NULL;`,
      { transaction },
    );

    await context.createTable("account_recovery_tokens", {
      token_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      purpose: { type: DataTypes.STRING(32), allowNull: false },
      token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      credential_revision: { type: DataTypes.INTEGER, allowNull: false },
      recovery_email_revision: { type: DataTypes.INTEGER, allowNull: false },
      pending_email_revision: { type: DataTypes.INTEGER, allowNull: true },
      recipient_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE account_recovery_tokens
         ADD CONSTRAINT account_recovery_token_user_fk FOREIGN KEY (tenant_id, user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE,
         ADD CONSTRAINT account_recovery_token_purpose_valid CHECK (purpose IN ('password_reset', 'email_verify')),
         ADD CONSTRAINT account_recovery_token_revision_valid CHECK (
           credential_revision > 0 AND recovery_email_revision >= 0
           AND ((purpose = 'password_reset' AND pending_email_revision IS NULL)
             OR (purpose = 'email_verify' AND pending_email_revision IS NOT NULL AND pending_email_revision > 0))
         ),
         ADD CONSTRAINT account_recovery_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT account_recovery_token_fingerprint_valid CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT account_recovery_token_expiry_valid CHECK (expires_at > created_at);
       CREATE INDEX account_recovery_token_user_idx ON account_recovery_tokens (tenant_id, user_id, created_at DESC);
       CREATE INDEX account_recovery_token_active_idx ON account_recovery_tokens (expires_at)
         WHERE consumed_at IS NULL AND revoked_at IS NULL;`,
      { transaction },
    );

    await context.createTable("auth_mail_outbox", {
      mail_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      token_id: { type: DataTypes.UUID, allowNull: true },
      purpose: { type: DataTypes.STRING(40), allowNull: false },
      payload_ciphertext: { type: DataTypes.BLOB, allowNull: true },
      payload_nonce: { type: DataTypes.BLOB, allowNull: true },
      payload_auth_tag: { type: DataTypes.BLOB, allowNull: true },
      key_version: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      next_attempt_at: { type: DataTypes.DATE, allowNull: false },
      lease_until: { type: DataTypes.DATE, allowNull: true },
      lease_owner: { type: DataTypes.STRING(80), allowNull: true },
      provider_message_id: { type: DataTypes.STRING(200), allowNull: true },
      last_error_code: { type: DataTypes.STRING(64), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      submitted_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE auth_mail_outbox
         ADD CONSTRAINT auth_mail_outbox_actor_fk FOREIGN KEY (tenant_id, user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE,
         ADD CONSTRAINT auth_mail_outbox_token_fk FOREIGN KEY (token_id)
           REFERENCES account_recovery_tokens (token_id) ON DELETE SET NULL,
         ADD CONSTRAINT auth_mail_outbox_purpose_valid CHECK (purpose IN (
           'password_reset', 'email_verify', 'password_changed_notice', 'recovery_email_changed_notice'
         )),
         ADD CONSTRAINT auth_mail_outbox_status_valid CHECK (status IN ('pending', 'processing', 'submitted', 'failed', 'cancelled')),
         ADD CONSTRAINT auth_mail_outbox_attempt_valid CHECK (attempt_count >= 0 AND key_version > 0),
         ADD CONSTRAINT auth_mail_outbox_payload_valid CHECK (
           (payload_ciphertext IS NULL AND payload_nonce IS NULL AND payload_auth_tag IS NULL)
           OR (payload_ciphertext IS NOT NULL AND octet_length(payload_nonce) = 12 AND octet_length(payload_auth_tag) = 16)
         ),
         ADD CONSTRAINT auth_mail_outbox_lease_pair CHECK ((lease_until IS NULL) = (lease_owner IS NULL)),
         ADD CONSTRAINT auth_mail_outbox_submitted_state CHECK ((status = 'submitted') = (submitted_at IS NOT NULL));
       CREATE UNIQUE INDEX auth_mail_outbox_token_uidx ON auth_mail_outbox (token_id) WHERE token_id IS NOT NULL;
       CREATE INDEX auth_mail_outbox_due_idx ON auth_mail_outbox (next_attempt_at, created_at)
         WHERE status IN ('pending', 'processing');
       CREATE INDEX auth_mail_outbox_user_idx ON auth_mail_outbox (tenant_id, user_id, created_at DESC);`,
      { transaction },
    );

    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.addConstraint("audit_events", {
      fields: ["action"], type: "check", name: "audit_event_action_valid",
      where: { action: { [Op.in]: auditActions } }, transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("ACCOUNT_RECOVERY_TOKENS_AND_AUTH_MAIL_ARE_NOT_SAFE_TO_REVERSE");
}
