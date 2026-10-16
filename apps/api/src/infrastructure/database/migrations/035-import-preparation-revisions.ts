import { DataTypes, type QueryInterface } from "sequelize";

/** Durable, versioned pre-portal preparation snapshots and per-source-row accounting. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("import_preparations", {
      preparation_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false },
      actor_user_id: { type: DataTypes.UUID, allowNull: false },
      revision: { type: DataTypes.INTEGER, allowNull: false },
      rules_version: { type: DataTypes.STRING(40), allowNull: false },
      source_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      status: { type: DataTypes.STRING(32), allowNull: false },
      stage: { type: DataTypes.STRING(32), allowNull: false },
      cursor_row_number: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
      total_rows: { type: DataTypes.INTEGER, allowNull: false },
      ready_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      review_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      skipped_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      duplicate_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      waiting_registry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      lease_owner: { type: DataTypes.UUID, allowNull: true },
      lease_expires_at: { type: DataTypes.DATE, allowNull: true },
      next_attempt_at: { type: DataTypes.DATE, allowNull: true },
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      sealed_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.addConstraint("import_preparations", {
      fields: ["preparation_id", "batch_id"], type: "unique", name: "import_preparations_id_batch_unique", transaction,
    });
    await context.addConstraint("import_preparations", {
      fields: ["batch_id", "revision"], type: "unique", name: "import_preparations_batch_revision_unique", transaction,
    });
    await context.addConstraint("import_preparations", {
      fields: ["batch_id", "actor_user_id", "idempotency_key"], type: "unique",
      name: "import_preparations_actor_idempotency_unique", transaction,
    });
    await context.sequelize.query(
      `ALTER TABLE import_preparations
         ADD CONSTRAINT import_preparations_batch_tenant_fk FOREIGN KEY (tenant_id, batch_id)
           REFERENCES import_batches (tenant_id, id) ON DELETE CASCADE,
         ADD CONSTRAINT import_preparations_actor_membership_fk FOREIGN KEY (tenant_id, actor_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT,
         ADD CONSTRAINT import_preparations_rules_valid CHECK (rules_version ~ '^[A-Za-z0-9._-]{1,40}$'),
         ADD CONSTRAINT import_preparations_fingerprint_valid CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT import_preparations_revision_valid CHECK (revision > 0 AND version > 0),
         ADD CONSTRAINT import_preparations_status_valid CHECK
           (status IN ('queued', 'processing', 'waiting_registry', 'completed', 'completed_with_attention', 'cancelled', 'failed')),
         ADD CONSTRAINT import_preparations_stage_valid CHECK
           (stage IN ('snapshot', 'first_deduplication', 'registry_lookup', 'second_deduplication', 'sealing', 'sealed')),
         ADD CONSTRAINT import_preparations_cursor_valid CHECK (cursor_row_number >= 2),
         ADD CONSTRAINT import_preparations_counts_valid CHECK (
           total_rows >= 0 AND ready_count >= 0 AND review_count >= 0 AND skipped_count >= 0
           AND duplicate_count >= 0 AND waiting_registry_count >= 0
           AND ready_count + review_count + skipped_count + duplicate_count + waiting_registry_count <= total_rows
         ),
         ADD CONSTRAINT import_preparations_idempotency_valid CHECK (length(trim(idempotency_key)) BETWEEN 16 AND 120),
         ADD CONSTRAINT import_preparations_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
         ADD CONSTRAINT import_preparations_error_valid CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,80}$'),
         ADD CONSTRAINT import_preparations_sealed_shape CHECK
           ((status IN ('completed', 'completed_with_attention') AND sealed_at IS NOT NULL)
             OR (status NOT IN ('completed', 'completed_with_attention') AND sealed_at IS NULL));
       CREATE UNIQUE INDEX import_preparations_one_active_per_batch_uidx
         ON import_preparations (tenant_id, batch_id)
         WHERE status IN ('queued', 'processing', 'waiting_registry');
       CREATE INDEX import_preparations_tenant_batch_idx
         ON import_preparations (tenant_id, batch_id, revision DESC);
       CREATE INDEX import_preparations_claim_idx
         ON import_preparations (status, next_attempt_at, lease_expires_at, created_at)
         WHERE status IN ('queued', 'processing');`,
      { transaction },
    );

    await context.createTable("import_prepared_rows", {
      prepared_row_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      preparation_id: { type: DataTypes.UUID, allowNull: false },
      batch_id: { type: DataTypes.UUID, allowNull: false },
      source_row_id: { type: DataTypes.UUID, allowNull: false },
      row_number: { type: DataTypes.INTEGER, allowNull: false },
      expected_row_version: { type: DataTypes.INTEGER, allowNull: false },
      source_snapshot: { type: DataTypes.JSONB, allowNull: false },
      status: { type: DataTypes.STRING(32), allowNull: false },
      reason_code: { type: DataTypes.STRING(80), allowNull: true },
      representative_row_number: { type: DataTypes.INTEGER, allowNull: true },
      normalized_name: { type: DataTypes.TEXT, allowNull: true },
      normalized_nip: { type: DataTypes.STRING(10), allowNull: true },
      effective_regon: { type: DataTypes.STRING(14), allowNull: true },
      regon_provenance: { type: DataTypes.STRING(24), allowNull: false },
      registry_fetched_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.addConstraint("import_prepared_rows", {
      fields: ["preparation_id", "source_row_id"], type: "unique", name: "import_prepared_rows_preparation_source_unique", transaction,
    });
    await context.addConstraint("import_prepared_rows", {
      fields: ["preparation_id", "row_number"], type: "unique", name: "import_prepared_rows_preparation_row_unique", transaction,
    });
    await context.sequelize.query(
      `ALTER TABLE import_prepared_rows
         ADD CONSTRAINT import_prepared_rows_preparation_batch_fk FOREIGN KEY (preparation_id, batch_id)
           REFERENCES import_preparations (preparation_id, batch_id) ON DELETE CASCADE,
         ADD CONSTRAINT import_prepared_rows_source_batch_fk FOREIGN KEY (source_row_id, batch_id)
           REFERENCES source_rows (id, batch_id) ON DELETE CASCADE,
         ADD CONSTRAINT import_prepared_rows_row_valid CHECK (row_number >= 2 AND expected_row_version > 0),
         ADD CONSTRAINT import_prepared_rows_snapshot_object CHECK (jsonb_typeof(source_snapshot) = 'object'),
         ADD CONSTRAINT import_prepared_rows_status_valid CHECK
           (status IN ('pending', 'ready', 'review', 'skipped_no_identifiers', 'duplicate', 'waiting_registry', 'excluded')),
         ADD CONSTRAINT import_prepared_rows_reason_valid CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,80}$'),
         ADD CONSTRAINT import_prepared_rows_representative_valid CHECK
           (representative_row_number IS NULL OR representative_row_number <> row_number),
         ADD CONSTRAINT import_prepared_rows_nip_valid CHECK (normalized_nip IS NULL OR normalized_nip ~ '^\\d{10}$'),
         ADD CONSTRAINT import_prepared_rows_regon_valid CHECK (effective_regon IS NULL OR effective_regon ~ '^\\d{9}(\\d{5})?$'),
         ADD CONSTRAINT import_prepared_rows_provenance_valid CHECK
           (regon_provenance IN ('none', 'import', 'approved_correction', 'registry'));
       CREATE INDEX import_prepared_rows_page_idx ON import_prepared_rows (preparation_id, row_number);
       CREATE INDEX import_prepared_rows_status_idx ON import_prepared_rows (preparation_id, status, row_number);`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("IMPORT_PREPARATION_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
