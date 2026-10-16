import { ConflictException } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import { LeadResultSnapshot, sequelize } from "../../infrastructure/database/db";
import { leadResultSnapshotChecksum } from "../results/public";

/** Detaches assigned-to-others leads only after their independent encrypted result is verified. */
export async function purgeImportResultsPreservingOtherAssignees(
  tenantId: string,
  batchId: string,
  transaction: Transaction,
): Promise<void> {
  const missing = await sequelize.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM business_leads lead
       JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
       JOIN import_batches batch ON batch.id = result_set.batch_id AND batch.tenant_id = result_set.tenant_id
      WHERE lead.tenant_id = :tenantId AND result_set.batch_id = :batchId
        AND lead.assigned_to_user_id IS NOT NULL
        AND lead.assigned_to_user_id <> COALESCE(batch.owner_user_id, result_set.actor_user_id)
        AND (lead.result_status <> 'ready'
          OR NOT EXISTS (SELECT 1 FROM lead_result_snapshots any_snapshot WHERE any_snapshot.lead_id = lead.lead_id)
          OR EXISTS (
            SELECT 1 FROM lead_run_links link
            JOIN run_submission_groups grp ON grp.group_id = link.group_id AND grp.tenant_id = link.tenant_id
            JOIN automation_runs run ON run.id = grp.run_id
            JOIN oc_snapshots oc ON oc.run_id = run.id AND oc.total_count > 0
            WHERE link.lead_id = lead.lead_id AND link.tenant_id = lead.tenant_id AND run.status = 'completed'
              AND NOT EXISTS (SELECT 1 FROM lead_result_snapshots saved
                WHERE saved.lead_id = lead.lead_id AND saved.original_run_id = run.id)))`,
    { replacements: { tenantId, batchId }, type: QueryTypes.SELECT, transaction },
  );
  if (Number(missing[0]?.count ?? 0) !== 0) throw new ConflictException("IMPORT_PRESERVATION_SNAPSHOT_INCOMPLETE");

  const preserve = await sequelize.query<{ leadId: string }>(
    `SELECT lead.lead_id AS "leadId"
       FROM business_leads lead JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id
       JOIN import_batches batch ON batch.id = result_set.batch_id AND batch.tenant_id = result_set.tenant_id
      WHERE lead.tenant_id = :tenantId AND result_set.batch_id = :batchId
        AND lead.assigned_to_user_id IS NOT NULL
        AND lead.assigned_to_user_id <> COALESCE(batch.owner_user_id, result_set.actor_user_id)
      ORDER BY lead.lead_id`,
    { replacements: { tenantId, batchId }, type: QueryTypes.SELECT, transaction },
  );
  for (const { leadId } of preserve) {
    const snapshots = await LeadResultSnapshot.findAll({
      where: { tenantId, leadId },
      order: [["originalRunId", "ASC"]],
      transaction,
    });
    for (const snapshot of snapshots) {
      const calculated = leadResultSnapshotChecksum({
        leadId: snapshot.leadId,
        tenantId: snapshot.tenantId,
        runId: snapshot.originalRunId,
        sourceRowId: snapshot.originalSourceRowId,
        sourceOwnerUserId: snapshot.sourceOwnerUserId,
        referenceDate: snapshot.referenceDate,
        companyFields: snapshot.companyFields,
        peselCiphertext: snapshot.peselCiphertext,
        peselKeyVersion: snapshot.peselKeyVersion,
        policies: snapshot.policies as never,
      });
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.policyCount !== snapshot.policies.length ||
        calculated !== snapshot.checksum
      )
        throw new ConflictException("IMPORT_PRESERVATION_SNAPSHOT_CORRUPT");
    }
  }

  // Clear notifications that point to the source import before preserving selected result sets.
  await sequelize.query(
    `DELETE FROM user_notifications notification USING result_sets result_set
      WHERE notification.result_set_id = result_set.result_set_id AND notification.tenant_id = result_set.tenant_id
        AND result_set.tenant_id = :tenantId AND result_set.batch_id = :batchId`,
    { replacements: { tenantId, batchId }, type: QueryTypes.DELETE, transaction },
  );
  await sequelize.query(
    `DELETE FROM business_leads lead USING result_sets result_set, import_batches batch
      WHERE lead.result_set_id = result_set.result_set_id AND lead.tenant_id = result_set.tenant_id
        AND batch.id = result_set.batch_id AND batch.tenant_id = result_set.tenant_id
        AND result_set.tenant_id = :tenantId AND result_set.batch_id = :batchId
        AND (lead.assigned_to_user_id IS NULL
          OR lead.assigned_to_user_id = COALESCE(batch.owner_user_id, result_set.actor_user_id))`,
    { replacements: { tenantId, batchId }, type: QueryTypes.DELETE, transaction },
  );
  await sequelize.query(
    `UPDATE result_sets result_set SET batch_id = NULL, source_import_deleted_at = COALESCE(source_import_deleted_at, now()),
           updated_at = now()
      WHERE result_set.tenant_id = :tenantId AND result_set.batch_id = :batchId
        AND EXISTS (SELECT 1 FROM business_leads lead JOIN import_batches batch
          ON batch.id = result_set.batch_id AND batch.tenant_id = result_set.tenant_id
          WHERE lead.result_set_id = result_set.result_set_id AND lead.tenant_id = result_set.tenant_id
            AND lead.assigned_to_user_id IS NOT NULL
            AND lead.assigned_to_user_id <> COALESCE(batch.owner_user_id, result_set.actor_user_id))`,
    { replacements: { tenantId, batchId }, type: QueryTypes.UPDATE, transaction },
  );

  // Submission source rows and groups hold restrictive FKs to the raw import and runs.
  await sequelize.query(
    `UPDATE run_submissions SET result_set_id = NULL WHERE tenant_id = :tenantId AND import_batch_id = :batchId`,
    { replacements: { tenantId, batchId }, type: QueryTypes.UPDATE, transaction },
  );
  await sequelize.query(`DELETE FROM run_submission_items WHERE import_batch_id = :batchId`, {
    replacements: { batchId },
    type: QueryTypes.DELETE,
    transaction,
  });
  await sequelize.query(
    `DELETE FROM run_submission_groups grp USING run_submissions submission
      WHERE grp.submission_id = submission.submission_id AND submission.tenant_id = :tenantId
        AND submission.import_batch_id = :batchId`,
    { replacements: { tenantId, batchId }, type: QueryTypes.DELETE, transaction },
  );
  await sequelize.query(`DELETE FROM run_submissions WHERE tenant_id = :tenantId AND import_batch_id = :batchId`, {
    replacements: { tenantId, batchId },
    type: QueryTypes.DELETE,
    transaction,
  });
  await sequelize.query(`DELETE FROM result_sets WHERE tenant_id = :tenantId AND batch_id = :batchId`, {
    replacements: { tenantId, batchId },
    type: QueryTypes.DELETE,
    transaction,
  });
}
