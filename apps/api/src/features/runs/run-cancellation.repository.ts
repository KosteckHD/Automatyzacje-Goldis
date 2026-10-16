import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AuthChallenge,
  AutomationRun,
  ManualIntervention,
  RunDispatchOutbox,
  RunEvent,
  sequelize,
} from "../../infrastructure/database/db";
import { type AuditActorContext, recordAuditEvent } from "../audit/public";

export type RunCancellationPersistenceResult = Readonly<{
  run: AutomationRun;
  invalidatedChallengeId: string | null;
}>;

@Injectable()
export class RunCancellationRepository {
  async cancel(runId: string, actor: AuditActorContext): Promise<RunCancellationPersistenceResult> {
    return sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new NotFoundException("Nie znaleziono zadania");
      if (run.status === "cancelled") return { run, invalidatedChallengeId: null };
      if (run.status !== "queued" && run.status !== "awaiting_portal_adapter" && run.status !== "waiting_for_sms") {
        throw new ConflictException("Nie można anulować zadania w tym kroku");
      }

      let invalidatedChallengeId: string | null = null;
      if (run.status === "waiting_for_sms") {
        const challenge = run.currentAuthChallengeId
          ? await AuthChallenge.findByPk(run.currentAuthChallengeId, { transaction, lock: transaction.LOCK.UPDATE })
          : null;
        // Claim means the one-time code may already be crossing the private worker
        // boundary. Do not report cancellation while that outcome is uncertain.
        // Once delivery resolves, the operator can retry; the run/challenge row
        // locks serialize that retry with SMS submission.
        if (challenge && challenge.runId === run.id && challenge.status === "claimed") {
          throw new ConflictException(
            "Przekazanie kodu SMS jest w toku; ponów anulowanie po rozstrzygnięciu przekazania",
          );
        }
        if (challenge && challenge.runId === run.id && ["active", "submitted"].includes(challenge.status)) {
          challenge.status = "invalidated";
          challenge.updatedAt = new Date();
          await challenge.save({ transaction });
          invalidatedChallengeId = challenge.challengeId;
          await ManualIntervention.update(
            {
              status: "cancelled",
              resolvedAt: challenge.updatedAt,
              reasonCode: "RUN_CANCELLED",
              updatedAt: challenge.updatedAt,
              revision: sequelize.literal("revision + 1"),
            },
            {
              where: { challengeId: invalidatedChallengeId, status: "open" },
              transaction,
            },
          );
        }
      }

      const now = new Date();
      run.status = "cancelled";
      run.currentStep = "cancelled";
      run.finishedAt = now;
      if (run.controlState !== "running") {
        run.controlState = "running";
        run.controlRevision = String(BigInt(run.controlRevision ?? 0) + 1n);
        run.controlRequestedBy = actor.actorUserId;
        run.controlRequestedAt = now;
      }
      await run.save({ transaction });
      await RunDispatchOutbox.update(
        { status: "cancelled", claimedAt: null, claimedBy: null, updatedAt: now },
        {
          where: { runId: run.id, status: ["pending", "publishing", "published"] },
          transaction,
        },
      );
      await RunEvent.create(
        {
          runId: run.id,
          status: "cancelled",
          step: "cancelled",
          errorCode: null,
          metadata: invalidatedChallengeId
            ? { challengeId: invalidatedChallengeId, reason: "operator_cancelled_during_sms" }
            : {},
          createdAt: now,
        },
        { transaction },
      );
      await recordAuditEvent(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          action: "run.cancelled",
          resourceType: "run",
          resourceId: run.id,
          outcome: "succeeded",
        },
        transaction,
      );
      return { run, invalidatedChallengeId };
    });
  }
}
