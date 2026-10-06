import type { QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query("UPDATE source_rows SET issues = issues - 'DECISION_MAKER_REIMPORT_REQUIRED' WHERE issues @> '[\"DECISION_MAKER_REIMPORT_REQUIRED\"]'::jsonb");
  await context.sequelize.query("UPDATE import_batches b SET invalid_rows = (SELECT COUNT(*) FROM source_rows r WHERE r.batch_id = b.id AND jsonb_array_length(r.issues) > 0)");
}

export async function down(): Promise<void> {
  // No rollback: previously imported rows also remain valid without a decision maker.
}
