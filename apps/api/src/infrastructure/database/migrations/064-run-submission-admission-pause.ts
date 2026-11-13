import { QueryTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `ALTER TABLE run_submissions DROP CONSTRAINT run_submissions_status_valid;
       ALTER TABLE run_submissions ADD CONSTRAINT run_submissions_status_valid
         CHECK (status IN ('queued', 'running', 'waiting_attention', 'paused', 'completed', 'cancelled'));`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    const pausedRows = await context.sequelize.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM run_submissions WHERE status = 'paused') AS present",
      { type: QueryTypes.SELECT, transaction },
    );
    if (pausedRows[0]?.present) throw new Error("Cannot remove submission pause support while a submission is paused");
    await context.sequelize.query(
      `ALTER TABLE run_submissions DROP CONSTRAINT run_submissions_status_valid;
       ALTER TABLE run_submissions ADD CONSTRAINT run_submissions_status_valid
         CHECK (status IN ('queued', 'running', 'waiting_attention', 'completed', 'cancelled'));`,
      { transaction },
    );
  });
}
