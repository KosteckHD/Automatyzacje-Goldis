import { DataTypes, Op, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("source_rows", "effective_regon", {
      type: DataTypes.STRING(14), allowNull: true,
    }, { transaction });
    await context.sequelize.query(
      "UPDATE source_rows SET effective_regon = regon WHERE regon IS NOT NULL",
      { transaction },
    );
    await context.sequelize.query(
      `ALTER TABLE source_rows
         ADD CONSTRAINT source_rows_effective_regon_format
         CHECK (effective_regon IS NULL OR effective_regon ~ '^[0-9]{9}([0-9]{5})?$')`,
      { transaction },
    );
    await context.addIndex("source_rows", ["batch_id", "effective_regon"], {
      name: "source_rows_batch_effective_regon_idx", transaction,
    });

    await context.createTable("regon_corrections", {
      correction_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      source_row_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "source_rows", key: "id" }, onDelete: "CASCADE",
      },
      author_ref: { type: DataTypes.STRING(128), allowNull: false },
      reason: { type: DataTypes.TEXT, allowNull: false },
      previous_regon: { type: DataTypes.STRING(14), allowNull: true },
      proposed_regon: { type: DataTypes.STRING(14), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
      reviewer_ref: { type: DataTypes.STRING(128), allowNull: true },
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      review_reason: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE regon_corrections
         ADD CONSTRAINT regon_corrections_reason_nonempty CHECK (length(trim(reason)) > 0),
         ADD CONSTRAINT regon_corrections_previous_format CHECK (previous_regon IS NULL OR previous_regon ~ '^[0-9]{9}([0-9]{5})?$'),
         ADD CONSTRAINT regon_corrections_proposed_format CHECK (proposed_regon ~ '^[0-9]{9}([0-9]{5})?$'),
         ADD CONSTRAINT regon_corrections_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),
         ADD CONSTRAINT regon_corrections_review_state_valid CHECK (
           (status = 'pending' AND reviewer_ref IS NULL AND reviewed_at IS NULL)
           OR (status IN ('approved', 'rejected') AND reviewer_ref IS NOT NULL AND reviewed_at IS NOT NULL)
         )`,
      { transaction },
    );
    await context.addIndex("regon_corrections", ["source_row_id", "created_at"], {
      name: "regon_corrections_source_created_idx", transaction,
    });
    await context.addIndex("regon_corrections", ["source_row_id"], {
      name: "regon_corrections_one_pending_per_source_row", unique: true,
      where: { status: "pending" }, transaction,
    });

    await context.createTable("registry_lookup_cache", {
      lookup_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      nip_normalized: { type: DataTypes.STRING(10), allowNull: false },
      data_version: { type: DataTypes.STRING(64), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      result_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      response_fingerprint: { type: DataTypes.STRING(64), allowNull: true },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      checked_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE registry_lookup_cache
         ADD CONSTRAINT registry_lookup_nip_valid CHECK (nip_normalized ~ '^[0-9]{10}$'),
         ADD CONSTRAINT registry_lookup_version_valid CHECK (data_version ~ '^[0-9a-f]{64}$'),
         ADD CONSTRAINT registry_lookup_status_valid CHECK (status IN ('pending', 'matched', 'not_found', 'ambiguous', 'unavailable', 'manual_review')),
         ADD CONSTRAINT registry_lookup_result_count_valid CHECK (result_count >= 0),
         ADD CONSTRAINT registry_lookup_attempt_count_valid CHECK (attempt_count BETWEEN 1 AND 10),
         ADD CONSTRAINT registry_lookup_fingerprint_valid CHECK (response_fingerprint IS NULL OR response_fingerprint ~ '^[0-9a-f]{64}$')`,
      { transaction },
    );
    await context.addIndex("registry_lookup_cache", ["nip_normalized", "data_version"], {
      name: "registry_lookup_nip_version_unique", unique: true, transaction,
    });
    await context.addIndex("registry_lookup_cache", ["status", "expires_at"], {
      name: "registry_lookup_status_expiry_idx", transaction,
    });

    await context.createTable("canonical_entities", {
      canonical_entity_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      nip_normalized: { type: DataTypes.STRING(10), allowNull: true },
      regon: { type: DataTypes.STRING(14), allowNull: true },
      business_name: { type: DataTypes.TEXT, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE canonical_entities
         ADD CONSTRAINT canonical_entity_has_identifier CHECK (nip_normalized IS NOT NULL OR regon IS NOT NULL),
         ADD CONSTRAINT canonical_entity_nip_valid CHECK (nip_normalized IS NULL OR nip_normalized ~ '^[0-9]{10}$'),
         ADD CONSTRAINT canonical_entity_regon_valid CHECK (regon IS NULL OR regon ~ '^[0-9]{9}([0-9]{5})?$'),
         ADD CONSTRAINT canonical_entity_name_nonempty CHECK (length(trim(business_name)) > 0)`,
      { transaction },
    );
    await context.addIndex("canonical_entities", ["nip_normalized"], {
      name: "canonical_entities_nip_unique", unique: true, where: { nip_normalized: { [Op.ne]: null } }, transaction,
    });
    await context.addIndex("canonical_entities", ["regon"], {
      name: "canonical_entities_regon_unique", unique: true, where: { regon: { [Op.ne]: null } }, transaction,
    });

    await context.createTable("source_entity_links", {
      source_row_id: {
        type: DataTypes.UUID, primaryKey: true, allowNull: false,
        references: { model: "source_rows", key: "id" }, onDelete: "CASCADE",
      },
      canonical_entity_id: {
        type: DataTypes.UUID, allowNull: false,
        references: { model: "canonical_entities", key: "canonical_entity_id" }, onDelete: "RESTRICT",
      },
      match_method: { type: DataTypes.STRING(32), allowNull: false },
      linked_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE source_entity_links
         ADD CONSTRAINT source_entity_link_method_valid CHECK (match_method IN ('nip_regon_exact', 'registry_verified', 'manual'))`,
      { transaction },
    );
    await context.addIndex("source_entity_links", ["canonical_entity_id"], {
      name: "source_entity_links_entity_idx", transaction,
    });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("source_entity_links", { transaction });
    await context.dropTable("canonical_entities", { transaction });
    await context.dropTable("registry_lookup_cache", { transaction });
    await context.dropTable("regon_corrections", { transaction });
    await context.removeIndex("source_rows", "source_rows_batch_effective_regon_idx", { transaction });
    await context.removeConstraint("source_rows", "source_rows_effective_regon_format", { transaction });
    await context.removeColumn("source_rows", "effective_regon", { transaction });
  });
}
