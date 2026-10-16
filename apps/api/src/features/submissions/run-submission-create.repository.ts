import { Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import {
  CanonicalEntity,
  ImportBatch,
  ResultSet,
  RunSubmission,
  RunSubmissionGroup,
  RunSubmissionItem,
  SourceEntityLink,
  SourceRow,
  sequelize,
  ToolSettings,
} from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit/public";

@Injectable()
export class RunSubmissionCreateRepository {
  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return sequelize.transaction(work);
  }

  lockActor(actorUserId: string, transaction: Transaction) {
    return lockUsersInTransaction([actorUserId], transaction);
  }

  findToolSettings(tenantId: string, toolId: string, transaction: Transaction) {
    return ToolSettings.findOne({
      where: { tenantId, toolId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findBatch(batchId: string, transaction: Transaction, lock = false) {
    return ImportBatch.findByPk(batchId, {
      transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findByActorKey(
    tenantId: string,
    actorUserId: string,
    idempotencyKey: string,
    transaction?: Transaction,
    lock = false,
  ) {
    return RunSubmission.findOne({
      where: { tenantId, actorUserId, idempotencyKey },
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findEntityLink(sourceRowId: string, tenantId: string, transaction: Transaction) {
    return SourceEntityLink.findOne({ where: { sourceRowId, tenantId }, transaction });
  }

  findSourceRow(sourceRowId: string, transaction: Transaction) {
    return SourceRow.findByPk(sourceRowId, { transaction });
  }

  findCanonicalEntity(canonicalEntityId: string, tenantId: string, transaction: Transaction) {
    return CanonicalEntity.findOne({ where: { canonicalEntityId, tenantId }, transaction });
  }

  findParentResultSet(resultSetId: string, tenantId: string, transaction: Transaction) {
    return ResultSet.findOne({
      where: { resultSetId, tenantId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  createResultSet(values: Record<string, unknown>, transaction: Transaction) {
    return ResultSet.create(values as never, { transaction });
  }

  createSubmission(values: Record<string, unknown>, transaction: Transaction) {
    return RunSubmission.create(values as never, { transaction });
  }

  createGroup(values: Record<string, unknown>, transaction: Transaction) {
    return RunSubmissionGroup.create(values as never, { transaction });
  }

  createItems(values: readonly Record<string, unknown>[], transaction: Transaction) {
    return RunSubmissionItem.bulkCreate([...values] as never, { transaction });
  }

  recordCreated(input: Parameters<typeof recordAuditEvent>[0], transaction: Transaction) {
    return recordAuditEvent(input, transaction);
  }
}
