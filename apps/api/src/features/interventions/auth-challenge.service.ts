import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AuditActorContext } from "../audit/public";

import { AuthChallengeRepository } from "./auth-challenge.repository";
import { WorkerCodeForwarder } from "./worker-code-forwarder";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^\d{4,10}$/;

export type ClaimedAuthCode = Readonly<{
  challengeId: string;
  runId: string;
  portal: "pzu" | "compensa";
  attemptCount: number;
}>;

type ClaimResult =
  | Readonly<{ kind: "claimed"; claim: ClaimedAuthCode }>
  | Readonly<{ kind: "missing" | "run_missing" | "wrong_run" | "expired" | "conflict" }>;

@Injectable()
export class AuthChallengeService {
  constructor(
    @Inject(WorkerCodeForwarder) private readonly forwarder: WorkerCodeForwarder,
    @Optional()
    @Inject(AuthChallengeRepository)
    private readonly repository: AuthChallengeRepository = new AuthChallengeRepository(),
  ) {}

  async getForRun(runId: string, userId: string) {
    if (!uuidPattern.test(runId)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    return this.repository.transaction(async (transaction) => {
      const run = await this.repository.findRun(runId, transaction, true);
      if (!run) throw new NotFoundException("Nie znaleziono zadania");
      if (run.startedByUserId !== userId) return null;
      if (run.status !== "waiting_for_sms") return null;
      if (!run.currentAuthChallengeId) return null;
      const challenge = await this.repository.findChallenge(run.currentAuthChallengeId, transaction, true);
      if (!challenge || challenge.runId !== run.id || challenge.challengeId !== run.currentAuthChallengeId) return null;
      const now = new Date();
      if (["active", "claimed"].includes(challenge.status) && challenge.expiresAt.getTime() <= now.getTime()) {
        challenge.status = "expired";
        challenge.updatedAt = now;
        await this.repository.saveChallenge(challenge, transaction);
        await this.repository.updateOpenIntervention(challenge.challengeId, "SMS_TIMEOUT", now, transaction);
        run.status = "waiting_for_manual_data";
        run.currentStep = "waiting_for_manual_data";
        run.errorCode = "SMS_RETRY_REQUIRED";
        await this.repository.saveRun(run, transaction);
        await this.repository.createRunEvent(
          {
            id: randomUUID(),
            runId,
            status: "waiting_for_manual_data",
            step: "sms_timeout",
            errorCode: "SMS_RETRY_REQUIRED",
            actorId: null,
            metadata: { challengeId: challenge.challengeId, portal: challenge.portal },
            createdAt: now,
          },
          { transaction },
        );
        return null;
      }
      if (!["active", "claimed", "submitted"].includes(challenge.status)) return null;
      return {
        challengeId: challenge.challengeId,
        runId: challenge.runId,
        portal: challenge.portal,
        status: challenge.status,
        expiresAt: challenge.expiresAt,
        attemptCount: challenge.attemptCount,
        attemptLimit: challenge.attemptLimit,
        serverNow: now.toISOString(),
        reasonCode: run.errorCode === "SMS_CODE_REJECTED" ? "SMS_CODE_REJECTED" : "SMS_REQUIRED",
      };
    });
  }

  async submitCode(challengeId: string, runId: string, code: string, actor: AuditActorContext) {
    if (!uuidPattern.test(challengeId) || !uuidPattern.test(runId) || !codePattern.test(code)) {
      throw new BadRequestException("Nieprawidłowe dane kodu weryfikacyjnego");
    }

    const result = await this.claim(challengeId, runId, actor.actorUserId);
    if (result.kind === "missing" || result.kind === "run_missing")
      throw new NotFoundException("Nie znaleziono aktywnego wyzwania");
    if (result.kind === "wrong_run") throw new ForbiddenException("Wyzwanie nie należy do wskazanego zadania");
    if (result.kind === "expired") throw new GoneException("Kod weryfikacyjny wygasł");
    if (result.kind === "conflict")
      throw new ConflictException("Wyzwanie jest już użyte, zajęte albo przekroczyło limit prób");
    if (result.kind !== "claimed") throw new ConflictException("Wyzwanie nie jest dostępne");

    try {
      await this.forwarder.deliver(challengeId, code);
      await this.markSubmitted(result.claim, actor);
      return { accepted: true, challengeId, attemptCount: result.claim.attemptCount };
    } catch {
      try {
        await this.invalidateAfterUncertainDelivery(result.claim, actor);
      } catch {
        // A persisted "claimed" status still blocks every replay if the DB is unavailable.
      }
      await this.forwarder.invalidate(challengeId);
      throw new ServiceUnavailableException(
        "Nie potwierdzono przekazania kodu. Zadanie wstrzymano; administrator może je wznowić po sprawdzeniu zgłoszenia.",
      );
    }
  }

  private async claim(challengeId: string, runId: string, actorUserId: string): Promise<ClaimResult> {
    return this.repository.transaction(async (transaction) => {
      const reference = await this.repository.findChallengeReference(challengeId, transaction);
      if (!reference) return { kind: "missing" } as const;
      if (reference.runId !== runId) return { kind: "wrong_run" } as const;
      const run = await this.repository.findRun(runId, transaction, true);
      if (!run) return { kind: "run_missing" } as const;
      if (run.startedByUserId !== actorUserId) return { kind: "wrong_run" } as const;
      const challenge = await this.repository.findChallenge(challengeId, transaction, true);
      if (!challenge) return { kind: "missing" } as const;
      if (challenge.runId !== runId || reference.runId !== challenge.runId) return { kind: "wrong_run" } as const;
      if (run.currentAuthChallengeId !== challengeId) return { kind: "conflict" } as const;
      const now = new Date();
      if (challenge.status === "expired") return { kind: "expired" } as const;
      if (challenge.status !== "active" && challenge.status !== "claimed" && challenge.status !== "submitted") {
        return { kind: "conflict" } as const;
      }
      if (challenge.expiresAt.getTime() <= now.getTime()) {
        if (challenge.status === "submitted") return { kind: "conflict" } as const;
        challenge.status = "expired";
        challenge.updatedAt = now;
        await this.repository.saveChallenge(challenge, transaction);
        if (run.status === "waiting_for_sms") {
          await this.repository.updateOpenIntervention(challengeId, "SMS_TIMEOUT", now, transaction);
          run.status = "waiting_for_manual_data";
          run.currentStep = "waiting_for_manual_data";
          run.errorCode = "SMS_RETRY_REQUIRED";
          await this.repository.saveRun(run, transaction);
          await this.repository.createRunEvent(
            {
              id: randomUUID(),
              runId,
              status: "waiting_for_manual_data",
              step: "sms_timeout",
              errorCode: "SMS_RETRY_REQUIRED",
              actorId: null,
              metadata: { challengeId, portal: challenge.portal },
              createdAt: now,
            },
            { transaction },
          );
        }
        return { kind: "expired" } as const;
      }
      if (run.status !== "waiting_for_sms") return { kind: "conflict" } as const;
      if (challenge.status !== "active" || challenge.attemptCount >= challenge.attemptLimit)
        return { kind: "conflict" } as const;

      challenge.status = "claimed";
      challenge.attemptCount += 1;
      challenge.claimedAt = now;
      challenge.updatedAt = now;
      await this.repository.saveChallenge(challenge, transaction);
      await this.repository.createRunEvent(
        {
          id: randomUUID(),
          runId,
          status: "waiting_for_sms",
          step: "sms_code_claimed",
          errorCode: null,
          actorId: actorUserId,
          metadata: { challengeId, portal: challenge.portal, attemptCount: challenge.attemptCount },
          createdAt: now,
        },
        { transaction },
      );
      return {
        kind: "claimed",
        claim: { challengeId, runId, portal: challenge.portal, attemptCount: challenge.attemptCount },
      } as const;
    });
  }

  private async markSubmitted(claim: ClaimedAuthCode, actor?: AuditActorContext): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      const run = await this.repository.findRun(claim.runId, transaction, true);
      const challenge = await this.repository.findChallenge(claim.challengeId, transaction, true);
      if (
        run?.status !== "waiting_for_sms" ||
        run.currentAuthChallengeId !== claim.challengeId ||
        !challenge ||
        challenge.runId !== claim.runId ||
        challenge.status !== "claimed"
      ) {
        throw new Error("AUTH_CHALLENGE_CLAIM_LOST");
      }
      const now = new Date();
      challenge.status = "submitted";
      challenge.updatedAt = now;
      await this.repository.saveChallenge(challenge, transaction);
      await this.repository.createRunEvent(
        {
          id: randomUUID(),
          runId: claim.runId,
          status: "waiting_for_sms",
          step: "sms_code_submitted",
          errorCode: null,
          actorId: actor?.actorUserId ?? null,
          metadata: { challengeId: claim.challengeId, portal: claim.portal, attemptCount: claim.attemptCount },
          createdAt: now,
        },
        { transaction },
      );
      if (actor) {
        await this.repository.recordSmsSubmission(actor, claim.runId, "succeeded", transaction);
      }
    });
  }

  private async invalidateAfterUncertainDelivery(claim: ClaimedAuthCode, actor?: AuditActorContext): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      const run = await this.repository.findRun(claim.runId, transaction, true);
      const challenge = await this.repository.findChallenge(claim.challengeId, transaction, true);
      if (
        run?.currentAuthChallengeId === claim.challengeId &&
        challenge?.runId === claim.runId &&
        challenge.status === "claimed"
      ) {
        const now = new Date();
        challenge.status = "invalidated";
        challenge.updatedAt = now;
        await this.repository.saveChallenge(challenge, transaction);
        await this.repository.updateOpenIntervention(claim.challengeId, "SMS_DELIVERY_UNCERTAIN", now, transaction);
        if (run?.status === "waiting_for_sms") {
          run.status = "waiting_for_manual_data";
          run.currentStep = "waiting_for_manual_data";
          run.errorCode = "SMS_DELIVERY_UNCERTAIN";
          await this.repository.saveRun(run, transaction);
          await this.repository.createRunEvent(
            {
              id: randomUUID(),
              runId: claim.runId,
              status: "waiting_for_manual_data",
              step: "sms_delivery_uncertain",
              errorCode: "SMS_DELIVERY_UNCERTAIN",
              actorId: null,
              metadata: { challengeId: claim.challengeId, portal: claim.portal },
              createdAt: now,
            },
            { transaction },
          );
        }
        if (actor) {
          await this.repository.recordSmsSubmission(actor, claim.runId, "failed", transaction);
        }
      }
    });
  }
}
