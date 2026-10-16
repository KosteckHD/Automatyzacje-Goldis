import { DataTypes, type QueryInterface } from "sequelize";

/** Versioned per-run corrections. The imported source row remains immutable. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("automation_runs", "manual_data_version", {
      type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
    }, { transaction });
    await context.addColumn("manual_interventions", "field_code", {
      type: DataTypes.STRING(48), allowNull: true,
    }, { transaction });
    await context.createTable("run_manual_data_overrides", {
      run_id: {
        type: DataTypes.UUID, allowNull: false, primaryKey: true,
        references: { model: "automation_runs", key: "id" }, onDelete: "CASCADE",
      },
      version: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
      source: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "admin_correction" },
      fields: { type: DataTypes.JSONB, allowNull: false },
      reason: { type: DataTypes.STRING(300), allowNull: false },
      created_by: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "users", key: "user_id" }, onDelete: "RESTRICT",
      },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE automation_runs
         ADD CONSTRAINT automation_runs_manual_data_version_valid CHECK (manual_data_version >= 0);
       ALTER TABLE manual_interventions
         ADD CONSTRAINT manual_interventions_field_code_valid
           CHECK (field_code IS NULL OR field_code ~ '^[A-Z0-9_]{2,48}$');
       ALTER TABLE run_manual_data_overrides
         ADD CONSTRAINT run_manual_data_overrides_version_valid CHECK (version > 0),
         ADD CONSTRAINT run_manual_data_overrides_source_valid CHECK (source = 'admin_correction'),
         ADD CONSTRAINT run_manual_data_overrides_fields_valid
           CHECK (jsonb_typeof(fields) = 'object' AND fields <> '{}'::jsonb
             AND fields - ARRAY['address', 'postalCode', 'city', 'countyCode', 'expectedPersonName'] = '{}'::jsonb),
         ADD CONSTRAINT run_manual_data_overrides_reason_valid CHECK (length(btrim(reason)) BETWEEN 10 AND 300);
       CREATE INDEX run_manual_data_overrides_created_idx ON run_manual_data_overrides (created_at DESC);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("run_manual_data_overrides", { transaction });
    await context.sequelize.query(
      `ALTER TABLE manual_interventions DROP CONSTRAINT manual_interventions_field_code_valid;
       ALTER TABLE automation_runs DROP CONSTRAINT automation_runs_manual_data_version_valid;`,
      { transaction },
    );
    await context.removeColumn("manual_interventions", "field_code", { transaction });
    await context.removeColumn("automation_runs", "manual_data_version", { transaction });
  });
}
