import { DataTypes, type QueryInterface } from "sequelize";

/** Expiring, non-tenant cache of minimal public registry answers keyed by an HMAC of NIP. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("registry_result_cache", {
      provider_name: { type: DataTypes.STRING(60), allowNull: false },
      data_day: { type: DataTypes.DATEONLY, allowNull: false },
      nip_hash: { type: DataTypes.STRING(64), allowNull: false },
      result_payload: { type: DataTypes.JSONB, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE registry_result_cache
         ADD CONSTRAINT registry_result_cache_pk PRIMARY KEY (provider_name, data_day, nip_hash),
         ADD CONSTRAINT registry_result_cache_provider_valid CHECK (provider_name ~ '^[a-z0-9-]{1,60}$'),
         ADD CONSTRAINT registry_result_cache_hash_valid CHECK (nip_hash ~ '^[a-f0-9]{64}$'),
         ADD CONSTRAINT registry_result_cache_payload_object CHECK (jsonb_typeof(result_payload) = 'object'),
         ADD CONSTRAINT registry_result_cache_expiry_valid CHECK (expires_at > created_at);
       CREATE INDEX registry_result_cache_expiry_idx ON registry_result_cache (expires_at);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.dropTable("registry_result_cache");
}
