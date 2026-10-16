import type { QueryInterface } from "sequelize";

/** Manual-recovery tombstones stay closed to writes and reads until reconciliation succeeds. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `CREATE OR REPLACE FUNCTION reject_tombstoned_import_write() RETURNS trigger
       LANGUAGE plpgsql AS $$
       DECLARE import_id uuid;
       BEGIN
         IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
         IF TG_ARGV[0] = 'run_source_rows' THEN
           IF EXISTS (
             SELECT 1 FROM automation_runs r
             JOIN import_batches b ON b.id = r.batch_id
             LEFT JOIN resource_tombstones rt_import
               ON rt_import.tenant_id = b.tenant_id AND rt_import.resource_type = 'import'
              AND rt_import.resource_id = b.id AND rt_import.state <> 'completed'
             LEFT JOIN resource_tombstones rt_run
               ON rt_run.tenant_id = b.tenant_id AND rt_run.resource_type = 'run'
              AND rt_run.resource_id = r.id AND rt_run.state <> 'completed'
             WHERE r.id = (to_jsonb(NEW)->>'run_id')::uuid
               AND (rt_import.tombstone_id IS NOT NULL OR rt_run.tombstone_id IS NOT NULL)
           ) OR EXISTS (
             SELECT 1 FROM source_rows sr JOIN import_batches b ON b.id = sr.batch_id
             JOIN resource_tombstones rt ON rt.tenant_id = b.tenant_id
               AND rt.resource_type = 'import' AND rt.resource_id = b.id AND rt.state <> 'completed'
             WHERE sr.id = (to_jsonb(NEW)->>'source_row_id')::uuid
           ) THEN
             RAISE EXCEPTION 'IMPORT_DELETION_PENDING' USING ERRCODE = '55000';
           END IF;
           RETURN NEW;
         END IF;
         IF TG_ARGV[0] = 'source_row_id' THEN
           SELECT b.id INTO import_id FROM source_rows sr
             JOIN import_batches b ON b.id = sr.batch_id
            WHERE sr.id = (to_jsonb(NEW)->>'source_row_id')::uuid;
         ELSE
           import_id := NULLIF(to_jsonb(NEW)->>TG_ARGV[0], '')::uuid;
         END IF;
         IF import_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM import_batches b JOIN resource_tombstones rt
             ON rt.tenant_id = b.tenant_id AND rt.resource_type = 'import'
            AND rt.resource_id = b.id AND rt.state <> 'completed'
            WHERE b.id = import_id
         ) THEN
           RAISE EXCEPTION 'IMPORT_DELETION_PENDING' USING ERRCODE = '55000';
         END IF;
         RETURN NEW;
       END
       $$;`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_JOB_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
