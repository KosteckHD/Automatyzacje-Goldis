import { Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";
import {
  AuthChallenge,
  AutomationRun,
  InterventionActivity,
  ManualIntervention,
  RunEvent,
  RunManualDataOverride,
  sequelize,
} from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit";

@Injectable()
export class RunResumeRepository {
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return sequelize.transaction(async (transaction) => work(transaction));
  }

  lockRun(runId: string, transaction: Transaction) {
    return AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  findSmsIntervention(runId: string, transaction: Transaction) {
    return ManualIntervention.findOne({
      where: { runId, kind: "sms", status: "open" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findLatestOpenIntervention(runId: string, transaction: Transaction) {
    return ManualIntervention.findOne({
      where: { runId, status: "open" },
      order: [["createdAt", "DESC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findActiveAuthChallenge(runId: string, transaction: Transaction) {
    return AuthChallenge.findOne({
      where: { runId, status: ["active", "claimed", "submitted"] },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findManualDataOverride(runId: string, version: number, transaction: Transaction) {
    return RunManualDataOverride.findOne({ where: { runId, version }, transaction });
  }

  saveRun(run: AutomationRun, transaction: Transaction) {
    return run.save({ transaction });
  }

  saveIntervention(incident: ManualIntervention, transaction: Transaction) {
    return incident.save({ transaction });
  }

  saveAuthChallenge(challenge: AuthChallenge, transaction: Transaction) {
    return challenge.save({ transaction });
  }

  createActivity(values: Record<string, unknown>, transaction: Transaction) {
    return InterventionActivity.create(values as never, { transaction });
  }

  createEvent(values: Record<string, unknown>, transaction: Transaction) {
    return RunEvent.create(values as never, { transaction });
  }

  recordAudit(values: Parameters<typeof recordAuditEvent>[0], transaction: Transaction) {
    return recordAuditEvent(values, transaction);
  }
}
