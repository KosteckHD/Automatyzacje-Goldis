import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Transaction } from "sequelize";
import {
  ImportPreparation,
  ImportPreparedRow,
  PreparedSetChunk,
  PreparedSetExecution,
  ResultSet,
  sequelize,
  TenantMembership,
  User,
} from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit/public";
import { requireCurrentSealedPreparation } from "../preparations/public";

const CHUNK_SIZE = 500;
const LEASE_MS = 45_000;
const activeStatuses = ["queued", "running", "waiting_attention", "pause_requested"] as const;

export type PreparedSetExecutionStatus =
  | "queued"
  | "running"
  | "waiting_attention"
  | "pause_requested"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

@Injectable()
export class PreparedSetExecutionRepository {
  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return sequelize.transaction(work);
  }

  findExistingForActor(
    tenantId: string,
    actorUserId: string,
    idempotencyKey: string,
    transaction?: Transaction,
    lock = false,
  ) {
    return PreparedSetExecution.findOne({
      where: { tenantId, actorUserId, idempotencyKey },
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findPreparation(preparationId: string, transaction?: Transaction) {
    return ImportPreparation.findByPk(preparationId, { transaction });
  }

  findLatestPreparationForBatch(batchId: string, tenantId: string) {
    return ImportPreparation.findOne({ where: { batchId, tenantId }, order: [["revision", "DESC"]] });
  }

  findLatestPreparation(batchId: string, tenantId: string, transaction: Transaction) {
    return ImportPreparation.findOne({
      where: { batchId, tenantId },
      order: [["revision", "DESC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findExecution(batchId: string, executionId: string, tenantId: string) {
    return PreparedSetExecution.findOne({ where: { executionId, batchId, tenantId } });
  }

  findExecutionById(executionId: string) {
    return PreparedSetExecution.findByPk(executionId);
  }

  findCurrentRole(userId: string, tenantId: string) {
    return Promise.all([
      User.findByPk(userId, { attributes: ["status"] }),
      TenantMembership.findOne({ where: { tenantId, userId }, attributes: ["status", "role"] }),
    ]).then(([user, membership]) =>
      user?.status === "active" && membership?.status === "active" ? membership.role : null,
    );
  }

  findNextOpenChunk(executionId: string) {
    return PreparedSetChunk.findOne({
      where: { executionId, status: { [Op.in]: ["queued", "submitting", "running", "waiting_attention"] } },
      order: [["ordinal", "ASC"]],
    });
  }

  countRemainingRows(preparationId: string, afterRowNumber: number) {
    return ImportPreparedRow.count({ where: { preparationId, rowNumber: { [Op.gt]: afterRowNumber } } });
  }

  countIncompleteChunks(executionId: string) {
    return PreparedSetChunk.count({ where: { executionId, status: { [Op.notIn]: ["completed", "cancelled"] } } });
  }

  saveChunk(chunk: PreparedSetChunk) {
    return chunk.save();
  }

  async markChunkCompleted(executionId: string, ordinal: number, now: Date) {
    await sequelize.transaction(async (transaction) => {
      const chunk = await PreparedSetChunk.findOne({
        where: { executionId, ordinal },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!chunk || chunk.status === "completed") return;
      chunk.status = "completed";
      chunk.updatedAt = now;
      chunk.finishedAt = now;
      await chunk.save({ transaction });
    });
  }

  async linkChildSubmission(executionId: string, ordinal: number, childSubmissionId: string) {
    return sequelize.transaction(async (transaction) => {
      const chunk = await PreparedSetChunk.findOne({
        where: { executionId, ordinal },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const execution = await PreparedSetExecution.findByPk(executionId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!chunk || !execution) return false;
      chunk.childSubmissionId = childSubmissionId;
      chunk.status = execution.status === "cancelled" ? "cancelled" : "running";
      chunk.updatedAt = new Date();
      await chunk.save({ transaction });
      return execution.status !== "cancelled";
    });
  }

  async release(
    input: Readonly<{
      executionId: string;
      workerId: string;
      status: PreparedSetExecutionStatus;
      errorCode: string | null;
      delayMs: number;
      terminal: boolean;
    }>,
    handlers: Readonly<{
      completeResultSet?: (status: "completed" | "cancelled" | "failed", transaction: Transaction) => Promise<void>;
      recordActionRequired?: (resultSet: ResultSet, transaction: Transaction) => Promise<void>;
    }>,
  ) {
    await sequelize.transaction(async (transaction) => {
      const execution = await PreparedSetExecution.findByPk(input.executionId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!execution || execution.leaseOwner !== input.workerId) return;
      const now = new Date();
      const preservePause = execution.status === "pause_requested" && input.status === "running" && !input.terminal;
      execution.status = preservePause ? "pause_requested" : input.status;
      execution.errorCode = input.errorCode;
      execution.leaseOwner = null;
      execution.leaseExpiresAt = null;
      execution.nextAttemptAt = input.terminal ? null : new Date(now.getTime() + input.delayMs);
      execution.finishedAt = input.terminal ? now : null;
      execution.version += 1;
      execution.updatedAt = now;
      await execution.save({ transaction });
      if (input.terminal && handlers.completeResultSet) {
        const resultSetStatus =
          input.status === "completed" ? "completed" : input.status === "cancelled" ? "cancelled" : "failed";
        await handlers.completeResultSet(resultSetStatus, transaction);
      } else if (input.status === "waiting_attention") {
        const resultSet = await ResultSet.findByPk(input.executionId, { transaction, lock: transaction.LOCK.UPDATE });
        if (resultSet && !["completed", "cancelled", "failed"].includes(resultSet.status)) {
          const enteringAttention = resultSet.status !== "waiting_attention";
          resultSet.status = "waiting_attention";
          resultSet.updatedAt = now;
          await resultSet.save({ transaction });
          if (enteringAttention) await handlers.recordActionRequired?.(resultSet, transaction);
        }
      } else if (handlers.completeResultSet && input.status === "running") {
        await ResultSet.update(
          { status: "running", updatedAt: now },
          { where: { resultSetId: input.executionId }, transaction },
        );
      }
      if (input.terminal)
        await recordAuditEvent(
          {
            tenantId: execution.tenantId,
            actorUserId: execution.actorUserId,
            action:
              input.status === "completed"
                ? "run.prepared_set.completed"
                : input.status === "failed"
                  ? "run.prepared_set.failed"
                  : "run.prepared_set.cancelled",
            resourceType: "prepared_set_execution",
            resourceId: input.executionId,
            outcome: input.status === "completed" ? "succeeded" : "failed",
            metadata: { chunkCount: execution.chunkCount, errorCode: input.errorCode },
          },
          transaction,
        );
    });
  }

  findChunks(executionId: string, afterOrdinal: number, limit: number, transaction?: Transaction) {
    return PreparedSetChunk.findAll({
      where: { executionId, ordinal: { [Op.gt]: afterOrdinal } },
      order: [["ordinal", "ASC"]],
      limit,
      transaction,
    });
  }

  countChunkStatuses(executionId: string, transaction?: Transaction) {
    return sequelize.query<{ status: string; count: number }>(
      "SELECT status, COUNT(*)::int AS count FROM prepared_set_chunks WHERE execution_id = :executionId GROUP BY status",
      { replacements: { executionId }, type: QueryTypes.SELECT, transaction },
    );
  }

  createExecution(values: Record<string, unknown>, transaction: Transaction) {
    return PreparedSetExecution.create(values as never, { transaction });
  }

  createResultSet(values: Record<string, unknown>, transaction: Transaction) {
    return ResultSet.create(values as never, { transaction });
  }

  recordAudit(values: Parameters<typeof recordAuditEvent>[0], transaction: Transaction) {
    return recordAuditEvent(values, transaction);
  }

  claim(workerId: string): Promise<string | null> {
    const now = new Date();
    return sequelize.transaction(async (transaction) => {
      const execution = await PreparedSetExecution.findOne({
        where: {
          status: { [Op.in]: [...activeStatuses] },
          [Op.and]: [
            { [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: now } }] },
            { [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: now } }] },
          ],
        },
        order: [
          ["createdAt", "ASC"],
          ["executionId", "ASC"],
        ],
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!execution) return null;
      execution.leaseOwner = workerId;
      execution.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      if (execution.status !== "pause_requested") execution.status = "running";
      execution.version += 1;
      execution.updatedAt = now;
      await execution.save({ transaction });
      return execution.executionId;
    });
  }

  ensureChunk(executionId: string, workerId: string): Promise<PreparedSetChunk | null> {
    return sequelize.transaction(async (transaction) => {
      const execution = await PreparedSetExecution.findByPk(executionId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!execution || execution.leaseOwner !== workerId || execution.status !== "running") return null;
      const inFlight = await PreparedSetChunk.findOne({
        where: { executionId, status: { [Op.in]: ["queued", "submitting", "running", "waiting_attention"] } },
        order: [["ordinal", "ASC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (inFlight) return inFlight;
      await requireCurrentSealedPreparation(execution.batchId, [], transaction, execution.preparationId);
      const rows = await ImportPreparedRow.findAll({
        where: { preparationId: execution.preparationId, rowNumber: { [Op.gt]: execution.cursorRowNumber } },
        attributes: ["rowNumber"],
        order: [["rowNumber", "ASC"]],
        limit: CHUNK_SIZE,
        transaction,
      });
      if (!rows.length) return null;
      const rowNumbers = rows.map((row) => row.rowNumber);
      const ordinal = execution.chunkCount + 1;
      const now = new Date();
      const chunk = await PreparedSetChunk.create(
        {
          executionId,
          ordinal,
          rowNumbers,
          firstRowNumber: rowNumbers[0],
          lastRowNumber: rowNumbers[rowNumbers.length - 1],
          inputFingerprint: digest([execution.preparationId, rowNumbers]),
          status: "queued",
          childSubmissionId: null,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
        },
        { transaction },
      );
      execution.cursorRowNumber = rowNumbers[rowNumbers.length - 1];
      execution.chunkCount = ordinal;
      execution.version += 1;
      execution.updatedAt = now;
      await execution.save({ transaction });
      return chunk;
    });
  }
}
