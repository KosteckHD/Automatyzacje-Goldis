import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.addColumn("automation_runs", "schema_version", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 });
  await context.addColumn("automation_runs", "adapter_version", { type: DataTypes.STRING(80), allowNull: true });
  await context.addColumn("automation_runs", "last_safe_step", { type: DataTypes.STRING(80), allowNull: true });
  await context.addColumn("automation_runs", "external_case_ref", { type: DataTypes.TEXT, allowNull: true });
  await context.addColumn("automation_runs", "heartbeat_at", { type: DataTypes.DATE, allowNull: true });
  await context.addColumn("automation_runs", "started_at", { type: DataTypes.DATE, allowNull: true });
  await context.addColumn("automation_runs", "finished_at", { type: DataTypes.DATE, allowNull: true });
  await context.addColumn("run_events", "actor_id", { type: DataTypes.UUID, allowNull: true });
  await context.addColumn("run_events", "metadata", { type: DataTypes.JSONB, allowNull: false, defaultValue: {} });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.removeColumn("run_events", "metadata");
  await context.removeColumn("run_events", "actor_id");
  await context.removeColumn("automation_runs", "finished_at");
  await context.removeColumn("automation_runs", "started_at");
  await context.removeColumn("automation_runs", "heartbeat_at");
  await context.removeColumn("automation_runs", "external_case_ref");
  await context.removeColumn("automation_runs", "last_safe_step");
  await context.removeColumn("automation_runs", "adapter_version");
  await context.removeColumn("automation_runs", "schema_version");
}
