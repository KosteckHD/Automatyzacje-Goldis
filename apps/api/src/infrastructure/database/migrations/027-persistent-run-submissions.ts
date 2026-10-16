import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addIndex("import_batches", ["tenant_id", "id"], {
      name: "import_batches_tenant_id_id_uidx", unique: true, transaction,
    });
    await context.addIndex("source_rows", ["batch_id", "id"], {
      name: "source_rows_batch_id_id_uidx", unique: true, transaction,
    });
    await context.addIndex("canonical_entities", ["tenant_id", "canonical_entity_id"], {
      name: "canonical_entities_tenant_id_id_uidx", unique: true, transaction,
    });

    await context.createTable("run_submissions", {
      submission_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      import_batch_id: { type: DataTypes.UUID, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      tool_id: { type: DataTypes.STRING(80), allowNull: false },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      idempotency_key: { type: DataTypes.STRING(128), allowNull: false },
      request_hash: { type: DataTypes.STRING(64), allowNull: false },
      reference_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "queued" },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE run_submissions
         ADD CONSTRAINT run_submissions_batch_tenant_fk
           FOREIGN KEY (tenant_id, import_batch_id) REFERENCES import_batches (tenant_id, id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_submissions_actor_membership_fk
           FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_submissions_tool_fk FOREIGN KEY (tool_id) REFERENCES tools (tool_id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_submissions_key_valid CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 128),
         ADD CONSTRAINT run_submissions_hash_valid CHECK (request_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT run_submissions_status_valid CHECK (status IN ('queued', 'running', 'waiting_attention', 'completed', 'cancelled')),
         ADD CONSTRAINT run_submissions_version_valid CHECK (version >= 1)` ,
      { transaction },
    );
    await context.addIndex("run_submissions", ["submission_id", "tenant_id"], {
      name: "run_submissions_id_tenant_uidx", unique: true, transaction,
    });
    await context.addIndex("run_submissions", ["submission_id", "import_batch_id"], {
      name: "run_submissions_id_batch_uidx", unique: true, transaction,
    });
    await context.addIndex("run_submissions", ["tenant_id", "actor_user_id", "idempotency_key"], {
      name: "run_submissions_actor_key_uidx", unique: true, transaction,
    });
    await context.addIndex("run_submissions", ["tenant_id", "created_at", "submission_id"], {
      name: "run_submissions_tenant_created_idx", transaction,
    });

    await context.createTable("run_submission_groups", {
      group_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      submission_id: { type: DataTypes.UUID, allowNull: false, references: { model: "run_submissions", key: "submission_id" }, onDelete: "CASCADE" },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      canonical_entity_id: { type: DataTypes.UUID, allowNull: false },
      lead_identity_key: { type: DataTypes.STRING(64), allowNull: false },
      run_id: { type: DataTypes.UUID, allowNull: true, references: { model: "automation_runs", key: "id" }, onDelete: "RESTRICT" },
      admission_state: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "pending" },
      reason_code: { type: DataTypes.STRING(80), allowNull: true },
      next_attempt_at: { type: DataTypes.DATE, allowNull: true },
      lease_owner: { type: DataTypes.UUID, allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE run_submission_groups
         ADD CONSTRAINT run_submission_groups_submission_tenant_fk
           FOREIGN KEY (submission_id, tenant_id) REFERENCES run_submissions (submission_id, tenant_id) ON DELETE CASCADE,
         ADD CONSTRAINT run_submission_groups_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_submission_groups_canonical_fk
           FOREIGN KEY (tenant_id, canonical_entity_id) REFERENCES canonical_entities (tenant_id, canonical_entity_id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_submission_groups_group_submission_uidx UNIQUE (group_id, submission_id),
         ADD CONSTRAINT run_submission_groups_identity_uidx UNIQUE (submission_id, canonical_entity_id, lead_identity_key),
         ADD CONSTRAINT run_submission_groups_lead_key_valid CHECK (lead_identity_key ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT run_submission_groups_state_valid CHECK (admission_state IN ('pending', 'leased', 'waiting_capacity', 'waiting_window', 'waiting_paused', 'accepted', 'blocked', 'cancelled')),
         ADD CONSTRAINT run_submission_groups_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
         ADD CONSTRAINT run_submission_groups_version_valid CHECK (version >= 1),
         ADD CONSTRAINT run_submission_groups_run_once CHECK (run_id IS NULL OR admission_state = 'accepted')` ,
      { transaction },
    );
    await context.addIndex("run_submission_groups", ["admission_state", "next_attempt_at", "lease_expires_at"], {
      name: "run_submission_groups_dispatch_idx", transaction,
    });
    await context.addIndex("run_submission_groups", ["submission_id", "created_at", "group_id"], {
      name: "run_submission_groups_submission_idx", transaction,
    });

    await context.createTable("run_submission_items", {
      item_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      submission_id: { type: DataTypes.UUID, allowNull: false },
      import_batch_id: { type: DataTypes.UUID, allowNull: false },
      source_row_id: { type: DataTypes.UUID, allowNull: false },
      group_id: { type: DataTypes.UUID, allowNull: true },
      expected_row_version: { type: DataTypes.INTEGER, allowNull: false },
      preparation_state: { type: DataTypes.STRING(16), allowNull: false },
      reason_code: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE run_submission_items
         ADD CONSTRAINT run_submission_items_submission_batch_fk FOREIGN KEY (submission_id, import_batch_id) REFERENCES run_submissions (submission_id, import_batch_id) ON DELETE CASCADE,
         ADD CONSTRAINT run_submission_items_source_fk FOREIGN KEY (import_batch_id, source_row_id) REFERENCES source_rows (batch_id, id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_submission_items_group_fk FOREIGN KEY (group_id, submission_id) REFERENCES run_submission_groups (group_id, submission_id) ON DELETE RESTRICT,
         ADD CONSTRAINT run_submission_items_pair_valid CHECK ((preparation_state = 'ready' AND group_id IS NOT NULL AND reason_code IS NULL)
           OR (preparation_state IN ('review', 'excluded') AND group_id IS NULL AND reason_code IS NOT NULL)),
         ADD CONSTRAINT run_submission_items_version_valid CHECK (expected_row_version >= 1),
         ADD CONSTRAINT run_submission_items_source_uidx UNIQUE (submission_id, source_row_id)` ,
      { transaction },
    );
    await context.addIndex("run_submission_items", ["submission_id", "created_at", "item_id"], {
      name: "run_submission_items_submission_idx", transaction,
    });
    await context.addIndex("run_submission_items", ["group_id", "source_row_id"], {
      name: "run_submission_items_group_idx", transaction,
    });

    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
         'login.succeeded', 'login.failed', 'logout.succeeded', 'session.revoked', 'password.changed',
         'import.created', 'run.created', 'run.cancelled', 'run.auth_resumed', 'run.review_resumed',
         'run.manual_data_corrected', 'run.submission.created', 'run.submission.cancelled', 'run.submission.group_admitted',
         'sms.submitted', 'regon.correction.proposed', 'regon.correction.reviewed', 'entity.conflict.reviewed',
         'enrichment.job.created', 'enrichment.job.cancelled', 'enrichment.job.completed', 'artifact.downloaded',
         'user.created', 'user.updated', 'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked',
         'intervention.assigned', 'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved', 'settings.updated'
       ))` ,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("RUN_SUBMISSION_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
