import type { QueryInterface } from "sequelize";

/** Adds import-scoped deletion only after DB-level write barriers are installed. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `CREATE FUNCTION reject_tombstoned_import_write() RETURNS trigger
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
              AND rt_import.resource_id = b.id AND rt_import.state = 'active'
             LEFT JOIN resource_tombstones rt_run
               ON rt_run.tenant_id = b.tenant_id AND rt_run.resource_type = 'run'
              AND rt_run.resource_id = r.id AND rt_run.state = 'active'
             WHERE r.id = (to_jsonb(NEW)->>'run_id')::uuid
               AND (rt_import.tombstone_id IS NOT NULL OR rt_run.tombstone_id IS NOT NULL)
           ) OR EXISTS (
             SELECT 1 FROM source_rows sr JOIN import_batches b ON b.id = sr.batch_id
             JOIN resource_tombstones rt ON rt.tenant_id = b.tenant_id
               AND rt.resource_type = 'import' AND rt.resource_id = b.id AND rt.state = 'active'
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
            AND rt.resource_id = b.id AND rt.state = 'active'
            WHERE b.id = import_id
         ) THEN
           RAISE EXCEPTION 'IMPORT_DELETION_PENDING' USING ERRCODE = '55000';
         END IF;
         RETURN NEW;
       END
       $$;

       ALTER TABLE deletion_jobs DROP CONSTRAINT deletion_jobs_target_valid;
       ALTER TABLE deletion_jobs ADD CONSTRAINT deletion_jobs_target_valid
         CHECK (target_type IN ('artifact', 'run', 'import') AND target_id IS NOT NULL);

       CREATE TRIGGER deletion_guard_source_rows BEFORE INSERT OR UPDATE ON source_rows
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_automation_runs BEFORE INSERT OR UPDATE ON automation_runs
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_enrichment_jobs BEFORE INSERT OR UPDATE ON enrichment_jobs
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_enrichment_items BEFORE INSERT OR UPDATE ON enrichment_job_items
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_import_preparations BEFORE INSERT OR UPDATE ON import_preparations
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_prepared_rows BEFORE INSERT OR UPDATE ON import_prepared_rows
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_prep_workflows BEFORE INSERT OR UPDATE ON import_preparation_workflows
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_prep_workflow_jobs BEFORE INSERT OR UPDATE ON import_preparation_workflow_jobs
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_prepared_executions BEFORE INSERT OR UPDATE ON prepared_set_executions
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('batch_id');
       CREATE TRIGGER deletion_guard_run_submissions BEFORE INSERT OR UPDATE ON run_submissions
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('import_batch_id');
       CREATE TRIGGER deletion_guard_submission_items BEFORE INSERT OR UPDATE ON run_submission_items
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('import_batch_id');
       CREATE TRIGGER deletion_guard_source_entity_links BEFORE INSERT OR UPDATE ON source_entity_links
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('source_row_id');
       CREATE TRIGGER deletion_guard_regon_corrections BEFORE INSERT OR UPDATE ON regon_corrections
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('source_row_id');
       CREATE TRIGGER deletion_guard_regon_audits BEFORE INSERT OR UPDATE ON regon_enrichment_audits
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('source_row_id');
       CREATE TRIGGER deletion_guard_grouping_conflicts BEFORE INSERT OR UPDATE ON entity_grouping_conflicts
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('source_row_id');
       CREATE TRIGGER deletion_guard_run_identities BEFORE INSERT OR UPDATE ON run_identities
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('source_row_id');
       CREATE TRIGGER deletion_guard_run_source_rows BEFORE INSERT OR UPDATE ON run_source_rows
         FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_import_write('run_source_rows');`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_JOB_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
