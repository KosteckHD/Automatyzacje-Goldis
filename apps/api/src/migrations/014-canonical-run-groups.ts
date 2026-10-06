import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("source_entity_links", "source_entity_link_method_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE source_entity_links ADD CONSTRAINT source_entity_link_method_valid
       CHECK (match_method IN ('nip_regon_exact', 'registry_verified', 'identifier_and_name_exact', 'manual'))`,
      { transaction },
    );
    await context.createTable("entity_grouping_conflicts", {
      conflict_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      source_row_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "source_rows", key: "id" }, onDelete: "CASCADE",
      },
      reason_code: { type: DataTypes.STRING(80), allowNull: false },
      candidate_entity_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "open" },
      resolution_note: { type: DataTypes.TEXT, allowNull: true },
      resolved_by: { type: DataTypes.STRING(128), allowNull: true },
      resolved_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE entity_grouping_conflicts
         ADD CONSTRAINT entity_grouping_conflict_reason_valid CHECK (
           reason_code IN ('INVALID_NIP', 'INVALID_REGON', 'IDENTIFIER_MISSING', 'SOURCE_NAME_MISSING',
             'CANONICAL_IDENTITY_INVALID', 'SAME_NIP_DIFFERENT_REGON', 'SAME_REGON_DIFFERENT_NIP',
             'NAME_MISMATCH', 'MULTIPLE_CANONICAL_MATCHES', 'SOURCE_LINK_MISMATCH')
         ),
         ADD CONSTRAINT entity_grouping_candidate_ids_array CHECK (jsonb_typeof(candidate_entity_ids) = 'array'),
         ADD CONSTRAINT entity_grouping_status_valid CHECK (status IN ('open', 'resolved')),
         ADD CONSTRAINT entity_grouping_resolution_state_valid CHECK (
           (status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL)
           OR (status = 'resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
         )`,
      { transaction },
    );
    await context.addIndex("entity_grouping_conflicts", ["source_row_id", "created_at"], {
      name: "entity_grouping_conflicts_source_created_idx", transaction,
    });
    await context.addIndex("entity_grouping_conflicts", ["source_row_id"], {
      name: "entity_grouping_one_open_conflict_per_source", unique: true, where: { status: "open" }, transaction,
    });

    await context.addColumn("automation_runs", "canonical_entity_id", {
      type: DataTypes.UUID, allowNull: true,
      references: { model: "canonical_entities", key: "canonical_entity_id" }, onDelete: "RESTRICT",
    }, { transaction });
    await context.addColumn("automation_runs", "lead_identity_key", { type: DataTypes.STRING(64), allowNull: true }, { transaction });
    await context.sequelize.query(
      `UPDATE automation_runs run SET canonical_entity_id = link.canonical_entity_id
       FROM source_entity_links link WHERE run.source_row_id = link.source_row_id`,
      { transaction },
    );
    await context.sequelize.query(
      `ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_lead_identity_key_valid
       CHECK (lead_identity_key IS NULL OR lead_identity_key ~ '^[0-9a-f]{64}$')`,
      { transaction },
    );
    await context.createTable("run_source_rows", {
      run_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "automation_runs", key: "id" }, onDelete: "CASCADE",
      },
      source_row_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "source_rows", key: "id" }, onDelete: "CASCADE",
      },
      row_number: { type: DataTypes.INTEGER, allowNull: false },
      is_primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      "ALTER TABLE run_source_rows ADD CONSTRAINT run_source_rows_row_number_valid CHECK (row_number >= 2)",
      { transaction },
    );
    await context.addConstraint("run_source_rows", {
      fields: ["run_id", "source_row_id"], type: "primary key", name: "run_source_rows_pkey", transaction,
    });
    await context.addIndex("run_source_rows", ["run_id", "row_number"], {
      name: "run_source_rows_run_row_idx", unique: true, transaction,
    });
    await context.addIndex("run_source_rows", ["run_id"], {
      name: "run_source_rows_one_primary_per_run", unique: true, where: { is_primary: true }, transaction,
    });
    await context.addIndex("run_source_rows", ["source_row_id", "created_at"], {
      name: "run_source_rows_source_created_idx", transaction,
    });
    await context.sequelize.query(
      `INSERT INTO run_source_rows (run_id, source_row_id, row_number, is_primary, created_at)
       SELECT run.id, run.source_row_id, run.row_number, true, run.created_at FROM automation_runs run`,
      { transaction },
    );
    await context.sequelize.query(
      `CREATE UNIQUE INDEX automation_runs_active_group_unique
       ON automation_runs (batch_id, canonical_entity_id, lead_identity_key)
       WHERE canonical_entity_id IS NOT NULL AND lead_identity_key IS NOT NULL
         AND status NOT IN ('completed', 'failed', 'no_matching_policies', 'cancelled')`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query("DROP INDEX automation_runs_active_group_unique", { transaction });
    await context.dropTable("run_source_rows", { transaction });
    await context.removeConstraint("automation_runs", "automation_runs_lead_identity_key_valid", { transaction });
    await context.removeColumn("automation_runs", "lead_identity_key", { transaction });
    await context.removeColumn("automation_runs", "canonical_entity_id", { transaction });
    await context.dropTable("entity_grouping_conflicts", { transaction });
    await context.removeConstraint("source_entity_links", "source_entity_link_method_valid", { transaction });
    await context.sequelize.query(
      `ALTER TABLE source_entity_links ADD CONSTRAINT source_entity_link_method_valid
       CHECK (match_method IN ('nip_regon_exact', 'registry_verified', 'manual'))`,
      { transaction },
    );
  });
}
