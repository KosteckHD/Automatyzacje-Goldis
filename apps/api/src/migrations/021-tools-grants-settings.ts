import { DataTypes, type QueryInterface } from "sequelize";

const firstToolId = "oc-policy-verification";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("tools", {
      tool_id: { type: DataTypes.STRING(80), primaryKey: true, allowNull: false },
      display_name: { type: DataTypes.STRING(160), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "available" },
      sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE tools ADD CONSTRAINT tools_status_valid CHECK (status IN ('available', 'maintenance', 'disabled'));
       ALTER TABLE tools ADD CONSTRAINT tools_id_valid CHECK (tool_id ~ '^[a-z0-9][a-z0-9-]{1,79}$');`,
      { transaction },
    );
    await context.sequelize.query(
      `INSERT INTO tools (tool_id, display_name, description, status, sort_order, created_at, updated_at)
       VALUES ($1, 'Weryfikacja polis OC', 'Weryfikacja polis OC na podstawie zaimportowanej bazy.', 'available', 10, now(), now())`,
      { bind: [firstToolId], transaction },
    );

    await context.addColumn("import_batches", "tool_id", {
      type: DataTypes.STRING(80), allowNull: true,
    }, { transaction });
    await context.sequelize.query(
      `DO $$ BEGIN
         IF EXISTS (
           SELECT batch_id FROM automation_runs GROUP BY batch_id HAVING count(DISTINCT tool_id) > 1
         ) THEN RAISE EXCEPTION 'TOOL_MIGRATION_BATCH_HAS_MULTIPLE_TOOLS'; END IF;
         IF EXISTS (
           SELECT 1 FROM automation_runs r LEFT JOIN tools t ON t.tool_id = r.tool_id WHERE t.tool_id IS NULL
         ) THEN RAISE EXCEPTION 'TOOL_MIGRATION_UNKNOWN_TOOL'; END IF;
       END $$`,
      { transaction },
    );
    await context.sequelize.query(
      `UPDATE import_batches b
          SET tool_id = COALESCE((SELECT min(r.tool_id) FROM automation_runs r WHERE r.batch_id = b.id), $1)
        WHERE b.tool_id IS NULL`,
      { bind: [firstToolId], transaction },
    );
    await context.sequelize.query(
      `ALTER TABLE import_batches ALTER COLUMN tool_id SET NOT NULL;
       ALTER TABLE import_batches ADD CONSTRAINT import_batches_tool_fk
         FOREIGN KEY (tool_id) REFERENCES tools(tool_id) ON DELETE RESTRICT;
       ALTER TABLE import_batches ADD CONSTRAINT import_batches_id_tool_unique UNIQUE (id, tool_id);
       ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_batch_tool_fk
         FOREIGN KEY (batch_id, tool_id) REFERENCES import_batches(id, tool_id) ON DELETE CASCADE`,
      { transaction },
    );
    await context.addIndex("import_batches", ["tenant_id", "tool_id", "owner_user_id", "created_at"], {
      name: "import_batches_tool_owner_created_idx", transaction,
    });
    await context.addIndex("automation_runs", ["tool_id", "status", "created_at"], {
      name: "automation_runs_tool_status_created_idx", transaction,
    });

    await context.createTable("tool_grants", {
      tenant_id: {
        type: DataTypes.UUID, allowNull: false, primaryKey: true,
        references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE",
      },
      tool_id: {
        type: DataTypes.STRING(80), allowNull: false, primaryKey: true,
        references: { model: "tools", key: "tool_id" }, onDelete: "CASCADE",
      },
      user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      can_discover: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      can_execute: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      can_view_results: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      can_download_results: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      granted_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE tool_grants
         ADD CONSTRAINT tool_grants_membership_fk FOREIGN KEY (tenant_id, user_id)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
         ADD CONSTRAINT tool_grants_granter_membership_fk FOREIGN KEY (tenant_id, granted_by)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT tool_grants_implications CHECK
           ((NOT can_execute OR can_discover) AND (NOT can_download_results OR can_view_results)),
         ADD CONSTRAINT tool_grants_version_valid CHECK (version > 0)` ,
      { transaction },
    );
    await context.addIndex("tool_grants", ["tenant_id", "user_id", "tool_id"], {
      name: "tool_grants_user_tool_idx", transaction,
    });

    // Preserve access already implied by the existing role and ownership model.
    await context.sequelize.query(
      `INSERT INTO tool_grants
         (tenant_id, tool_id, user_id, can_discover, can_execute, can_view_results, can_download_results,
          granted_by, created_at, updated_at, version)
       SELECT m.tenant_id, $1, m.user_id,
              true,
              m.role = 'operator',
              true,
              m.role = 'operator',
              NULL, now(), now(), 1
         FROM tenant_memberships m
        WHERE m.status = 'active' AND m.role IN ('operator', 'reviewer')
       ON CONFLICT (tenant_id, tool_id, user_id) DO NOTHING`,
      { bind: [firstToolId], transaction },
    );

    await context.createTable("tool_settings", {
      tenant_id: {
        type: DataTypes.UUID, allowNull: false, primaryKey: true,
        references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE",
      },
      tool_id: {
        type: DataTypes.STRING(80), allowNull: false, primaryKey: true,
        references: { model: "tools", key: "tool_id" }, onDelete: "CASCADE",
      },
      enabled_for_new_runs: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      max_new_runs_per_hour: { type: DataTypes.INTEGER, allowNull: true },
      allowed_local_start: { type: DataTypes.TIME, allowNull: true },
      allowed_local_end: { type: DataTypes.TIME, allowNull: true },
      timezone: { type: DataTypes.STRING(80), allowNull: false, defaultValue: "Europe/Warsaw" },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE tool_settings
         ADD CONSTRAINT tool_settings_tool_fk FOREIGN KEY (tool_id)
           REFERENCES tools(tool_id) ON DELETE CASCADE,
         ADD CONSTRAINT tool_settings_limit_valid CHECK (max_new_runs_per_hour IS NULL OR max_new_runs_per_hour BETWEEN 1 AND 10000),
         ADD CONSTRAINT tool_settings_window_pair CHECK ((allowed_local_start IS NULL) = (allowed_local_end IS NULL)),
         ADD CONSTRAINT tool_settings_version_valid CHECK (version > 0),
         ADD CONSTRAINT tool_settings_timezone_valid CHECK (length(timezone) BETWEEN 1 AND 80)` ,
      { transaction },
    );
    await context.sequelize.query(
      `INSERT INTO tool_settings (tenant_id, tool_id, enabled_for_new_runs, timezone, updated_at, version)
       SELECT tenant_id, $1, true, 'Europe/Warsaw', now(), 1 FROM tenants
       ON CONFLICT (tenant_id, tool_id) DO NOTHING`,
      { bind: [firstToolId], transaction },
    );

    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
         'login.succeeded', 'login.failed', 'logout.succeeded', 'session.revoked', 'password.changed',
         'import.created', 'run.created', 'run.cancelled', 'run.auth_resumed', 'run.review_resumed',
         'run.manual_data_corrected', 'sms.submitted', 'regon.correction.proposed', 'regon.correction.reviewed',
         'entity.conflict.reviewed', 'artifact.downloaded', 'user.created', 'user.updated',
         'tool.grant.created', 'tool.grant.updated', 'tool.grant.revoked', 'intervention.assigned',
         'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved', 'settings.updated'
       ))`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("audit_events", "audit_event_action_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
         'login.succeeded', 'login.failed', 'import.created', 'run.created', 'run.cancelled',
         'sms.submitted', 'regon.correction.proposed', 'regon.correction.reviewed',
         'entity.conflict.reviewed', 'artifact.downloaded', 'user.created', 'user.updated'
       ))`,
      { transaction },
    );
    await context.dropTable("tool_settings", { transaction });
    await context.dropTable("tool_grants", { transaction });
    await context.removeConstraint("automation_runs", "automation_runs_batch_tool_fk", { transaction });
    await context.removeConstraint("import_batches", "import_batches_id_tool_unique", { transaction });
    await context.removeConstraint("import_batches", "import_batches_tool_fk", { transaction });
    await context.removeIndex("automation_runs", "automation_runs_tool_status_created_idx", { transaction });
    await context.removeIndex("import_batches", "import_batches_tool_owner_created_idx", { transaction });
    await context.removeColumn("import_batches", "tool_id", { transaction });
    await context.dropTable("tools", { transaction });
  });
}
