import type { QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query("DROP INDEX automation_runs_active_row_unique");
  await context.sequelize.query(`CREATE UNIQUE INDEX automation_runs_active_row_unique ON automation_runs (source_row_id)
    WHERE status NOT IN ('completed', 'failed', 'no_matching_policies', 'cancelled')`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query("DROP INDEX automation_runs_active_row_unique");
  await context.sequelize.query(`CREATE UNIQUE INDEX automation_runs_active_row_unique ON automation_runs (source_row_id)
    WHERE status NOT IN ('completed', 'failed', 'no_matching_policies')`);
}
