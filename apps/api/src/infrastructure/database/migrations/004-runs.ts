import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.createTable("automation_runs", {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    batch_id: { type: DataTypes.UUID, allowNull: false, references: { model: "import_batches", key: "id" }, onDelete: "CASCADE" },
    source_row_id: { type: DataTypes.UUID, allowNull: false, references: { model: "source_rows", key: "id" }, onDelete: "CASCADE" },
    row_number: { type: DataTypes.INTEGER, allowNull: false },
    tool_id: { type: DataTypes.STRING(80), allowNull: false },
    status: { type: DataTypes.STRING(40), allowNull: false },
    current_step: { type: DataTypes.STRING(80), allowNull: false },
    reference_date: { type: DataTypes.DATEONLY, allowNull: false },
    error_code: { type: DataTypes.STRING(80), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex("automation_runs", ["batch_id", "row_number", "created_at"], { name: "automation_runs_batch_row_idx" });
  await context.sequelize.query(`CREATE UNIQUE INDEX automation_runs_active_row_unique ON automation_runs (source_row_id)
    WHERE status IN ('queued', 'validating', 'awaiting_portal_adapter')`);
  await context.createTable("run_events", {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    run_id: { type: DataTypes.UUID, allowNull: false, references: { model: "automation_runs", key: "id" }, onDelete: "CASCADE" },
    status: { type: DataTypes.STRING(40), allowNull: false },
    step: { type: DataTypes.STRING(80), allowNull: false },
    error_code: { type: DataTypes.STRING(80), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex("run_events", ["run_id", "created_at"], { name: "run_events_run_time_idx" });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable("run_events");
  await context.dropTable("automation_runs");
}
