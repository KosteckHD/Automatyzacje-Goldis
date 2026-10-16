import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuditActorContext } from "../audit/public";
import type { RunControlRequest } from "./run-control.dto";
import { RunControlRepository } from "./run-control.repository";
import { RunDispatchService } from "./run-dispatch.service";
import { summarizeRun } from "./run-summary";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const individuallyPausableStatuses = [
  "queued",
  "validating",
  "awaiting_portal_adapter",
  "pzu_login",
  "everest_search",
  "compensa_login",
  "compensa_form",
  "ufg_verification",
] as const;

@Injectable()
export class RunControlService {
  constructor(
    @Inject(RunControlRepository) private readonly repository: RunControlRepository,
    @Inject(RunDispatchService) private readonly dispatch: RunDispatchService,
  ) {}

  async pause(runId: string, actor: AuditActorContext, request: RunControlRequest) {
    this.validateRunId(runId);
    return this.repository.transaction(async (transaction) => {
      const current = await this.repository.lockRun(runId, transaction);
      if (!current) throw new NotFoundException("Nie znaleziono zadania");
      const tenantId = await this.repository.findTenantId(current.batchId, transaction);
      if (tenantId !== actor.tenantId) throw new NotFoundException("Nie znaleziono zadania");
      const replay = await this.replayControlRequest(runId, actor, "pause", request, transaction);
      if (replay) return replay;
      this.assertExpectedRevision(current.controlRevision ?? "0", request.expectedRevision);
      this.assertPausableStatus(current.status);

      const now = new Date();
      if (current.controlState === "paused") {
        return this.storeResponse(
          current,
          runId,
          actor,
          "pause",
          request,
          String(current.controlRevision),
          now,
          transaction,
        );
      }
      if (current.controlState === "pause_requested") {
        if (this.hasLiveLease(current, now)) {
          return this.storeResponse(
            current,
            runId,
            actor,
            "pause",
            request,
            String(current.controlRevision),
            now,
            transaction,
          );
        }
        current.controlState = "paused";
        current.controlAckRevision = String(current.controlRevision);
        current.controlAcknowledgedAt = now;
        current.controlCheckpointStatus = current.status;
        current.updatedAt = now;
        await this.repository.saveRun(current, transaction);
        await this.repository.cancelPendingDispatches(runId, now, transaction);
        await this.repository.createEvent(
          {
            runId,
            status: current.status,
            step: "pause_acknowledged_without_active_lease",
            errorCode: null,
            actorId: actor.actorUserId,
            metadata: { controlRevision: Number(current.controlRevision) },
            createdAt: now,
          },
          transaction,
        );
        return this.storeResponse(
          current,
          runId,
          actor,
          "pause",
          request,
          String(current.controlRevision),
          now,
          transaction,
        );
      }

      const revision = BigInt(current.controlRevision ?? 0) + 1n;
      const liveLease = this.hasLiveLease(current, now);
      current.controlRevision = revision.toString();
      current.controlRequestedBy = actor.actorUserId;
      current.controlRequestedAt = now;
      current.controlAcknowledgedAt = liveLease ? current.controlAcknowledgedAt : now;
      current.controlCheckpointStatus = liveLease ? current.controlCheckpointStatus : current.status;
      current.controlState = liveLease ? "pause_requested" : "paused";
      if (!liveLease) current.controlAckRevision = revision.toString();
      current.updatedAt = now;
      await this.repository.saveRun(current, transaction);
      if (!liveLease) await this.repository.cancelPendingDispatches(runId, now, transaction);
      await this.repository.createEvent(
        {
          runId,
          status: current.status,
          step: liveLease ? "pause_requested" : "paused_without_active_lease",
          errorCode: null,
          actorId: actor.actorUserId,
          metadata: { controlRevision: Number(revision) },
          createdAt: now,
        },
        transaction,
      );
      await this.repository.recordAudit(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          action: "run.pause_requested",
          resourceType: "run",
          resourceId: runId,
          outcome: "succeeded",
          metadata: { controlRevision: Number(revision), acknowledgedImmediately: !liveLease },
        },
        transaction,
      );
      return this.storeResponse(current, runId, actor, "pause", request, revision.toString(), now, transaction);
    });
  }

  async resumePaused(runId: string, actor: AuditActorContext, request: RunControlRequest) {
    this.validateRunId(runId);
    const response = await this.repository.transaction(async (transaction) => {
      const current = await this.repository.lockRun(runId, transaction);
      if (!current) throw new NotFoundException("Nie znaleziono zadania");
      const tenantId = await this.repository.findTenantId(current.batchId, transaction);
      if (tenantId !== actor.tenantId) throw new NotFoundException("Nie znaleziono zadania");
      const replay = await this.replayControlRequest(runId, actor, "resume", request, transaction);
      if (replay) return replay;
      this.assertExpectedRevision(current.controlRevision ?? "0", request.expectedRevision);
      if (
        current.controlState !== "paused" ||
        BigInt(current.controlAckRevision ?? 0) !== BigInt(current.controlRevision ?? 0)
      ) {
        throw new ConflictException("Zadanie nie potwierdziło jeszcze pauzy w bezpiecznym punkcie");
      }
      this.assertPausableStatus(current.status, true);
      const now = new Date();
      if (current.executionId && current.leaseExpiresAt && current.leaseExpiresAt.getTime() > now.getTime()) {
        throw new ConflictException("Worker kończy zwalnianie zadania; odśwież stan i spróbuj ponownie");
      }
      current.controlState = "running";
      current.controlRevision = (BigInt(current.controlRevision) + 1n).toString();
      current.controlRequestedBy = actor.actorUserId;
      current.controlRequestedAt = now;
      current.updatedAt = now;
      await this.repository.saveRun(current, transaction);
      await this.dispatch.ensureDispatch(runId, "recovery", transaction);
      await this.repository.createEvent(
        {
          runId,
          status: current.status,
          step: "resumed_from_pause",
          errorCode: null,
          actorId: actor.actorUserId,
          metadata: { controlRevision: Number(current.controlRevision) },
          createdAt: now,
        },
        transaction,
      );
      await this.repository.recordAudit(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          action: "run.resumed_from_pause",
          resourceType: "run",
          resourceId: runId,
          outcome: "succeeded",
          metadata: { controlRevision: Number(current.controlRevision) },
        },
        transaction,
      );
      const response = summarizeRun(current);
      await this.repository.storeControlRequest(
        runId,
        actor,
        "resume",
        request,
        String(current.controlRevision),
        response,
        now,
        transaction,
      );
      return response;
    });
    void this.dispatch.publishOutbox();
    return response;
  }

  private validateRunId(runId: string) {
    if (!uuidPattern.test(runId)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
  }

  private assertExpectedRevision(currentRevision: string, expectedRevision: string) {
    if (BigInt(currentRevision) !== BigInt(expectedRevision)) {
      throw new ConflictException("Stan zadania zmienił się; odśwież widok przed ponowieniem polecenia");
    }
  }

  private assertPausableStatus(status: string, resuming = false) {
    if (!individuallyPausableStatuses.includes(status as (typeof individuallyPausableStatuses)[number])) {
      throw new ConflictException(
        resuming
          ? "Nie można wznowić zadania w jego bieżącym stanie"
          : "To zadanie nie jest teraz wstrzymywalne; oczekujące na SMS lub interwencję jest już zatrzymane",
      );
    }
  }

  private hasLiveLease(
    run: {
      executionId: string | null;
      workerSessionId: string | null;
      leaseExpiresAt: Date | null;
    },
    now: Date,
  ) {
    return Boolean(
      run.executionId && run.workerSessionId && run.leaseExpiresAt && run.leaseExpiresAt.getTime() > now.getTime(),
    );
  }

  private async replayControlRequest(
    runId: string,
    actor: AuditActorContext,
    action: "pause" | "resume",
    request: RunControlRequest,
    transaction: import("sequelize").Transaction,
  ) {
    const previous = await this.repository.findControlRequest(runId, actor, request, transaction);
    if (!previous) return null;
    if (previous.action !== action || String(previous.expectedRevision) !== request.expectedRevision) {
      throw new ConflictException("Klucz idempotencji został już użyty do innego polecenia");
    }
    return previous.response;
  }

  private async storeResponse(
    run: Parameters<typeof summarizeRun>[0],
    runId: string,
    actor: AuditActorContext,
    action: "pause" | "resume",
    request: RunControlRequest,
    resultingRevision: string,
    now: Date,
    transaction: import("sequelize").Transaction,
  ) {
    const response = summarizeRun(run);
    await this.repository.storeControlRequest(
      runId,
      actor,
      action,
      request,
      resultingRevision,
      response,
      now,
      transaction,
    );
    return response;
  }
}
