import { Inject, Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import {
  EnrichmentJob,
  EnrichmentJobItem,
  EntityGroupingConflict,
  ImportBatch,
  RegonCorrection,
  SourceRow,
  sequelize,
  TenantMembership,
  Tool,
  ToolGrant,
  User,
} from "../../infrastructure/database/db";

@Injectable()
export class EnrichmentJobsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize = sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return this.database.transaction(work);
  }

  findBatchForUpdate(batchId: string, transaction: Transaction) {
    return ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  findBatchForTenant(batchId: string, tenantId: string) {
    return ImportBatch.findOne({ where: { id: batchId, tenantId } });
  }

  findJobForIdempotency(input: {
    batchId: string;
    tenantId: string;
    actorUserId: string;
    idempotencyKey: string;
    transaction: Transaction;
  }) {
    return EnrichmentJob.findOne({
      where: {
        batchId: input.batchId,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
      },
      transaction: input.transaction,
      lock: input.transaction.LOCK.UPDATE,
    });
  }

  findSelectedRows(batchId: string, rowNumbers: number[], transaction: Transaction) {
    return SourceRow.findAll({
      where: { batchId, rowNumber: rowNumbers },
      order: [["rowNumber", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findPendingCorrectionRowIds(sourceRowIds: string[], transaction: Transaction) {
    return RegonCorrection.findAll({
      where: { sourceRowId: sourceRowIds, status: "pending" },
      attributes: ["sourceRowId"],
      transaction,
    });
  }

  findOpenConflictRowIds(sourceRowIds: string[], transaction: Transaction) {
    return EntityGroupingConflict.findAll({
      where: { sourceRowId: sourceRowIds, status: "open" },
      attributes: ["sourceRowId"],
      transaction,
    });
  }

  async findRowsAlreadyInRuns(batchId: string, sourceRowIds: string[], transaction: Transaction) {
    const rows = await this.database.query<{ source_row_id: string }>(
      `SELECT DISTINCT selected.id AS source_row_id FROM source_rows AS selected
         JOIN automation_runs AS run ON run.batch_id = selected.batch_id
        WHERE selected.batch_id = $1 AND selected.id = ANY($2::uuid[])
          AND (run.source_row_id = selected.id OR EXISTS (
            SELECT 1 FROM run_source_rows AS member WHERE member.run_id = run.id AND member.source_row_id = selected.id
          ))`,
      { bind: [batchId, sourceRowIds], transaction, type: QueryTypes.SELECT },
    );
    return rows.map((row) => row.source_row_id);
  }

  async isToolAvailable(toolId: string, transaction: Transaction): Promise<boolean> {
    const tool = await Tool.findByPk(toolId, {
      attributes: ["status"],
      transaction,
      lock: transaction.LOCK.SHARE,
    });
    return tool?.status === "available";
  }

  hasExecuteGrant(input: { tenantId: string; userId: string; toolId: string; transaction: Transaction }) {
    return ToolGrant.findOne({
      where: { tenantId: input.tenantId, userId: input.userId, toolId: input.toolId, canExecute: true },
      attributes: ["userId"],
      transaction: input.transaction,
      lock: input.transaction.LOCK.SHARE,
    });
  }

  createJob(input: Parameters<typeof EnrichmentJob.create>[0], transaction: Transaction) {
    return EnrichmentJob.create(input, { transaction });
  }

  createItems(input: Parameters<typeof EnrichmentJobItem.bulkCreate>[0], transaction: Transaction) {
    return EnrichmentJobItem.bulkCreate(input, { transaction });
  }

  findJobForTenant(jobId: string, tenantId: string) {
    return EnrichmentJob.findOne({ where: { jobId, tenantId } });
  }

  countActiveItems(jobId: string) {
    return EnrichmentJobItem.count({ where: { jobId, status: ["pending", "processing"] } });
  }

  findJobsForBatch(batchId: string, tenantId: string) {
    return EnrichmentJob.findAll({
      where: { batchId, tenantId },
      order: [
        ["createdAt", "DESC"],
        ["jobId", "DESC"],
      ],
      limit: 20,
    });
  }

  findItemsPage(jobId: string, firstRowNumber: number) {
    return EnrichmentJobItem.findAll({
      where: { jobId, rowNumber: { [Op.gte]: firstRowNumber } },
      order: [["rowNumber", "ASC"]],
      limit: 51,
      attributes: [
        "rowNumber",
        "expectedRowVersion",
        "status",
        "reasonCode",
        "errorCode",
        "attemptCount",
        "nextAttemptAt",
        "updatedAt",
        "finishedAt",
      ],
    });
  }

  findJobForUpdate(jobId: string, tenantId: string, transaction: Transaction) {
    return EnrichmentJob.findOne({
      where: { jobId, tenantId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findBatchForJobForShare(batchId: string, transaction: Transaction) {
    return ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.SHARE });
  }

  async cancelPendingItems(jobId: string, now: Date, transaction: Transaction) {
    const rows = await this.database.query<{ item_id: string }>(
      `UPDATE enrichment_job_items SET status = 'cancelled', updated_at = $1, finished_at = $1
        WHERE job_id = $2 AND status IN ('pending', 'processing') RETURNING item_id`,
      { bind: [now, jobId], transaction, type: QueryTypes.SELECT },
    );
    return rows.length;
  }

  saveJob(job: EnrichmentJob, transaction: Transaction) {
    return job.save({ transaction });
  }

  findJobByIdForUpdate(jobId: string, transaction: Transaction) {
    return EnrichmentJob.findByPk(jobId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  findItemByIdForUpdate(itemId: string, transaction: Transaction) {
    return EnrichmentJobItem.findByPk(itemId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  findBatchByTenantForUpdate(batchId: string, tenantId: string, transaction: Transaction) {
    return ImportBatch.findOne({
      where: { id: batchId, tenantId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findBatchByTenantForShare(batchId: string, tenantId: string, transaction: Transaction) {
    return ImportBatch.findOne({
      where: { id: batchId, tenantId },
      transaction,
      lock: transaction.LOCK.SHARE,
    });
  }

  findSourceRowForUpdate(batchId: string, sourceRowId: string, transaction: Transaction) {
    return SourceRow.findOne({
      where: { id: sourceRowId, batchId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findPendingCorrection(sourceRowId: string, transaction: Transaction) {
    return RegonCorrection.findOne({
      where: { sourceRowId, status: "pending" },
      attributes: ["correctionId"],
      transaction,
    });
  }

  findOpenGroupingConflict(sourceRowId: string, transaction: Transaction) {
    return EntityGroupingConflict.findOne({
      where: { sourceRowId, status: "open" },
      attributes: ["conflictId"],
      transaction,
    });
  }

  async hasRunForSourceRow(batchId: string, sourceRowId: string, transaction: Transaction) {
    const rows = await this.database.query<{ id: string }>(
      `SELECT run.id FROM automation_runs AS run
        WHERE run.batch_id = $1 AND (run.source_row_id = $2 OR EXISTS (
          SELECT 1 FROM run_source_rows AS member WHERE member.run_id = run.id AND member.source_row_id = $2
        )) LIMIT 1 FOR UPDATE OF run`,
      { bind: [batchId, sourceRowId], transaction, type: QueryTypes.SELECT },
    );
    return rows.length > 0;
  }

  findUserStatusForShare(userId: string, transaction: Transaction) {
    return User.findByPk(userId, { attributes: ["status"], transaction, lock: transaction.LOCK.SHARE });
  }

  findActiveMembershipForShare(tenantId: string, userId: string, transaction: Transaction) {
    return TenantMembership.findOne({
      where: { tenantId, userId, status: "active" },
      attributes: ["role"],
      transaction,
      lock: transaction.LOCK.SHARE,
    });
  }

  saveItem(item: EnrichmentJobItem, transaction: Transaction) {
    return item.save({ transaction });
  }

  findAdditionalClaimCandidates(input: {
    jobId: string;
    excludeItemId: string;
    now: Date;
    maximum: number;
    transaction: Transaction;
  }) {
    return this.database.query<{
      item_id: string;
      source_row_id: string;
      row_number: number;
      expected_row_version: number;
      attempt_count: number;
    }>(
      `SELECT item.item_id, item.source_row_id, item.row_number, item.expected_row_version, item.attempt_count
         FROM enrichment_job_items AS item
         JOIN source_rows AS source ON source.id = item.source_row_id AND source.batch_id = item.batch_id
        WHERE item.job_id = $1 AND item.item_id <> $2 AND item.status = 'pending'
          AND (item.next_attempt_at IS NULL OR item.next_attempt_at <= $3)
        ORDER BY item.row_number, item.item_id
        LIMIT $4 FOR UPDATE OF item SKIP LOCKED`,
      {
        bind: [input.jobId, input.excludeItemId, input.now, input.maximum],
        transaction: input.transaction,
        type: QueryTypes.SELECT,
      },
    );
  }

  findAvailableWorkerSlot(workerId: string, now: Date, transaction: Transaction) {
    return this.database.query<{ slot_id: number }>(
      `SELECT slot_id FROM enrichment_worker_slots
        WHERE lease_owner = $1 OR lease_expires_at IS NULL OR lease_expires_at <= $2
        ORDER BY CASE WHEN lease_owner = $1 THEN 0 ELSE 1 END, slot_id
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      { bind: [workerId, now], transaction, type: QueryTypes.SELECT },
    );
  }

  setWorkerSlotLease(slotId: number, workerId: string, expiresAt: Date, transaction: Transaction) {
    return this.database.query(
      `UPDATE enrichment_worker_slots SET lease_owner = $1, lease_expires_at = $2 WHERE slot_id = $3`,
      { bind: [workerId, expiresAt, slotId], transaction },
    );
  }

  clearWorkerSlotLease(slotId: number, transaction: Transaction) {
    return this.database.query(
      `UPDATE enrichment_worker_slots SET lease_owner = NULL, lease_expires_at = NULL WHERE slot_id = $1`,
      { bind: [slotId], transaction },
    );
  }

  clearWorkerSlots(workerId: string) {
    return this.database.query(
      `UPDATE enrichment_worker_slots SET lease_owner = NULL, lease_expires_at = NULL WHERE lease_owner = $1`,
      { bind: [workerId] },
    );
  }

  findClaimableJob(workerId: string, now: Date, transaction: Transaction) {
    return this.database.query<{ job_id: string; batch_id: string }>(
      `SELECT job.job_id, job.batch_id FROM enrichment_jobs AS job
        WHERE job.cancel_requested = FALSE AND job.status IN ('queued', 'processing')
          AND (job.lease_owner = $1 OR job.lease_expires_at IS NULL OR job.lease_expires_at <= $2)
          AND EXISTS (SELECT 1 FROM enrichment_job_items AS item
            WHERE item.job_id = job.job_id AND item.status IN ('pending', 'processing')
              AND (item.next_attempt_at IS NULL OR item.next_attempt_at <= $2))
        ORDER BY CASE WHEN job.lease_owner = $1 THEN 0 ELSE 1 END, job.created_at, job.job_id
        LIMIT 1 FOR UPDATE OF job SKIP LOCKED`,
      { bind: [workerId, now], transaction, type: QueryTypes.SELECT },
    );
  }

  findFirstClaimableItem(jobId: string, now: Date, transaction: Transaction) {
    return this.database.query<{
      item_id: string;
      source_row_id: string;
      row_number: number;
      expected_row_version: number;
      attempt_count: number;
    }>(
      `SELECT item_id, source_row_id, row_number, expected_row_version, attempt_count
         FROM enrichment_job_items
        WHERE job_id = $1 AND status IN ('pending', 'processing') AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
        ORDER BY row_number, item_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      { bind: [jobId, now], transaction, type: QueryTypes.SELECT },
    );
  }

  async excludeUnfinishedItems(jobId: string, reasonCode: string, now: Date, transaction: Transaction) {
    return this.database.query(
      `UPDATE enrichment_job_items SET status = 'excluded', reason_code = $1,
         error_code = NULL, updated_at = $2, finished_at = $2
        WHERE job_id = $3 AND status IN ('pending', 'processing')`,
      { bind: [reasonCode, now, jobId], transaction },
    );
  }

  async countJobItemsByStatus(jobId: string, transaction: Transaction) {
    return this.database.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM enrichment_job_items WHERE job_id = $1 GROUP BY status`,
      { bind: [jobId], transaction, type: QueryTypes.SELECT },
    );
  }
}
