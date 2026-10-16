import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Op, type Transaction } from "sequelize";
import {
  AutomationRun,
  ManualIntervention,
  RunDispatchOutbox,
  RunEvent,
  sequelize,
} from "../../infrastructure/database/db";

const recoverableStatuses = [
  "queued",
  "validating",
  "pzu_login",
  "everest_search",
  "compensa_login",
  "compensa_form",
  "ufg_verification",
  "reading_oc",
  "export_ready",
] as const;

@Injectable()
export class RunRecoveryRepository {
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return sequelize.transaction(async (transaction) => work(transaction));
  }

  findResultRuns(transaction: Transaction, now: Date) {
    return AutomationRun.findAll({
      where: {
        status: ["reading_oc", "export_ready"],
        [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: now } }],
      },
      order: [["updatedAt", "ASC"]],
      limit: 100,
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
  }

  findOrphanCandidates(now: Date) {
    return AutomationRun.findAll({
      where: {
        status: recoverableStatuses,
        [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: now } }],
      },
      order: [["updatedAt", "ASC"]],
      limit: 50,
    });
  }

  withRecoverableRun<T>(
    runId: string,
    work: (run: AutomationRun, transaction: Transaction) => Promise<T>,
  ): Promise<T | null> {
    return sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (
        !run ||
        !recoverableStatuses.includes(run.status as (typeof recoverableStatuses)[number]) ||
        (run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now())
      ) {
        return null;
      }
      const dispatch = await RunDispatchOutbox.findOne({
        where: { runId: run.id, status: ["pending", "publishing", "published"] },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (dispatch) return null;
      const incident = await ManualIntervention.findOne({
        where: { runId: run.id, status: "open" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (incident) return null;
      return work(run, transaction);
    });
  }

  async requireManualReview(run: AutomationRun, attemptCount: number, now: Date, transaction: Transaction) {
    run.status = "waiting_for_manual_data";
    run.currentStep = "waiting_for_manual_data";
    run.errorCode = "PORTAL_FAILURE";
    run.updatedAt = now;
    await run.save({ transaction });
    await ManualIntervention.create(
      {
        interventionId: randomUUID(),
        runId: run.id,
        challengeId: null,
        portal: null,
        kind: "portal_error",
        status: "open",
        reasonCode: "PORTAL_FAILURE",
        createdAt: now,
        resolvedAt: null,
        resolvedBy: null,
      },
      { transaction },
    );
    await RunEvent.create(
      {
        runId: run.id,
        status: run.status,
        step: "operator_review_required",
        errorCode: "PORTAL_FAILURE",
        actorId: null,
        metadata: { source: "lease_recovery", attempts: attemptCount },
        createdAt: now,
      },
      { transaction },
    );
  }

  async scheduleRecovery(
    run: AutomationRun,
    attemptCount: number,
    intent: "recovery" | "result_delivery",
    delayMs: number,
    now: Date,
    transaction: Transaction,
  ) {
    run.technicalCycleId ??= randomUUID();
    run.technicalAttemptCount = attemptCount;
    run.updatedAt = now;
    await run.save({ transaction });
    const next = new Date(Date.now() + delayMs);
    await RunDispatchOutbox.create(
      {
        dispatchId: randomUUID(),
        runId: run.id,
        intentType: intent,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: next,
        claimedAt: null,
        claimedBy: null,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now,
      },
      { transaction },
    );
    await RunEvent.create(
      {
        runId: run.id,
        status: run.status,
        step: "lease_recovery_scheduled",
        errorCode: null,
        actorId: null,
        metadata: { intent, delaySeconds: delayMs / 1000, attempt: attemptCount },
        createdAt: now,
      },
      { transaction },
    );
  }
}
