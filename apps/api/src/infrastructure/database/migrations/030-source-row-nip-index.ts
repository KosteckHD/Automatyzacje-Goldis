import type { QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `CREATE INDEX source_rows_batch_nip_normalized_idx
         ON source_rows (batch_id, (regexp_replace(nip_raw, '[[:space:]-]', '', 'g')))
         WHERE nip_raw <> ''`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query("DROP INDEX source_rows_batch_nip_normalized_idx", { transaction });
  });
}
