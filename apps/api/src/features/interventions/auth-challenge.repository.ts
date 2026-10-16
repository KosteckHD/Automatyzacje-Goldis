import { Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";
import {
  AuthChallenge,
  AutomationRun,
  ManualIntervention,
  RunEvent,
  sequelize,
} from "../../infrastructure/database/db";
import { type AuditActorContext, recordAuditEvent } from "../audit/public";

@Injectable()
export class AuthChallengeRepository {
  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return sequelize.transaction(work);
  }

  findRun(runId: string, transaction: Transaction, lock = false) {
    return AutomationRun.findByPk(runId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  }

  findChallenge(challengeId: string, transaction: Transaction, lock = false) {
    return AuthChallenge.findByPk(challengeId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  }

  findChallengeReference(challengeId: string, transaction: Transaction) {
    return AuthChallenge.findByPk(challengeId, { attributes: ["runId"], transaction });
  }

  saveChallenge(challenge: AuthChallenge, transaction: Transaction) {
    return challenge.save({ transaction });
  }

  saveRun(run: AutomationRun, transaction: Transaction) {
    return run.save({ transaction });
  }

  updateOpenIntervention(challengeId: string, reasonCode: string, now: Date, transaction: Transaction) {
    return ManualIntervention.update(
      { reasonCode, revision: sequelize.literal("revision + 1"), updatedAt: now },
      { where: { challengeId, status: "open" }, transaction },
    );
  }

  createRunEvent(values: Record<string, unknown>, options: { transaction: Transaction }) {
    return RunEvent.create(values as never, options);
  }

  recordAudit(input: Parameters<typeof recordAuditEvent>[0], transaction: Transaction) {
    return recordAuditEvent(input, transaction);
  }

  recordSmsSubmission(
    actor: AuditActorContext,
    runId: string,
    outcome: "succeeded" | "failed",
    transaction: Transaction,
  ) {
    return this.recordAudit(
      {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: "sms.submitted",
        resourceType: "run",
        resourceId: runId,
        outcome,
      },
      transaction,
    );
  }
}
