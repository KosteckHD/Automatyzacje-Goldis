import type { QueryInterface } from "sequelize";

/** Companies use their verified REGON and have no invented person/PESEL. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async transaction => {
    await context.sequelize.query(`ALTER TABLE run_identities ALTER COLUMN pesel_ciphertext DROP NOT NULL, ALTER COLUMN pesel_key_version DROP NOT NULL;
      ALTER TABLE run_identities ADD CONSTRAINT run_identity_subject_identifier_valid CHECK (
        (match_method = 'regon_company' AND first_name = '' AND last_name = '' AND pesel_ciphertext IS NULL AND pesel_key_version IS NULL)
        OR (match_method <> 'regon_company' AND pesel_ciphertext IS NOT NULL AND pesel_key_version IS NOT NULL AND pesel_key_version > 0));
      ALTER TABLE lead_result_snapshots ALTER COLUMN pesel_ciphertext DROP NOT NULL, ALTER COLUMN pesel_key_version DROP NOT NULL;
      ALTER TABLE lead_result_snapshots ADD CONSTRAINT lead_snapshot_subject_identifier_valid CHECK (
        (COALESCE(company_fields->>'subjectKind', 'person') = 'company' AND pesel_ciphertext IS NULL AND pesel_key_version IS NULL)
        OR (COALESCE(company_fields->>'subjectKind', 'person') <> 'company' AND pesel_ciphertext IS NOT NULL AND pesel_key_version IS NOT NULL AND pesel_key_version > 0));`, { transaction });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async transaction => {
    // SET NOT NULL deliberately refuses a lossy downgrade while company results exist.
    await context.sequelize.query(`ALTER TABLE lead_result_snapshots ALTER COLUMN pesel_ciphertext SET NOT NULL, ALTER COLUMN pesel_key_version SET NOT NULL;
      ALTER TABLE run_identities ALTER COLUMN pesel_ciphertext SET NOT NULL, ALTER COLUMN pesel_key_version SET NOT NULL;
      ALTER TABLE lead_result_snapshots DROP CONSTRAINT lead_snapshot_subject_identifier_valid;
      ALTER TABLE run_identities DROP CONSTRAINT run_identity_subject_identifier_valid;`, { transaction });
  });
}
