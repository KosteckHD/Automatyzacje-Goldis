import type { QueryInterface } from "sequelize";

/** Keeps durable jobs constrained to the two scopes that have complete executors today. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `ALTER TABLE deletion_jobs DROP CONSTRAINT deletion_jobs_target_valid;
       ALTER TABLE deletion_jobs ADD CONSTRAINT deletion_jobs_target_valid
         CHECK (target_type IN ('artifact', 'run') AND target_id IS NOT NULL);`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_JOB_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
