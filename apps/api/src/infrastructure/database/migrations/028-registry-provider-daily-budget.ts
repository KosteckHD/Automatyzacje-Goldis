import { DataTypes, type QueryInterface } from "sequelize";

/** Persistent provider quota shared by all tenants and worker replicas. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("registry_provider_daily_budgets", {
      provider_name: { type: DataTypes.STRING(60), allowNull: false },
      usage_date: { type: DataTypes.DATEONLY, allowNull: false },
      daily_limit: { type: DataTypes.INTEGER, allowNull: false },
      reserved_requests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE registry_provider_daily_budgets
         ADD CONSTRAINT registry_provider_daily_budgets_pk PRIMARY KEY (provider_name, usage_date),
         ADD CONSTRAINT registry_provider_daily_budgets_provider_valid CHECK (provider_name ~ '^[a-z0-9-]{1,60}$'),
         ADD CONSTRAINT registry_provider_daily_budgets_limit_valid CHECK (daily_limit BETWEEN 1 AND 10000),
         ADD CONSTRAINT registry_provider_daily_budgets_reserved_valid CHECK (reserved_requests BETWEEN 0 AND daily_limit);
       CREATE INDEX registry_provider_daily_budgets_date_idx ON registry_provider_daily_budgets (usage_date);`,
      { transaction },
    );
    await context.createTable("enrichment_worker_runtime_status", {
      worker_id: { type: DataTypes.STRING(80), primaryKey: true },
      status: { type: DataTypes.STRING(12), allowNull: false },
      provider_name: { type: DataTypes.STRING(60), allowNull: true },
      observed_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE enrichment_worker_runtime_status
         ADD CONSTRAINT enrichment_worker_runtime_status_valid CHECK (status IN ('disabled', 'ready', 'degraded')),
         ADD CONSTRAINT enrichment_worker_provider_valid CHECK (provider_name IS NULL OR provider_name ~ '^[a-z0-9-]{1,60}$');
       CREATE INDEX enrichment_worker_runtime_observed_idx ON enrichment_worker_runtime_status (observed_at DESC);`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("REGISTRY_PROVIDER_RUNTIME_AND_BUDGET_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
