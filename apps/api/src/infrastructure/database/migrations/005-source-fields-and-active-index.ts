import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.addColumn("source_rows", "nip_raw", { type: DataTypes.TEXT, allowNull: false, defaultValue: "" });
  await context.addColumn("source_rows", "address", { type: DataTypes.TEXT, allowNull: false, defaultValue: "" });
  await context.addColumn("source_rows", "postal_code", { type: DataTypes.TEXT, allowNull: false, defaultValue: "" });
  await context.addColumn("source_rows", "city", { type: DataTypes.TEXT, allowNull: false, defaultValue: "" });
  await context.sequelize.query("DROP INDEX automation_runs_active_row_unique");
  await context.sequelize.query(`CREATE UNIQUE INDEX automation_runs_active_row_unique ON automation_runs (source_row_id)
    WHERE status NOT IN ('completed', 'failed', 'no_matching_policies')`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query("DROP INDEX automation_runs_active_row_unique");
  await context.sequelize.query(`CREATE UNIQUE INDEX automation_runs_active_row_unique ON automation_runs (source_row_id)
    WHERE status IN ('queued', 'validating', 'awaiting_portal_adapter')`);
  await context.removeColumn("source_rows", "city");
  await context.removeColumn("source_rows", "postal_code");
  await context.removeColumn("source_rows", "address");
  await context.removeColumn("source_rows", "nip_raw");
}
