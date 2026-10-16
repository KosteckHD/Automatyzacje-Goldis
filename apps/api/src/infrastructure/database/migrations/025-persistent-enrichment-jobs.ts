import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("enrichment_jobs", {
      job_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tenants", key: "tenant_id" }, onDelete: "RESTRICT" },
      batch_id: { type: DataTypes.UUID, allowNull: false, references: { model: "import_batches", key: "id" }, onDelete: "CASCADE" },
      actor_user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "user_id" }, onDelete: "RESTRICT" },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      selection_hash: { type: DataTypes.STRING(64), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      selected_count: { type: DataTypes.INTEGER, allowNull: false },
      completed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      excluded_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cancelled_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      cancel_requested: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      lease_owner: { type: DataTypes.UUID, allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.addConstraint("enrichment_jobs", {
      fields: ["job_id", "batch_id"], type: "unique", name: "enrichment_jobs_id_batch_unique", transaction,
    });
    await context.sequelize.query(
      `ALTER TABLE enrichment_jobs
         ADD CONSTRAINT enrichment_jobs_status_valid CHECK (status IN ('queued', 'processing', 'completed', 'partial', 'failed', 'cancelled')),
         ADD CONSTRAINT enrichment_jobs_hash_valid CHECK (selection_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT enrichment_jobs_idempotency_valid CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 120),
         ADD CONSTRAINT enrichment_jobs_counts_valid CHECK (
           selected_count > 0 AND completed_count >= 0 AND excluded_count >= 0 AND failed_count >= 0
           AND cancelled_count >= 0
           AND completed_count + excluded_count + failed_count + cancelled_count <= selected_count
         ),
         ADD CONSTRAINT enrichment_jobs_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
         ADD CONSTRAINT enrichment_jobs_error_valid CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,80}$');
       CREATE UNIQUE INDEX enrichment_jobs_actor_idempotency_unique
         ON enrichment_jobs (batch_id, actor_user_id, idempotency_key);
       CREATE INDEX enrichment_jobs_claim_idx
         ON enrichment_jobs (status, lease_expires_at, updated_at)
         WHERE status IN ('queued', 'processing') AND cancel_requested = FALSE;
       CREATE INDEX enrichment_jobs_tenant_batch_idx
         ON enrichment_jobs (tenant_id, batch_id, created_at DESC, job_id DESC);`,
      { transaction },
    );

    await context.addConstraint("source_rows", {
      fields: ["id", "batch_id"], type: "unique", name: "source_rows_id_batch_unique", transaction,
    });
    await context.createTable("enrichment_job_items", {
      item_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      job_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false },
      source_row_id: { type: DataTypes.UUID, allowNull: false },
      row_number: { type: DataTypes.INTEGER, allowNull: false },
      expected_row_version: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      reason_code: { type: DataTypes.STRING(80), allowNull: true },
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      next_attempt_at: { type: DataTypes.DATE, allowNull: true },
      audit_id: { type: DataTypes.UUID, allowNull: true, references: { model: "regon_enrichment_audits", key: "audit_id" }, onDelete: "SET NULL" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.addConstraint("enrichment_job_items", {
      fields: ["job_id", "source_row_id"], type: "unique", name: "enrichment_job_items_job_source_unique", transaction,
    });
    await context.sequelize.query(
      `ALTER TABLE enrichment_job_items
         ADD CONSTRAINT enrichment_job_items_job_batch_fk FOREIGN KEY (job_id, batch_id)
           REFERENCES enrichment_jobs (job_id, batch_id) ON DELETE CASCADE,
         ADD CONSTRAINT enrichment_job_items_source_batch_fk FOREIGN KEY (source_row_id, batch_id)
           REFERENCES source_rows (id, batch_id) ON DELETE CASCADE,
         ADD CONSTRAINT enrichment_job_items_row_valid CHECK (row_number >= 2 AND expected_row_version > 0),
         ADD CONSTRAINT enrichment_job_items_status_valid CHECK
           (status IN ('pending', 'processing', 'matched', 'not_found', 'ambiguous', 'manual_review', 'excluded', 'failed', 'cancelled')),
         ADD CONSTRAINT enrichment_job_items_attempts_valid CHECK (attempt_count >= 0 AND attempt_count <= 10),
         ADD CONSTRAINT enrichment_job_items_reason_valid CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,80}$'),
         ADD CONSTRAINT enrichment_job_items_error_valid CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,80}$');
       CREATE INDEX enrichment_job_items_page_idx ON enrichment_job_items (job_id, row_number, item_id);
       CREATE INDEX enrichment_job_items_due_idx ON enrichment_job_items (status, next_attempt_at, created_at)
         WHERE status IN ('pending', 'processing');
       CREATE INDEX enrichment_job_items_source_idx ON enrichment_job_items (source_row_id, created_at DESC);`,
      { transaction },
    );
    await context.createTable("enrichment_worker_slots", {
      slot_id: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
      lease_owner: { type: DataTypes.UUID, allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE enrichment_worker_slots
         ADD CONSTRAINT enrichment_worker_slots_id_valid CHECK (slot_id BETWEEN 1 AND 3),
         ADD CONSTRAINT enrichment_worker_slots_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL));
       INSERT INTO enrichment_worker_slots (slot_id, lease_owner, lease_expires_at) VALUES (1, NULL, NULL), (2, NULL, NULL), (3, NULL, NULL);`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("PERSISTENT_ENRICHMENT_JOB_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
