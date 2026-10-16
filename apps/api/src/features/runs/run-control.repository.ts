import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import { AutomationRun, ImportBatch, RunDispatchOutbox, RunEvent, sequelize } from "../../infrastructure/database/db";
import type { AuditActorContext } from "../audit/public";
import { recordAuditEvent } from "../audit/public";
import type { RunControlRequest } from "./run-control.dto";

export type StoredRunControlRequest = Readonly<{
  action: string;
  expectedRevision: string;
  response: Record<string, unknown>;
}>;

@Injectable()
export class RunControlRepository {
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return sequelize.transaction(async (transaction) => work(transaction));
  }

  lockRun(runId: string, transaction: Transaction) {
    return AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  async findTenantId(batchId: string, transaction: Transaction): Promise<string | null> {
    const batch = await ImportBatch.findByPk(batchId, { attributes: ["tenantId"], transaction });
    return batch?.tenantId ?? null;
  }

  async findControlRequest(
    runId: string,
    actor: AuditActorContext,
    request: RunControlRequest,
    transaction: Transaction,
  ): Promise<StoredRunControlRequest | null> {
    const rows = await sequelize.query<StoredRunControlRequest>(
      `SELECT action, expected_revision AS "expectedRevision", response
         FROM run_control_requests
        WHERE tenant_id = :tenantId AND run_id = :runId AND actor_user_id = :actorUserId
          AND idempotency_key = :idempotencyKey FOR UPDATE`,
      {
        replacements: {
          tenantId: actor.tenantId,
          runId,
          actorUserId: actor.actorUserId,
          idempotencyKey: request.idempotencyKey,
        },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return rows[0] ?? null;
  }

  saveRun(run: AutomationRun, transaction: Transaction) {
    return run.save({ transaction });
  }

  cancelPendingDispatches(runId: string, now: Date, transaction: Transaction) {
    return RunDispatchOutbox.update(
      { status: "cancelled", claimedAt: null, claimedBy: null, updatedAt: now },
      { where: { runId, status: ["pending", "publishing", "published"] }, transaction },
    );
  }

  createEvent(values: Record<string, unknown>, transaction: Transaction) {
    return RunEvent.create(values as never, { transaction });
  }

  recordAudit(values: Parameters<typeof recordAuditEvent>[0], transaction: Transaction) {
    return recordAuditEvent(values, transaction);
  }

  async storeControlRequest(
    runId: string,
    actor: AuditActorContext,
    action: "pause" | "resume",
    request: RunControlRequest,
    resultingRevision: string,
    response: Record<string, unknown>,
    now: Date,
    transaction: Transaction,
  ) {
    await sequelize.query(
      `INSERT INTO run_control_requests
         (request_id, tenant_id, run_id, actor_user_id, idempotency_key, action, expected_revision, result_revision, response, created_at)
       VALUES (:requestId, :tenantId, :runId, :actorUserId, :idempotencyKey, :action, :expectedRevision,
         :resultRevision, CAST(:response AS jsonb), :now)`,
      {
        replacements: {
          requestId: randomUUID(),
          tenantId: actor.tenantId,
          runId,
          actorUserId: actor.actorUserId,
          idempotencyKey: request.idempotencyKey,
          action,
          expectedRevision: request.expectedRevision,
          resultRevision: resultingRevision,
          response: JSON.stringify(response),
          now,
        },
        transaction,
      },
    );
  }
}
