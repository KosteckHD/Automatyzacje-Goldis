import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("export_artifacts", {
      artifact_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      run_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "automation_runs", key: "id" },
        onDelete: "CASCADE",
      },
      file_name: { type: DataTypes.STRING(255), allowNull: false },
      storage_key: { type: DataTypes.TEXT, allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      policy_count: { type: DataTypes.INTEGER, allowNull: false },
      state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      ready_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });

    await context.addIndex("export_artifacts", ["storage_key"], {
      name: "export_artifacts_storage_key_unique",
      unique: true,
      transaction,
    });
    await context.addIndex("export_artifacts", ["run_id", "state"], {
      name: "export_artifacts_run_state_idx",
      transaction,
    });
    await context.sequelize.query(
      `ALTER TABLE export_artifacts
         ADD CONSTRAINT export_artifacts_policy_count_positive CHECK (policy_count > 0),
         ADD CONSTRAINT export_artifacts_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT export_artifacts_state_valid CHECK (state IN ('pending', 'ready', 'failed'))`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable("export_artifacts");
}
