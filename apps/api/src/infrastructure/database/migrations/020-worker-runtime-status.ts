import { DataTypes, type QueryInterface } from "sequelize";

/** Contains only process health metadata; never store browser paths or portal credentials here. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("worker_runtime_status", {
      worker_id: { type: DataTypes.STRING(80), primaryKey: true },
      mode: { type: DataTypes.STRING(8), allowNull: false },
      portal_config_valid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      observed_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE worker_runtime_status
         ADD CONSTRAINT worker_runtime_status_mode_valid CHECK (mode IN ('off', 'live'));
       CREATE INDEX worker_runtime_status_observed_idx ON worker_runtime_status (observed_at DESC);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable("worker_runtime_status");
}
