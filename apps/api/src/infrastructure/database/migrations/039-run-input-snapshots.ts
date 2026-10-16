import { DataTypes, type QueryInterface } from "sequelize";

/** Freeze the primary source row at run admission so worker behavior cannot drift with later edits. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("source_rows", "county_code", { type: DataTypes.TEXT, allowNull: true }, { transaction });
    await context.addColumn("automation_runs", "input_snapshot", {
      type: DataTypes.JSONB, allowNull: true,
    }, { transaction });
    await context.sequelize.query(
      `UPDATE automation_runs run SET input_snapshot = jsonb_build_object(
         'schemaVersion', 1, 'sourceRowId', source.id, 'rowNumber', source.row_number,
         'rowVersion', source.row_version, 'companyName', source.company_name,
         'decisionMakerName', source.decision_maker_name, 'nipRaw', source.nip_raw,
         'address', source.address, 'postalCode', source.postal_code, 'city', source.city,
         'countyCode', source.county_code, 'regonRaw', source.regon_raw, 'regon', source.regon,
         'effectiveRegon', source.effective_regon, 'issues', source.issues
       ) FROM source_rows source WHERE source.id = run.source_row_id AND run.input_snapshot IS NULL`,
      { transaction },
    );
    await context.changeColumn("automation_runs", "input_snapshot", {
      type: DataTypes.JSONB, allowNull: false,
    }, { transaction });
    await context.sequelize.query(
      `CREATE FUNCTION goldis_populate_run_input_snapshot() RETURNS trigger AS $$
       BEGIN
         IF NEW.input_snapshot IS NULL OR jsonb_typeof(NEW.input_snapshot) <> 'object'
           OR COALESCE(NEW.input_snapshot->>'schemaVersion', '') <> '1'
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
       CREATE TRIGGER automation_runs_input_snapshot_fill
         BEFORE INSERT OR UPDATE OF source_row_id, input_snapshot ON automation_runs
         FOR EACH ROW EXECUTE FUNCTION goldis_populate_run_input_snapshot();`,
      { transaction },
    );
    await context.sequelize.query(
      `ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_input_snapshot_valid CHECK
         (jsonb_typeof(input_snapshot) = 'object' AND input_snapshot->>'schemaVersion' = '1'
           AND input_snapshot->>'sourceRowId' = source_row_id::text
           AND (input_snapshot->>'rowNumber') ~ '^[0-9]+$'
           AND jsonb_typeof(input_snapshot->'issues') = 'array');`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("RUN_INPUT_SNAPSHOT_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
