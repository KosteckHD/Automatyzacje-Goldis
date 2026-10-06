import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("regon_enrichment_audits", {
      audit_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      source_row_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "source_rows", key: "id" }, onDelete: "CASCADE",
      },
      nip_normalized: { type: DataTypes.STRING(10), allowNull: false },
      provider_name: { type: DataTypes.STRING(120), allowNull: false },
      provider_version: { type: DataTypes.STRING(80), allowNull: false },
      data_version_label: { type: DataTypes.STRING(120), allowNull: true },
      data_version_hash: { type: DataTypes.STRING(64), allowNull: false },
      response_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      candidate_count: { type: DataTypes.INTEGER, allowNull: false },
      decision_status: { type: DataTypes.STRING(20), allowNull: false },
      reason_code: { type: DataTypes.STRING(80), allowNull: true },
      proposed_regon: { type: DataTypes.STRING(14), allowNull: true },
      effective_regon_before: { type: DataTypes.STRING(14), allowNull: true },
      effective_regon_after: { type: DataTypes.STRING(14), allowNull: true },
      applied: { type: DataTypes.BOOLEAN, allowNull: false },
      row_version_before: { type: DataTypes.INTEGER, allowNull: false },
      row_version_after: { type: DataTypes.INTEGER, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE regon_enrichment_audits
         ADD CONSTRAINT regon_enrichment_nip_valid CHECK (nip_normalized ~ '^[0-9]{10}$'),
         ADD CONSTRAINT regon_enrichment_provider_nonempty CHECK (length(trim(provider_name)) > 0 AND length(trim(provider_version)) > 0),
         ADD CONSTRAINT regon_enrichment_data_version_hash_valid CHECK (data_version_hash ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT regon_enrichment_fingerprint_valid CHECK (response_fingerprint ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT regon_enrichment_candidate_count_valid CHECK (candidate_count >= 0),
         ADD CONSTRAINT regon_enrichment_status_valid CHECK (decision_status IN ('matched', 'not_found', 'ambiguous', 'manual_review')),
         ADD CONSTRAINT regon_enrichment_reason_valid CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,80}$'),
         ADD CONSTRAINT regon_enrichment_regon_format CHECK (
           (proposed_regon IS NULL OR proposed_regon ~ '^[0-9]{9}([0-9]{5})?$')
           AND (effective_regon_before IS NULL OR effective_regon_before ~ '^[0-9]{9}([0-9]{5})?$')
           AND (effective_regon_after IS NULL OR effective_regon_after ~ '^[0-9]{9}([0-9]{5})?$')
         ),
         ADD CONSTRAINT regon_enrichment_row_version_step CHECK (row_version_before > 0 AND row_version_after = row_version_before + 1),
         ADD CONSTRAINT regon_enrichment_apply_consistency CHECK (
           (decision_status = 'matched' AND applied AND proposed_regon IS NOT NULL
             AND proposed_regon = effective_regon_after AND effective_regon_before IS NULL)
           OR (decision_status <> 'matched' AND NOT applied AND proposed_regon IS NULL
             AND effective_regon_after IS NOT DISTINCT FROM effective_regon_before)
         )`,
      { transaction },
    );
    await context.addIndex("regon_enrichment_audits", ["source_row_id", "created_at"], {
      name: "regon_enrichment_audits_source_created_idx", transaction,
    });
    await context.addIndex("regon_enrichment_audits", ["nip_normalized", "data_version_hash"], {
      name: "regon_enrichment_audits_nip_version_idx", transaction,
    });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("regon_enrichment_audits", { transaction });
  });
}
