import { DataTypes, type QueryInterface } from "sequelize";

/** Durable per-provider request spacing and shared Retry-After cooldowns. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("registry_provider_request_pacing", {
      provider_name: { type: DataTypes.STRING(60), primaryKey: true, allowNull: false },
      min_interval_ms: { type: DataTypes.INTEGER, allowNull: false },
      next_allowed_at: { type: DataTypes.DATE, allowNull: false },
      cooldown_until: { type: DataTypes.DATE, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE registry_provider_request_pacing
         ADD CONSTRAINT registry_provider_request_pacing_provider_valid CHECK (provider_name ~ '^[a-z0-9-]{1,60}$'),
         ADD CONSTRAINT registry_provider_request_pacing_interval_valid CHECK (min_interval_ms BETWEEN 1 AND 60000)`,
      { transaction },
    );
    await context.addIndex("registry_provider_request_pacing", ["next_allowed_at"], {
      name: "registry_provider_request_pacing_next_idx",
      transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("REGISTRY_REQUEST_PACING_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
