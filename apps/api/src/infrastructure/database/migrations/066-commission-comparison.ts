import { Op, DataTypes, type QueryInterface } from "sequelize";

const commissionAuditActions = [
  "commission.file.uploaded", "commission.file.deleted", "commission.dictionary.imported",
  "commission.dictionary.edited", "commission.dictionary.published", "commission.dictionary.activated",
  "commission.dictionary.grant.updated", "commission.run.created", "commission.run.started",
  "commission.run.completed", "commission.run.failed", "commission.run.cancel_requested",
  "commission.run.cancelled", "commission.resolution.created", "commission.export.created",
  "commission.export.downloaded",
];

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `INSERT INTO tools (tool_id, display_name, description, status, sort_order, created_at, updated_at)
       VALUES ('commission-comparison', 'Porównywarka prowizji',
         'Porównuje rozliczenia ASF i Warty z listą polis CRM oraz wersją słownika prowizji.',
         'available', 20, now(), now())`,
      { transaction },
    );

    await context.createTable("commission_agents", {
      tenant_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE" },
      agent_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      agent_key: { type: DataTypes.STRING(40), allowNull: false },
      display_name: { type: DataTypes.STRING(120), allowNull: false },
      aliases: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_agents
         ADD CONSTRAINT commission_agents_key_valid CHECK (agent_key ~ '^[a-z0-9_-]{1,40}$'),
         ADD CONSTRAINT commission_agents_display_name_valid CHECK (length(display_name) BETWEEN 1 AND 120),
         ADD CONSTRAINT commission_agents_tenant_key_unique UNIQUE (tenant_id, agent_key),
         ADD CONSTRAINT commission_agents_tenant_id_unique UNIQUE (tenant_id, agent_id)` ,
      { transaction },
    );
    await context.sequelize.query(
      `INSERT INTO commission_agents (tenant_id, agent_id, agent_key, display_name, aliases, is_active, created_at, updated_at)
       SELECT t.tenant_id, gen_random_uuid(), seed.agent_key, seed.display_name, seed.aliases::jsonb, true, now(), now()
         FROM tenants t CROSS JOIN (VALUES
           ('ola', 'Ola', '["ALEKSANDRA CYBULSKA", "CYBULSKA ALEKSANDRA"]'),
           ('maciek', 'Maciek', '["MACIEJ BĄCZKOWSKI", "BĄCZKOWSKI MACIEJ"]')
         ) AS seed(agent_key, display_name, aliases)
       ON CONFLICT (tenant_id, agent_key) DO NOTHING`,
      { transaction },
    );

    await context.createTable("commission_files", {
      file_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE" },
      source_type: { type: DataTypes.STRING(20), allowNull: false },
      file_name: { type: DataTypes.STRING(255), allowNull: false },
      storage_key: { type: DataTypes.STRING(120), allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      validation_state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
      row_count: { type: DataTypes.INTEGER, allowNull: true },
      parser_version: { type: DataTypes.STRING(80), allowNull: true },
      uploaded_by: { type: DataTypes.UUID, allowNull: false },
      uploaded_at: { type: DataTypes.DATE, allowNull: false },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_files
         ADD CONSTRAINT commission_files_source_valid CHECK (source_type IN ('CRM', 'ASF', 'WARTA', 'DICTIONARY')),
         ADD CONSTRAINT commission_files_validation_valid CHECK (validation_state IN ('pending', 'ready', 'rejected', 'deleted')),
         ADD CONSTRAINT commission_files_sha_valid CHECK (sha256 ~ '^[a-f0-9]{64}$'),
         ADD CONSTRAINT commission_files_size_valid CHECK (size_bytes BETWEEN 1 AND 16777216),
         ADD CONSTRAINT commission_files_storage_key_valid CHECK (storage_key ~ '^commission-files/[0-9a-f-]{36}\\.blob$'),
         ADD CONSTRAINT commission_files_tenant_file_unique UNIQUE (tenant_id, file_id),
         ADD CONSTRAINT commission_files_upload_membership_fk FOREIGN KEY (tenant_id, uploaded_by)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT` ,
      { transaction },
    );
    await context.addIndex("commission_files", ["tenant_id", "source_type", "uploaded_at"], { name: "commission_files_tenant_source_idx", transaction });
    await context.addIndex("commission_files", ["tenant_id", "sha256"], { name: "commission_files_tenant_hash_idx", transaction });

    await context.createTable("commission_dictionary_versions", {
      dictionary_version_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE" },
      version_number: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "draft" },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      source_file_id: { type: DataTypes.UUID, allowNull: true },
      snapshot_ciphertext: { type: DataTypes.BLOB, allowNull: false },
      snapshot_sha256: { type: DataTypes.STRING(64), allowNull: false },
      entry_count: { type: DataTypes.INTEGER, allowNull: false },
      previous_version_id: { type: DataTypes.UUID, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: false },
      published_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      published_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_dictionary_versions
         ADD CONSTRAINT commission_dictionary_version_number_valid CHECK (version_number > 0),
         ADD CONSTRAINT commission_dictionary_status_valid CHECK (status IN ('draft', 'published', 'archived')),
         ADD CONSTRAINT commission_dictionary_active_valid CHECK (NOT is_active OR status = 'published'),
         ADD CONSTRAINT commission_dictionary_revision_valid CHECK (revision > 0),
         ADD CONSTRAINT commission_dictionary_hash_valid CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
         ADD CONSTRAINT commission_dictionary_entries_valid CHECK (entry_count BETWEEN 0 AND 100000),
         ADD CONSTRAINT commission_dictionary_tenant_version_unique UNIQUE (tenant_id, version_number),
         ADD CONSTRAINT commission_dictionary_tenant_id_unique UNIQUE (tenant_id, dictionary_version_id),
         ADD CONSTRAINT commission_dictionary_creator_fk FOREIGN KEY (tenant_id, created_by)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT commission_dictionary_publisher_fk FOREIGN KEY (tenant_id, published_by)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT commission_dictionary_source_file_fk FOREIGN KEY (tenant_id, source_file_id)
           REFERENCES commission_files(tenant_id, file_id) ON DELETE RESTRICT,
         ADD CONSTRAINT commission_dictionary_previous_fk FOREIGN KEY (tenant_id, previous_version_id)
           REFERENCES commission_dictionary_versions(tenant_id, dictionary_version_id) ON DELETE RESTRICT` ,
      { transaction },
    );
    await context.addIndex("commission_dictionary_versions", ["tenant_id", "status", "version_number"], { name: "commission_dictionary_versions_idx", transaction });
    await context.sequelize.query(
      "CREATE UNIQUE INDEX commission_dictionary_active_tenant_idx ON commission_dictionary_versions (tenant_id) WHERE is_active = true",
      { transaction },
    );

    await context.createTable("commission_dictionary_grants", {
      tenant_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE" },
      user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      granted_by: { type: DataTypes.UUID, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_dictionary_grants
         ADD CONSTRAINT commission_dictionary_grant_member_fk FOREIGN KEY (tenant_id, user_id)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
         ADD CONSTRAINT commission_dictionary_grant_granter_fk FOREIGN KEY (tenant_id, granted_by)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT`,
      { transaction },
    );

    await context.createTable("commission_runs", {
      run_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE" },
      owner_user_id: { type: DataTypes.UUID, allowNull: false },
      start_date: { type: DataTypes.DATEONLY, allowNull: false },
      end_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: { type: DataTypes.STRING(28), allowNull: false, defaultValue: "queued" },
      progress_stage: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "queued" },
      dictionary_version_id: { type: DataTypes.UUID, allowNull: false },
      engine_version: { type: DataTypes.STRING(80), allowNull: false },
      request_hash: { type: DataTypes.STRING(64), allowNull: false },
      idempotency_key: { type: DataTypes.STRING(128), allowNull: false },
      result_sha256: { type: DataTypes.STRING(64), allowNull: true },
      counters: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      active_attempt_token: { type: DataTypes.UUID, allowNull: true },
      error_code: { type: DataTypes.STRING(64), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_runs
         ADD CONSTRAINT commission_run_dates_valid CHECK (end_date >= start_date),
         ADD CONSTRAINT commission_run_status_valid CHECK (status IN ('queued', 'running', 'completed', 'completed_with_findings', 'cancel_requested', 'cancelled', 'failed')),
         ADD CONSTRAINT commission_run_hash_valid CHECK (request_hash ~ '^[a-f0-9]{64}$'),
         ADD CONSTRAINT commission_run_result_hash_valid CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
         ADD CONSTRAINT commission_run_idempotency_valid CHECK (length(idempotency_key) BETWEEN 1 AND 128),
         ADD CONSTRAINT commission_run_tenant_id_unique UNIQUE (tenant_id, run_id),
         ADD CONSTRAINT commission_run_owner_fk FOREIGN KEY (tenant_id, owner_user_id)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT commission_run_dictionary_fk FOREIGN KEY (tenant_id, dictionary_version_id)
           REFERENCES commission_dictionary_versions(tenant_id, dictionary_version_id) ON DELETE RESTRICT,
         ADD CONSTRAINT commission_run_token_unique UNIQUE (active_attempt_token)` ,
      { transaction },
    );
    await context.addIndex("commission_runs", ["tenant_id", "created_at"], { name: "commission_runs_tenant_created_idx", transaction });
    await context.addIndex("commission_runs", ["tenant_id", "status", "created_at"], { name: "commission_runs_status_created_idx", transaction });
    await context.sequelize.query(
      "CREATE UNIQUE INDEX commission_runs_idempotency_idx ON commission_runs (tenant_id, owner_user_id, idempotency_key)",
      { transaction },
    );

    await context.createTable("commission_run_files", {
      tenant_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      run_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      file_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_run_files
         ADD CONSTRAINT commission_run_files_run_fk FOREIGN KEY (tenant_id, run_id)
           REFERENCES commission_runs(tenant_id, run_id) ON DELETE CASCADE,
         ADD CONSTRAINT commission_run_files_file_fk FOREIGN KEY (tenant_id, file_id)
           REFERENCES commission_files(tenant_id, file_id) ON DELETE RESTRICT`,
      { transaction },
    );

    await context.createTable("commission_run_snapshots", {
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      run_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      snapshot_ciphertext: { type: DataTypes.BLOB, allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      record_count: { type: DataTypes.INTEGER, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_run_snapshots
         ADD CONSTRAINT commission_run_snapshot_hash_valid CHECK (sha256 ~ '^[a-f0-9]{64}$'),
         ADD CONSTRAINT commission_run_snapshot_count_valid CHECK (record_count >= 0),
         ADD CONSTRAINT commission_run_snapshot_run_fk FOREIGN KEY (tenant_id, run_id)
           REFERENCES commission_runs(tenant_id, run_id) ON DELETE CASCADE`,
      { transaction },
    );

    await context.createTable("commission_dispatches", {
      dispatch_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      run_id: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending" },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      claimed_at: { type: DataTypes.DATE, allowNull: true },
      claimed_by: { type: DataTypes.STRING(80), allowNull: true },
      next_attempt_at: { type: DataTypes.DATE, allowNull: false },
      last_error_code: { type: DataTypes.STRING(64), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_dispatches
         ADD CONSTRAINT commission_dispatch_status_valid CHECK (status IN ('pending', 'publishing', 'published', 'completed', 'failed', 'cancelled')),
         ADD CONSTRAINT commission_dispatch_attempt_valid CHECK (attempt_count >= 0),
         ADD CONSTRAINT commission_dispatch_run_fk FOREIGN KEY (tenant_id, run_id)
           REFERENCES commission_runs(tenant_id, run_id) ON DELETE CASCADE,
         ADD CONSTRAINT commission_dispatch_run_unique UNIQUE (tenant_id, run_id)`,
      { transaction },
    );
    await context.addIndex("commission_dispatches", ["status", "next_attempt_at", "created_at"], { name: "commission_dispatches_pending_idx", transaction });

    await context.createTable("commission_resolutions", {
      resolution_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      run_id: { type: DataTypes.UUID, allowNull: false },
      finding_key: { type: DataTypes.STRING(160), allowNull: false },
      decision_code: { type: DataTypes.STRING(40), allowNull: false },
      note_ciphertext: { type: DataTypes.BLOB, allowNull: true },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_resolutions
         ADD CONSTRAINT commission_resolution_run_fk FOREIGN KEY (tenant_id, run_id)
           REFERENCES commission_runs(tenant_id, run_id) ON DELETE CASCADE,
         ADD CONSTRAINT commission_resolution_actor_fk FOREIGN KEY (tenant_id, actor_user_id)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT`,
      { transaction },
    );
    await context.addIndex("commission_resolutions", ["tenant_id", "run_id", "finding_key", "created_at"], { name: "commission_resolutions_run_finding_idx", transaction });

    await context.createTable("commission_exports", {
      export_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      run_id: { type: DataTypes.UUID, allowNull: false },
      file_name: { type: DataTypes.STRING(255), allowNull: false },
      storage_key: { type: DataTypes.STRING(120), allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      state: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "ready" },
      created_by: { type: DataTypes.UUID, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE commission_exports
         ADD CONSTRAINT commission_export_hash_valid CHECK (sha256 ~ '^[a-f0-9]{64}$'),
         ADD CONSTRAINT commission_export_storage_key_valid CHECK (storage_key ~ '^artifacts/[0-9a-f-]{36}\\.xlsx$'),
         ADD CONSTRAINT commission_export_state_valid CHECK (state IN ('pending', 'ready', 'failed')),
         ADD CONSTRAINT commission_export_run_fk FOREIGN KEY (tenant_id, run_id)
           REFERENCES commission_runs(tenant_id, run_id) ON DELETE CASCADE,
         ADD CONSTRAINT commission_export_creator_fk FOREIGN KEY (tenant_id, created_by)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT`,
      { transaction },
    );
    await context.addIndex("commission_exports", ["tenant_id", "run_id", "created_at"], { name: "commission_exports_run_created_idx", transaction });

    await context.sequelize.query(
      `INSERT INTO tool_settings (tenant_id, tool_id, enabled_for_new_runs, timezone, updated_at, version)
       SELECT tenant_id, 'commission-comparison', true, 'Europe/Warsaw', now(), 1 FROM tenants
       ON CONFLICT (tenant_id, tool_id) DO NOTHING`,
      { transaction },
    );

    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.addConstraint("audit_events", {
      fields: ["action"], type: "check", name: "audit_event_action_valid",
      where: { action: { [Op.in]: [
        "login.succeeded", "login.failed", "logout.succeeded", "session.revoked", "password.changed",
        "import.created", "import.preparation.started", "import.preparation.completed", "import.preparation.cancelled",
        "import.preparation.workflow.started", "import.preparation.workflow.completed", "import.preparation.workflow.cancelled",
        "import.preparation.workflow.failed", "run.created", "run.cancelled", "run.auth_resumed", "run.review_resumed",
        "run.manual_data_corrected", "run.pause_requested", "run.resumed_from_pause", "run.submission.created",
        "run.submission.cancelled", "run.submission.paused", "run.submission.resumed", "run.submission.group_admitted",
        "run.prepared_set.created", "run.prepared_set.completed", "run.prepared_set.cancelled", "run.prepared_set.failed",
        "run.prepared_set.pause_requested", "run.prepared_set.resumed", "lead.allocated", "lead.status.updated",
        "lead.assignment.released", "sms.submitted", "regon.correction.proposed", "regon.correction.reviewed",
        "entity.conflict.reviewed", "enrichment.job.created", "enrichment.job.cancelled", "enrichment.job.completed",
        "artifact.downloaded", "result_set.exported", "user.created", "user.updated", "user.deletion_grant.updated",
        "deletion.step_up.granted", "deletion.preview.created", "deletion.job.created", "deletion.job.completed",
        "deletion.job.failed", "tool.grant.created", "tool.grant.updated", "tool.grant.revoked", "intervention.assigned",
        "intervention.unassigned", "intervention.priority_changed", "intervention.resolved", "settings.updated",
        "privileged_action.confirmed", "auth.recovery.requested", "auth.recovery.completed", "auth.recovery.email.requested",
        "auth.recovery.email.verified", "auth.recovery.email.changed", "auth.recovery.admin_link.requested",
        ...commissionAuditActions,
      ] } }, transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("COMMISSION_COMPARISON_MIGRATION_CONTAINS_VERSIONED_BUSINESS_DATA_AND_IS_NOT_SAFE_TO_REVERSE");
}
