import { DataTypes, Op, type QueryInterface } from "sequelize";

const legacyTenantId = "00000000-0000-4000-8000-000000000001";

/**
 * Canonical entities used to be global. Duplicate each entity once per tenant
 * that references it, then rewrite links, runs, and conflict candidates using
 * the tenant inherited from their source import. Legacy unowned imports belong
 * to the original Goldis tenant, as established by the bootstrap flow.
 */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("canonical_entities", "tenant_id", {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "tenants", key: "tenant_id" },
      onDelete: "RESTRICT",
    }, { transaction });
    await context.addColumn("source_entity_links", "tenant_id", {
      type: DataTypes.UUID,
      allowNull: true,
    }, { transaction });

    await context.sequelize.query(
      `CREATE TEMPORARY TABLE canonical_entity_tenant_backfill ON COMMIT DROP AS
       WITH entity_usage AS (
         SELECT link.canonical_entity_id,
                COALESCE(batch.tenant_id, $1::uuid) AS tenant_id
           FROM source_entity_links AS link
           JOIN source_rows AS source ON source.id = link.source_row_id
           JOIN import_batches AS batch ON batch.id = source.batch_id
         UNION
         SELECT run.canonical_entity_id,
                COALESCE(batch.tenant_id, $1::uuid) AS tenant_id
           FROM automation_runs AS run
           JOIN import_batches AS batch ON batch.id = run.batch_id
          WHERE run.canonical_entity_id IS NOT NULL
       ),
       entity_tenants AS (
         SELECT canonical_entity_id, tenant_id FROM entity_usage
         UNION
         SELECT entity.canonical_entity_id, $1::uuid
           FROM canonical_entities AS entity
          WHERE NOT EXISTS (
            SELECT 1 FROM entity_usage AS usage
             WHERE usage.canonical_entity_id = entity.canonical_entity_id
          )
       ),
       numbered AS (
         SELECT canonical_entity_id AS previous_id,
                tenant_id,
                row_number() OVER (PARTITION BY canonical_entity_id ORDER BY tenant_id) AS tenant_rank
           FROM entity_tenants
       )
       SELECT previous_id,
              tenant_id,
              CASE WHEN tenant_rank = 1 THEN previous_id ELSE gen_random_uuid() END AS canonical_entity_id
         FROM numbered`,
      { bind: [legacyTenantId], transaction },
    );

    await context.sequelize.query(
      `DROP INDEX canonical_entities_nip_unique;
       DROP INDEX canonical_entities_regon_unique`,
      { transaction },
    );

    await context.sequelize.query(
      `UPDATE canonical_entities AS entity
          SET tenant_id = mapping.tenant_id
         FROM canonical_entity_tenant_backfill AS mapping
        WHERE entity.canonical_entity_id = mapping.previous_id
          AND mapping.canonical_entity_id = mapping.previous_id`,
      { transaction },
    );
    await context.sequelize.query(
      `INSERT INTO canonical_entities
         (canonical_entity_id, tenant_id, nip_normalized, regon, business_name, created_at, updated_at)
       SELECT mapping.canonical_entity_id, mapping.tenant_id,
              entity.nip_normalized, entity.regon, entity.business_name, entity.created_at, entity.updated_at
         FROM canonical_entity_tenant_backfill AS mapping
         JOIN canonical_entities AS entity ON entity.canonical_entity_id = mapping.previous_id
        WHERE mapping.canonical_entity_id <> mapping.previous_id`,
      { transaction },
    );

    await context.sequelize.query(
      `UPDATE source_entity_links AS link
          SET tenant_id = mapping.tenant_id,
              canonical_entity_id = mapping.canonical_entity_id
         FROM source_rows AS source
         JOIN import_batches AS batch ON batch.id = source.batch_id
         JOIN canonical_entity_tenant_backfill AS mapping
           ON mapping.tenant_id = COALESCE(batch.tenant_id, $1::uuid)
        WHERE source.id = link.source_row_id
          AND mapping.previous_id = link.canonical_entity_id`,
      { bind: [legacyTenantId], transaction },
    );
    await context.sequelize.query(
      `UPDATE automation_runs AS run
          SET canonical_entity_id = mapping.canonical_entity_id
         FROM import_batches AS batch
         JOIN canonical_entity_tenant_backfill AS mapping
           ON mapping.tenant_id = COALESCE(batch.tenant_id, $1::uuid)
        WHERE batch.id = run.batch_id
          AND mapping.previous_id = run.canonical_entity_id`,
      { bind: [legacyTenantId], transaction },
    );
    await context.sequelize.query(
      `UPDATE entity_grouping_conflicts AS conflict
          SET candidate_entity_ids = COALESCE((
            SELECT jsonb_agg(to_jsonb(mapping.canonical_entity_id::text) ORDER BY candidate.ordinality)
              FROM jsonb_array_elements_text(conflict.candidate_entity_ids)
                   WITH ORDINALITY AS candidate(candidate_id, ordinality)
              JOIN source_rows AS source ON source.id = conflict.source_row_id
              JOIN import_batches AS batch ON batch.id = source.batch_id
              JOIN canonical_entity_tenant_backfill AS mapping
                ON mapping.previous_id::text = candidate.candidate_id
               AND mapping.tenant_id = COALESCE(batch.tenant_id, $1::uuid)
          ), '[]'::jsonb)`,
      { bind: [legacyTenantId], transaction },
    );

    await context.sequelize.query(
      `ALTER TABLE canonical_entities ALTER COLUMN tenant_id SET NOT NULL;
       ALTER TABLE source_entity_links ALTER COLUMN tenant_id SET NOT NULL;
       ALTER TABLE canonical_entities
         ADD CONSTRAINT canonical_entities_tenant_entity_unique UNIQUE (tenant_id, canonical_entity_id);
       ALTER TABLE source_entity_links
         DROP CONSTRAINT IF EXISTS source_entity_links_canonical_entity_id_fkey;
       ALTER TABLE source_entity_links
         ADD CONSTRAINT source_entity_links_canonical_tenant_fk
           FOREIGN KEY (tenant_id, canonical_entity_id)
           REFERENCES canonical_entities (tenant_id, canonical_entity_id)
           ON DELETE RESTRICT`,
      { transaction },
    );
    await context.addIndex("canonical_entities", ["tenant_id", "nip_normalized"], {
      name: "canonical_entities_tenant_nip_unique",
      unique: true,
      where: { nip_normalized: { [Op.ne]: null } },
      transaction,
    });
    await context.addIndex("canonical_entities", ["tenant_id", "regon"], {
      name: "canonical_entities_tenant_regon_unique",
      unique: true,
      where: { regon: { [Op.ne]: null } },
      transaction,
    });
    await context.addIndex("source_entity_links", ["tenant_id", "canonical_entity_id"], {
      name: "source_entity_links_tenant_entity_idx",
      transaction,
    });
  });
}

export async function down(): Promise<void> {
  throw new Error("CANONICAL_ENTITY_TENANT_SPLIT_IS_NOT_SAFE_TO_REVERSE");
}
