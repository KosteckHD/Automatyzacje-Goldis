import type { QueryInterface } from "sequelize";

/** Unlocks standalone removal of one published workbook while retaining its run and source import. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `ALTER TABLE deletion_jobs DROP CONSTRAINT deletion_jobs_target_valid;
       ALTER TABLE deletion_jobs ADD CONSTRAINT deletion_jobs_target_valid
         CHECK (target_type IN ('artifact', 'run', 'import', 'tenant') AND target_id IS NOT NULL);`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_JOB_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
