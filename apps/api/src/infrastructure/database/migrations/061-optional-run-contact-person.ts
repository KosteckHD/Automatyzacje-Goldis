import { type QueryInterface } from "sequelize";

/** Contact person is optional; confirmed portal identity remains mandatory downstream. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("automation_runs", "automation_runs_input_snapshot_valid", { transaction });
    await context.sequelize.query(`ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_input_snapshot_valid CHECK
      (jsonb_typeof(input_snapshot) = 'object'
        AND input_snapshot->>'schemaVersion' IN ('1', '2')
        AND input_snapshot->>'sourceRowId' = source_row_id::text
        AND (input_snapshot->>'rowNumber') ~ '^[0-9]+$'
        AND jsonb_typeof(input_snapshot->'companyName') = 'string'
        AND jsonb_typeof(input_snapshot->'issues') = 'array'
        AND input_snapshot ? 'decisionMakerName'
        AND jsonb_typeof(input_snapshot->'decisionMakerName') IN ('string', 'null')
        AND (input_snapshot->>'schemaVersion' = '1' OR
          (jsonb_typeof(input_snapshot->'mobile') = 'string'
            AND jsonb_typeof(input_snapshot->'phone') = 'string'
            AND jsonb_typeof(input_snapshot->'email') = 'string')))`, { transaction });
  });
}

export async function down(): Promise<void> {
  throw new Error("OPTIONAL_CONTACT_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
