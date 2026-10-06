import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  GoneException,
  Header,
  HttpCode,
  Injectable,
  NotFoundException,
  Get,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { AuthChallenge, AutomationRun, ManualIntervention, RunEvent, sequelize } from "./db";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "./session";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { recordAuditEvent, type AuditActorContext } from "./audit";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^\d{4,10}$/;
const forwardTimeoutMs = 5_000;

export type ClaimedAuthCode = Readonly<{
  challengeId: string;
  runId: string;
  portal: "pzu" | "compensa";
  attemptCount: number;
}>;

export class WorkerCodeForwarder {
  private endpoint(): { url: URL; secret: string } {
    const configuredUrl = process.env.WORKER_INTERNAL_URL;
    const serviceSecret = process.env.WORKER_AUTH_SECRET;
    if (!configuredUrl || !serviceSecret || serviceSecret.length < 32) throw new Error("WORKER_CODE_FORWARDER_CONFIG_INVALID");
    const url = new URL(configuredUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("WORKER_CODE_FORWARDER_CONFIG_INVALID");
    }
    url.pathname = "/internal/auth-challenges";
    return { url, secret: serviceSecret };
  }

  async deliver(challengeId: string, code: string): Promise<void> {
    const { url, secret } = this.endpoint();
    url.pathname += `/${challengeId}/code`;
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ code }),
      redirect: "error",
      signal: AbortSignal.timeout(forwardTimeoutMs),
    });
    if (response.status !== 202) throw new Error("WORKER_CODE_NOT_ACCEPTED");
  }

  async invalidate(challengeId: string): Promise<void> {
    try {
      const { url, secret } = this.endpoint();
      url.pathname += `/${challengeId}`;
      await fetch(url, {
        method: "DELETE",
        headers: { authorization: `Bearer ${secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Delivery already has an uncertain outcome. Never retry the code or expose transport details.
    }
  }
}

type ClaimResult =
  | Readonly<{ kind: "claimed"; claim: ClaimedAuthCode }>
  | Readonly<{ kind: "missing" | "run_missing" | "wrong_run" | "expired" | "conflict" }>;

@Injectable()
export class AuthChallengeService {
  constructor(private readonly forwarder: WorkerCodeForwarder) {}

  async getForRun(runId: string) {
    if (!uuidPattern.test(runId)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    return sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new NotFoundException("Nie znaleziono zadania");
      if (run.status !== "waiting_for_sms") return null;
      if (!run.currentAuthChallengeId) return null;
      const challenge = await AuthChallenge.findByPk(run.currentAuthChallengeId, {
        transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!challenge || challenge.runId !== run.id || challenge.challengeId !== run.currentAuthChallengeId) return null;
      const now = new Date();
      if (["active", "claimed"].includes(challenge.status) && challenge.expiresAt.getTime() <= now.getTime()) {
        challenge.status = "expired";
        challenge.updatedAt = now;
        await challenge.save({ transaction });
        await ManualIntervention.update({ reasonCode: "SMS_TIMEOUT", revision: sequelize.literal("revision + 1"), updatedAt: now }, {
          where: { challengeId: challenge.challengeId, status: "open" }, transaction,
        });
        run.status = "waiting_for_manual_data";
        run.currentStep = "waiting_for_manual_data";
        run.errorCode = "SMS_RETRY_REQUIRED";
        await run.save({ transaction });
        await RunEvent.create({
          id: randomUUID(), runId, status: "waiting_for_manual_data", step: "sms_timeout", errorCode: "SMS_RETRY_REQUIRED",
          actorId: null, metadata: { challengeId: challenge.challengeId, portal: challenge.portal }, createdAt: now,
        }, { transaction });
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

  async submitCode(challengeId: string, runId: string, code: string, actor?: AuditActorContext) {
    if (!uuidPattern.test(challengeId) || !uuidPattern.test(runId) || !codePattern.test(code)) {
      throw new BadRequestException("Nieprawidłowe dane kodu weryfikacyjnego");
    }

    const result = await this.claim(challengeId, runId);
    if (result.kind === "missing" || result.kind === "run_missing") throw new NotFoundException("Nie znaleziono aktywnego wyzwania");
    if (result.kind === "wrong_run") throw new ForbiddenException("Wyzwanie nie należy do wskazanego zadania");
    if (result.kind === "expired") throw new GoneException("Kod weryfikacyjny wygasł");
    if (result.kind === "conflict") throw new ConflictException("Wyzwanie jest już użyte, zajęte albo przekroczyło limit prób");
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
      throw new ServiceUnavailableException("Nie potwierdzono przekazania kodu. Zadanie wstrzymano; administrator może je wznowić po sprawdzeniu zgłoszenia.");
    }
  }

  private async claim(challengeId: string, runId: string): Promise<ClaimResult> {
    return sequelize.transaction(async (transaction) => {
      const reference = await AuthChallenge.findByPk(challengeId, { attributes: ["runId"], transaction });
      if (!reference) return { kind: "missing" } as const;
      if (reference.runId !== runId) return { kind: "wrong_run" } as const;
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) return { kind: "run_missing" } as const;
      const challenge = await AuthChallenge.findByPk(challengeId, { transaction, lock: transaction.LOCK.UPDATE });
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
        await challenge.save({ transaction });
        if (run.status === "waiting_for_sms") {
          await ManualIntervention.update({ reasonCode: "SMS_TIMEOUT", revision: sequelize.literal("revision + 1"), updatedAt: now }, {
            where: { challengeId, status: "open" }, transaction,
          });
          run.status = "waiting_for_manual_data";
          run.currentStep = "waiting_for_manual_data";
          run.errorCode = "SMS_RETRY_REQUIRED";
          await run.save({ transaction });
          await RunEvent.create({
            id: randomUUID(), runId, status: "waiting_for_manual_data", step: "sms_timeout", errorCode: "SMS_RETRY_REQUIRED",
            actorId: null, metadata: { challengeId, portal: challenge.portal }, createdAt: now,
          }, { transaction });
        }
        return { kind: "expired" } as const;
      }
      if (run.status !== "waiting_for_sms") return { kind: "conflict" } as const;
      if (challenge.status !== "active" || challenge.attemptCount >= challenge.attemptLimit) return { kind: "conflict" } as const;

      challenge.status = "claimed";
      challenge.attemptCount += 1;
      challenge.claimedAt = now;
      challenge.updatedAt = now;
      await challenge.save({ transaction });
      await RunEvent.create({
        id: randomUUID(), runId, status: "waiting_for_sms", step: "sms_code_claimed", errorCode: null,
        actorId: null, metadata: { challengeId, portal: challenge.portal, attemptCount: challenge.attemptCount }, createdAt: now,
      }, { transaction });
      return {
        kind: "claimed",
        claim: { challengeId, runId, portal: challenge.portal, attemptCount: challenge.attemptCount },
      } as const;
    });
  }

  private async markSubmitted(claim: ClaimedAuthCode, actor?: AuditActorContext): Promise<void> {
    await sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(claim.runId, { transaction, lock: transaction.LOCK.UPDATE });
      const challenge = await AuthChallenge.findByPk(claim.challengeId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run || run.status !== "waiting_for_sms" || run.currentAuthChallengeId !== claim.challengeId
        || !challenge || challenge.runId !== claim.runId || challenge.status !== "claimed") {
        throw new Error("AUTH_CHALLENGE_CLAIM_LOST");
      }
      const now = new Date();
      challenge.status = "submitted";
      challenge.updatedAt = now;
      await challenge.save({ transaction });
      await RunEvent.create({
        id: randomUUID(), runId: claim.runId, status: "waiting_for_sms", step: "sms_code_submitted", errorCode: null,
        actorId: null, metadata: { challengeId: claim.challengeId, portal: claim.portal, attemptCount: claim.attemptCount }, createdAt: now,
      }, { transaction });
      if (actor) {
        await recordAuditEvent({
          tenantId: actor.tenantId, actorUserId: actor.actorUserId,
          action: "sms.submitted", resourceType: "run", resourceId: claim.runId, outcome: "succeeded",
        }, transaction);
      }
    });
  }

  private async invalidateAfterUncertainDelivery(claim: ClaimedAuthCode, actor?: AuditActorContext): Promise<void> {
    await sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(claim.runId, { transaction, lock: transaction.LOCK.UPDATE });
      const challenge = await AuthChallenge.findByPk(claim.challengeId, { transaction, lock: transaction.LOCK.UPDATE });
      if (run?.currentAuthChallengeId === claim.challengeId && challenge?.runId === claim.runId && challenge.status === "claimed") {
        const now = new Date();
        challenge.status = "invalidated";
        challenge.updatedAt = now;
        await challenge.save({ transaction });
        await ManualIntervention.update({ reasonCode: "SMS_DELIVERY_UNCERTAIN", revision: sequelize.literal("revision + 1"), updatedAt: now }, {
          where: { challengeId: claim.challengeId, status: "open" }, transaction,
        });
        if (run?.status === "waiting_for_sms") {
          run.status = "waiting_for_manual_data";
          run.currentStep = "waiting_for_manual_data";
          run.errorCode = "SMS_DELIVERY_UNCERTAIN";
          await run.save({ transaction });
          await RunEvent.create({
            id: randomUUID(), runId: claim.runId, status: "waiting_for_manual_data", step: "sms_delivery_uncertain", errorCode: "SMS_DELIVERY_UNCERTAIN",
            actorId: null, metadata: { challengeId: claim.challengeId, portal: claim.portal }, createdAt: now,
          }, { transaction });
        }
        if (actor) {
          await recordAuditEvent({
            tenantId: actor.tenantId, actorUserId: actor.actorUserId,
            action: "sms.submitted", resourceType: "run", resourceId: claim.runId, outcome: "failed",
          }, transaction);
        }
      }
    });
  }
}

@Controller("auth-challenges")
@UseGuards(SessionGuard, PermissionGuard)
export class AuthChallengeController {
  constructor(private readonly challenges: AuthChallengeService) {}

  @Get()
  @RequirePermission("sms:submit", "query-run")
  @Header("Cache-Control", "private, no-store")
  getForRun(@Query("runId") runId: string) {
    return this.challenges.getForRun(runId ?? "");
  }

  @Post(":id/code")
  @RequirePermission("sms:submit", "body-run")
  @HttpCode(202)
  @Header("Cache-Control", "private, no-store")
  @Header("Pragma", "no-cache")
  submitCode(
    @Param("id") challengeId: string,
    @Body() body: { runId?: unknown; code?: unknown },
    @Req() req: Request,
  ) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    if (!body || Object.keys(body).some((key) => key !== "runId" && key !== "code")
      || typeof body.runId !== "string" || typeof body.code !== "string") {
      throw new BadRequestException("Nieprawidłowe dane kodu weryfikacyjnego");
    }
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.challenges.submitCode(challengeId, body.runId, body.code, {
      tenantId: principal.tenantId, actorUserId: principal.userId,
    });
  }
}
