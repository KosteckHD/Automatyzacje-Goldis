import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("run_identities", {
      run_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: "automation_runs", key: "id" },
        onDelete: "CASCADE",
      },
      source_row_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "source_rows", key: "id" },
        onDelete: "CASCADE",
      },
      regon: { type: DataTypes.STRING(14), allowNull: false },
      company_name: { type: DataTypes.TEXT, allowNull: false },
      first_name: { type: DataTypes.TEXT, allowNull: false },
      last_name: { type: DataTypes.TEXT, allowNull: false },
      pesel_ciphertext: { type: DataTypes.TEXT, allowNull: false },
      pesel_key_version: { type: DataTypes.INTEGER, allowNull: false },
      match_method: { type: DataTypes.STRING(80), allowNull: false },
      adapter_version: { type: DataTypes.STRING(80), allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });

    await context.createTable("oc_snapshots", {
      run_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: "automation_runs", key: "id" },
        onDelete: "CASCADE",
      },
      total_count: { type: DataTypes.INTEGER, allowNull: false },
      captured_at: { type: DataTypes.DATE, allowNull: false },
      parser_version: { type: DataTypes.STRING(80), allowNull: false },
    }, { transaction });

    await context.createTable("oc_policies", {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      run_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "automation_runs", key: "id" },
        onDelete: "CASCADE",
      },
      source_ordinal: { type: DataTypes.INTEGER, allowNull: false },
      insured_name: { type: DataTypes.TEXT, allowNull: true },
      policy_type_and_number: { type: DataTypes.TEXT, allowNull: false },
      contract_type: { type: DataTypes.TEXT, allowNull: true },
      insured_claim_count: { type: DataTypes.INTEGER, allowNull: true },
      vehicle_registration: { type: DataTypes.TEXT, allowNull: true },
      vehicle_group: { type: DataTypes.TEXT, allowNull: true },
      vehicle_make: { type: DataTypes.TEXT, allowNull: true },
      vehicle_model: { type: DataTypes.TEXT, allowNull: true },
      insurer: { type: DataTypes.TEXT, allowNull: true },
      coverage_from: { type: DataTypes.DATEONLY, allowNull: true },
      coverage_to: { type: DataTypes.DATEONLY, allowNull: false },
    }, { transaction });

    await context.addIndex("oc_policies", ["run_id", "source_ordinal"], {
      name: "oc_policies_run_ordinal_unique",
      unique: true,
      transaction,
    });
    await context.addIndex("oc_policies", ["run_id", "coverage_to"], {
      name: "oc_policies_run_coverage_end_idx",
      transaction,
    });
    await context.sequelize.query(
      "ALTER TABLE oc_snapshots ADD CONSTRAINT oc_snapshots_total_count_nonnegative CHECK (total_count >= 0)",
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("oc_policies", { transaction });
    await context.dropTable("oc_snapshots", { transaction });
    await context.dropTable("run_identities", { transaction });
  });
}
