import { Injectable, NotFoundException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { PreparedSetChunk, PreparedSetExecution, sequelize } from "../../infrastructure/database/db";
import { type AuditActorContext, recordAuditEvent } from "../audit/public";

@Injectable()
export class PreparedSetExecutionControlRepository {
  withLockedExecution<T>(
    executionId: string,
    batchId: string,
    tenantId: string,
    work: (execution: PreparedSetExecution, transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return sequelize.transaction(async (transaction) => {
      const execution = await PreparedSetExecution.findOne({
        where: { executionId, batchId, tenantId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!execution) throw new NotFoundException("Nie znaleziono wykonania zestawu");
      return work(execution, transaction);
    });
  }

  findLatestOpenChunk(executionId: string, transaction: Transaction) {
    return PreparedSetChunk.findOne({
      where: { executionId, status: ["queued", "running", "submitting", "waiting_attention"] },
      order: [["ordinal", "DESC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  saveExecution(execution: PreparedSetExecution, transaction: Transaction) {
    return execution.save({ transaction });
  }

  saveChunk(chunk: PreparedSetChunk, transaction: Transaction) {
    return chunk.save({ transaction });
  }

  recordControlEvent(input: Parameters<typeof recordAuditEvent>[0], transaction: Transaction) {
    return recordAuditEvent(input, transaction);
  }

  recordCancellation(
    actor: AuditActorContext,
    executionId: string,
    acceptedChildContinues: boolean,
    transaction: Transaction,
  ) {
    return this.recordControlEvent(
      {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: "run.prepared_set.cancelled",
        resourceType: "prepared_set_execution",
        resourceId: executionId,
        outcome: "succeeded",
        metadata: { acceptedChildContinues },
      },
      transaction,
    );
  }
}
