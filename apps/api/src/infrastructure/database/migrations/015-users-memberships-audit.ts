import { DataTypes, type QueryInterface } from "sequelize";

const goldisTenantId = "00000000-0000-4000-8000-000000000001";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("tenants", {
      tenant_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      slug: { type: DataTypes.STRING(80), allowNull: false, unique: true },
      display_name: { type: DataTypes.STRING(160), allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `INSERT INTO tenants (tenant_id, slug, display_name, created_at)
       VALUES ($1, 'goldis', 'Goldis Ubezpieczenia', now())`,
      { bind: [goldisTenantId], transaction },
    );

    await context.createTable("users", {
      user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      username: { type: DataTypes.STRING(128), allowNull: false },
      username_normalized: { type: DataTypes.STRING(128), allowNull: false, unique: true },
      password_hash: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE users
         ADD CONSTRAINT users_username_valid CHECK (
           length(trim(username)) BETWEEN 1 AND 128
           AND username_normalized = lower(trim(username))
         ),
         ADD CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')),
         ADD CONSTRAINT users_password_hash_nonempty CHECK (length(trim(password_hash)) >= 32)` ,
      { transaction },
    );

    await context.createTable("tenant_memberships", {
      tenant_id: {
        type: DataTypes.UUID, primaryKey: true, allowNull: false,
        references: { model: "tenants", key: "tenant_id" }, onDelete: "CASCADE",
      },
      user_id: {
        type: DataTypes.UUID, primaryKey: true, allowNull: false,
        references: { model: "users", key: "user_id" }, onDelete: "CASCADE",
      },
      role: { type: DataTypes.STRING(20), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "active" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE tenant_memberships
         ADD CONSTRAINT tenant_memberships_role_valid CHECK (role IN ('admin', 'operator', 'reviewer', 'auditor')),
         ADD CONSTRAINT tenant_memberships_status_valid CHECK (status IN ('active', 'invited', 'disabled'))` ,
      { transaction },
    );
    await context.addIndex("tenant_memberships", ["user_id", "status"], {
      name: "tenant_memberships_user_status_idx", transaction,
    });

    await context.createTable("audit_events", {
      event_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT",
      },
      actor_user_id: {
        type: DataTypes.UUID, allowNull: true,
        references: { model: "users", key: "user_id" }, onDelete: "SET NULL",
      },
      action: { type: DataTypes.STRING(60), allowNull: false },
      resource_type: { type: DataTypes.STRING(40), allowNull: false },
      resource_id: { type: DataTypes.STRING(80), allowNull: true },
      outcome: { type: DataTypes.STRING(20), allowNull: false },
      request_ref: { type: DataTypes.STRING(80), allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `CREATE FUNCTION audit_metadata_has_sensitive_key(value jsonb)
       RETURNS boolean
       LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
       AS $$
         WITH RECURSIVE nodes(value) AS (
           SELECT $1
           UNION ALL
           SELECT child.value
           FROM nodes AS parent
           CROSS JOIN LATERAL (
             SELECT object_entry.value
             FROM jsonb_each(
               CASE WHEN jsonb_typeof(parent.value) = 'object' THEN parent.value ELSE '{}'::jsonb END
             ) AS object_entry
             UNION ALL
             SELECT array_entry.value
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(parent.value) = 'array' THEN parent.value ELSE '[]'::jsonb END
             ) AS array_entry
           ) AS child
         ), keys AS (
           SELECT lower(object_key.name) AS name
           FROM nodes
           CROSS JOIN LATERAL jsonb_object_keys(
             CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
           ) AS object_key(name)
         )
         SELECT EXISTS (
           SELECT 1 FROM keys
           WHERE name = ANY (ARRAY[
             'pesel', 'nip', 'regon', 'sms', 'smscode', 'sms_code', 'password', 'cookie', 'set-cookie',
             'token', 'access_token', 'refresh_token', 'secret', 'authorization', 'credential', 'credentials',
             'firstname', 'lastname', 'fullname', 'name', 'address', 'phone', 'email'
           ]::text[])
         )
       $$`,
      { transaction },
    );
    await context.sequelize.query(
      `ALTER TABLE audit_events
         ADD CONSTRAINT audit_event_action_valid CHECK (action IN (
           'login.succeeded', 'login.failed', 'import.created', 'run.created', 'run.cancelled',
           'sms.submitted', 'regon.correction.proposed', 'regon.correction.reviewed',
           'entity.conflict.reviewed', 'artifact.downloaded', 'user.created', 'user.updated'
         )),
         ADD CONSTRAINT audit_event_resource_valid CHECK (length(trim(resource_type)) BETWEEN 1 AND 40),
         ADD CONSTRAINT audit_event_outcome_valid CHECK (outcome IN ('succeeded', 'denied', 'failed')),
         ADD CONSTRAINT audit_event_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
         ADD CONSTRAINT audit_event_metadata_no_secrets CHECK (
           NOT audit_metadata_has_sensitive_key(metadata)
         )` ,
      { transaction },
    );
    await context.addIndex("audit_events", ["tenant_id", "created_at"], {
      name: "audit_events_tenant_created_idx", transaction,
    });
    await context.addIndex("audit_events", ["actor_user_id", "created_at"], {
      name: "audit_events_actor_created_idx", transaction,
    });
    await context.addIndex("audit_events", ["resource_type", "resource_id", "created_at"], {
      name: "audit_events_resource_created_idx", transaction,
    });

    await context.addColumn("import_batches", "tenant_id", {
      type: DataTypes.UUID, allowNull: true,
      references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT",
    }, { transaction });
    await context.addColumn("import_batches", "owner_user_id", {
      type: DataTypes.UUID, allowNull: true,
      references: { model: "users", key: "user_id" }, onDelete: "SET NULL",
    }, { transaction });
    await context.addIndex("import_batches", ["tenant_id", "owner_user_id", "created_at"], {
      name: "import_batches_owner_created_idx", transaction,
    });
    await context.sequelize.query(
      `ALTER TABLE import_batches
         ADD CONSTRAINT import_batches_owner_pair CHECK (
           (tenant_id IS NULL) = (owner_user_id IS NULL)
         ),
         ADD CONSTRAINT import_batches_owner_membership_fk
           FOREIGN KEY (tenant_id, owner_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id)
           ON DELETE RESTRICT`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("import_batches", "import_batches_owner_membership_fk", { transaction });
    await context.removeConstraint("import_batches", "import_batches_owner_pair", { transaction });
    await context.removeIndex("import_batches", "import_batches_owner_created_idx", { transaction });
    await context.removeColumn("import_batches", "owner_user_id", { transaction });
    await context.removeColumn("import_batches", "tenant_id", { transaction });
    await context.dropTable("audit_events", { transaction });
    await context.dropTable("tenant_memberships", { transaction });
    await context.dropTable("users", { transaction });
    await context.dropTable("tenants", { transaction });
    await context.sequelize.query("DROP FUNCTION audit_metadata_has_sensitive_key(jsonb)", { transaction });
  });
}
