import { type QueryInterface } from "sequelize";

/** Keeps the run snapshot backward compatible while freezing imported contact fields for new runs. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("automation_runs", "automation_runs_input_snapshot_valid", { transaction });
    await context.sequelize.query(
      `CREATE OR REPLACE FUNCTION goldis_populate_run_input_snapshot() RETURNS trigger AS $$
       BEGIN
         IF NEW.input_snapshot IS NULL OR jsonb_typeof(NEW.input_snapshot) <> 'object'
           OR COALESCE(NEW.input_snapshot->>'schemaVersion', '') NOT IN ('1', '2')
           OR COALESCE(NEW.input_snapshot->>'sourceRowId', '') <> NEW.source_row_id::text THEN
           SELECT jsonb_build_object(
             'schemaVersion', 1, 'sourceRowId', source.id, 'rowNumber', source.row_number,
             'rowVersion', source.row_version, 'companyName', source.company_name,
             'decisionMakerName', source.decision_maker_name, 'nipRaw', source.nip_raw,
             'address', source.address, 'postalCode', source.postal_code, 'city', source.city,
             'countyCode', source.county_code, 'regonRaw', source.regon_raw, 'regon', source.regon,
             'effectiveRegon', source.effective_regon, 'issues', source.issues
           ) INTO NEW.input_snapshot FROM source_rows source WHERE source.id = NEW.source_row_id;
           IF NEW.input_snapshot IS NULL THEN RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_UNAVAILABLE'; END IF;
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;
       ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_input_snapshot_valid CHECK
         (jsonb_typeof(input_snapshot) = 'object'
           AND input_snapshot->>'schemaVersion' IN ('1', '2')
           AND input_snapshot->>'sourceRowId' = source_row_id::text
           AND (input_snapshot->>'rowNumber') ~ '^[0-9]+$'
           AND jsonb_typeof(input_snapshot->'companyName') = 'string'
           AND jsonb_typeof(input_snapshot->'issues') = 'array'
           AND (input_snapshot->>'schemaVersion' = '1' OR
             (jsonb_typeof(input_snapshot->'mobile') = 'string'
               AND jsonb_typeof(input_snapshot->'phone') = 'string'
               AND jsonb_typeof(input_snapshot->'email') = 'string'
               AND jsonb_typeof(input_snapshot->'decisionMakerName') = 'string' AND length(trim(input_snapshot->>'decisionMakerName')) > 0)));` ,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("RUN_INPUT_SNAPSHOT_CONTACT_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
