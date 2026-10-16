import { createHash, randomUUID } from "node:crypto";
import { DataTypes, QueryTypes, type QueryInterface } from "sequelize";
import { canonicalJsonStringify } from "../../../features/results/canonical-json";

type BackfillRow = {
  leadId: string; tenantId: string; runId: string; sourceRowId: string; referenceDate: string;
  sourceOwnerUserId: string; inputSnapshot: Record<string, unknown>; identitySourceRowId: string;
  regon: string; companyName: string; peselCiphertext: string; peselKeyVersion: number;
  totalCount: number; capturedAt: Date; parserVersion: string; policies: Record<string, unknown>[];
  mobile: string; phone: string; email: string;
};

/** Preserves assigned positive OC results independently from source imports and execution rows. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.sequelize.query(
      `ALTER TABLE result_sets DROP CONSTRAINT result_sets_batch_fk;
       ALTER TABLE result_sets ALTER COLUMN batch_id DROP NOT NULL;
       ALTER TABLE result_sets ADD COLUMN source_import_deleted_at timestamptz;
       ALTER TABLE result_sets ADD CONSTRAINT result_sets_batch_fk FOREIGN KEY (batch_id)
         REFERENCES import_batches (id) ON DELETE SET NULL;
       CREATE INDEX result_sets_detached_idx ON result_sets (tenant_id, tool_id, source_import_deleted_at)
         WHERE source_import_deleted_at IS NOT NULL;`,
      { transaction },
    );
    await context.createTable("lead_result_snapshots", {
      snapshot_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      lead_id: { type: DataTypes.UUID, allowNull: false },
      original_run_id: { type: DataTypes.UUID, allowNull: false },
      original_source_row_id: { type: DataTypes.UUID, allowNull: false },
      source_owner_user_id: { type: DataTypes.UUID, allowNull: false },
      reference_date: { type: DataTypes.DATEONLY, allowNull: false },
      company_fields: { type: DataTypes.JSONB, allowNull: false },
      pesel_ciphertext: { type: DataTypes.TEXT, allowNull: false },
      pesel_key_version: { type: DataTypes.INTEGER, allowNull: false },
      policies: { type: DataTypes.JSONB, allowNull: false },
      policy_count: { type: DataTypes.INTEGER, allowNull: false },
      checksum: { type: DataTypes.STRING(64), allowNull: false },
      schema_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE lead_result_snapshots
         ADD CONSTRAINT lead_result_snapshots_lead_fk FOREIGN KEY (lead_id, tenant_id)
           REFERENCES business_leads (lead_id, tenant_id) ON DELETE CASCADE,
         ADD CONSTRAINT lead_result_snapshots_lead_run_uidx UNIQUE (lead_id, original_run_id),
         ADD CONSTRAINT lead_result_snapshots_company_valid CHECK (jsonb_typeof(company_fields) = 'object'
           AND company_fields->>'schemaVersion' = '2'),
         ADD CONSTRAINT lead_result_snapshots_policies_valid CHECK (jsonb_typeof(policies) = 'array'
           AND jsonb_array_length(policies) = policy_count AND policy_count > 0),
         ADD CONSTRAINT lead_result_snapshots_key_version_valid CHECK (pesel_key_version > 0),
         ADD CONSTRAINT lead_result_snapshots_checksum_valid CHECK (checksum ~ '^[0-9a-f]{64}$');
       CREATE INDEX lead_result_snapshots_lead_idx ON lead_result_snapshots (tenant_id, lead_id, created_at, original_run_id);`,
      { transaction },
    );

    // Backfill in bounded pages. PESEL stays encrypted; contact fields use V2 run snapshots,
    // with a source-row fallback only for historical V1 runs that predate frozen contacts.
    let lastLeadId: string | null = null;
    let lastRunId: string | null = null;
    const pageSize = 200;
    while (true) {
      const rows: BackfillRow[] = await context.sequelize.query<BackfillRow>(
        `SELECT lead.lead_id AS "leadId", lead.tenant_id AS "tenantId", run.id AS "runId",
                run.source_row_id AS "sourceRowId", result_set.reference_date AS "referenceDate",
                COALESCE(batch.owner_user_id, result_set.actor_user_id) AS "sourceOwnerUserId", run.input_snapshot AS "inputSnapshot",
                identity.source_row_id AS "identitySourceRowId", identity.regon, identity.company_name AS "companyName",
                identity.pesel_ciphertext AS "peselCiphertext", identity.pesel_key_version AS "peselKeyVersion",
                snapshot.total_count AS "totalCount", snapshot.captured_at AS "capturedAt",
                snapshot.parser_version AS "parserVersion", source.mobile, source.phone, source.email,
                COALESCE(policy_rows.policies, '[]'::jsonb) AS policies
           FROM business_leads lead
           JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
           JOIN import_batches batch ON batch.id = result_set.batch_id AND batch.tenant_id = result_set.tenant_id
           JOIN lead_run_links link ON link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id
           JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
           JOIN automation_runs run ON run.id = grp.run_id AND run.status = 'completed'
           JOIN run_identities identity ON identity.run_id = run.id AND identity.source_row_id = run.source_row_id
           JOIN oc_snapshots snapshot ON snapshot.run_id = run.id AND snapshot.total_count > 0
           JOIN source_rows source ON source.id = run.source_row_id
           JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object(
                  'sourceOrdinal', policy.source_ordinal, 'insuredName', policy.insured_name,
                  'policyTypeAndNumber', policy.policy_type_and_number, 'contractType', policy.contract_type,
                  'insuredClaimCount', policy.insured_claim_count, 'vehicleRegistration', policy.vehicle_registration,
                  'vehicleGroup', policy.vehicle_group, 'vehicleMake', policy.vehicle_make,
                  'vehicleModel', policy.vehicle_model, 'insurer', policy.insurer,
                  'coverageFrom', policy.coverage_from, 'coverageTo', policy.coverage_to
                ) ORDER BY policy.source_ordinal) AS policies
             FROM oc_policies policy WHERE policy.run_id = run.id) policy_rows ON TRUE
          WHERE lead.result_status = 'ready' AND lead.assigned_to_user_id IS NOT NULL
            AND lead.assigned_to_user_id <> COALESCE(batch.owner_user_id, result_set.actor_user_id)
            AND (:lastLeadId IS NULL OR (lead.lead_id, run.id) > (CAST(:lastLeadId AS uuid), CAST(:lastRunId AS uuid)))
            AND NOT EXISTS (SELECT 1 FROM lead_result_snapshots saved
              WHERE saved.lead_id = lead.lead_id AND saved.original_run_id = run.id)
          ORDER BY lead.lead_id, run.id LIMIT :pageSize`,
        { replacements: { pageSize, lastLeadId, lastRunId }, type: QueryTypes.SELECT, transaction },
      );
      if (!rows.length) break;
      for (const row of rows) {
        const input = row.inputSnapshot ?? {};
        if (!row.sourceOwnerUserId || row.identitySourceRowId !== row.sourceRowId
          || !Array.isArray(row.policies) || row.policies.length !== Number(row.totalCount) || row.totalCount < 1) {
          throw new Error("LEAD_RESULT_SNAPSHOT_BACKFILL_INCOMPLETE");
        }
        const companyFields = {
          schemaVersion: 2,
          companyName: String(input.companyName ?? row.companyName),
          effectiveRegon: String(input.effectiveRegon ?? row.regon),
          decisionMakerName: typeof input.decisionMakerName === "string" ? input.decisionMakerName : null,
          mobile: typeof input.mobile === "string" ? input.mobile : row.mobile,
          phone: typeof input.phone === "string" ? input.phone : row.phone,
          email: typeof input.email === "string" ? input.email : row.email,
        };
        if (!/^\d{9}(?:\d{5})?$/.test(companyFields.effectiveRegon)) {
          throw new Error("LEAD_RESULT_SNAPSHOT_BACKFILL_INCOMPLETE");
        }
        const checksumPayload = {
          leadId: row.leadId, tenantId: row.tenantId, runId: row.runId, sourceRowId: row.sourceRowId,
          sourceOwnerUserId: row.sourceOwnerUserId, referenceDate: row.referenceDate, companyFields,
          peselCiphertext: row.peselCiphertext, peselKeyVersion: Number(row.peselKeyVersion), policies: row.policies,
        };
        const checksum = createHash("sha256").update(canonicalJsonStringify(checksumPayload), "utf8").digest("hex");
        await context.sequelize.query(
          `INSERT INTO lead_result_snapshots (snapshot_id, tenant_id, lead_id, original_run_id,
                original_source_row_id, source_owner_user_id, reference_date, company_fields, pesel_ciphertext,
                pesel_key_version, policies, policy_count, checksum, schema_version, created_at)
           VALUES (:snapshotId, :tenantId, :leadId, :runId, :sourceRowId, :sourceOwnerUserId, :referenceDate,
                CAST(:companyFields AS jsonb), :peselCiphertext, :peselKeyVersion, CAST(:policies AS jsonb),
                :policyCount, :checksum, 1, now()) ON CONFLICT (lead_id, original_run_id) DO NOTHING`,
          { replacements: { snapshotId: randomUUID(), tenantId: row.tenantId, leadId: row.leadId,
            runId: row.runId, sourceRowId: row.sourceRowId, sourceOwnerUserId: row.sourceOwnerUserId,
            referenceDate: row.referenceDate, companyFields: JSON.stringify(companyFields),
            peselCiphertext: row.peselCiphertext, peselKeyVersion: row.peselKeyVersion,
            policies: JSON.stringify(row.policies), policyCount: row.policies.length, checksum }, transaction },
        );
      }
      lastLeadId = rows.at(-1)!.leadId;
      lastRunId = rows.at(-1)!.runId;
    }
  });
}

export async function down(): Promise<void> {
  throw new Error("PRESERVED_LEAD_RESULT_SNAPSHOTS_ARE_NOT_SAFE_TO_REVERSE");
}
