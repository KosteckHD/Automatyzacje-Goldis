import { Injectable, NotFoundException } from "@nestjs/common";
import { Op, type Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { ImportBatch, RunSubmission, RunSubmissionGroup, sequelize } from "../../infrastructure/database/db";
import { type AuditActorContext, recordAuditEvent } from "../audit/public";

@Injectable()
export class RunSubmissionCancellationRepository {
  withLockedSubmission<T>(
    id: string,
    actor: AuditActorContext,
    work: (submission: RunSubmission, batch: ImportBatch, transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return sequelize.transaction(async (transaction) => {
      await lockUsersInTransaction([actor.actorUserId], transaction);
      const submission = await RunSubmission.findOne({
        where: { submissionId: id, tenantId: actor.tenantId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!submission) throw new NotFoundException("Nie znaleziono partii");
      const batch = await ImportBatch.findByPk(submission.importBatchId, { transaction });
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException("Nie znaleziono partii");
      return work(submission, batch, transaction);
    });
  }

  cancelUnadmittedGroups(submissionId: string, now: Date, transaction: Transaction) {
    return RunSubmissionGroup.update(
      {
        admissionState: "cancelled",
        reasonCode: "SUBMISSION_CANCELLED",
        nextAttemptAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        version: sequelize.literal("version + 1"),
        updatedAt: now,
      },
      {
        where: {
          submissionId,
          runId: null,
          admissionState: ["pending", "leased", "waiting_capacity", "waiting_window", "waiting_paused"],
        },
        transaction,
      },
    );
  }

  saveSubmission(submission: RunSubmission, transaction: Transaction) {
    return submission.save({ transaction });
  }

  recordCancelled(submissionId: string, actor: AuditActorContext, transaction: Transaction) {
    return recordAuditEvent(
      {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: "run.submission.cancelled",
        resourceType: "run_submission",
        resourceId: submissionId,
        outcome: "succeeded",
      },
      transaction,
    );
  }

  async hasAcceptedRuns(submissionId: string, transaction: Transaction): Promise<boolean> {
    return (
      (await RunSubmissionGroup.count({
        where: { submissionId, runId: { [Op.ne]: null } },
        transaction,
      })) > 0
    );
  }
}
