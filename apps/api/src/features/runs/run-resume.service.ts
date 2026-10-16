import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AuditActorContext } from "../audit";
import { canResumeManualIntervention, canRetrySms, WorkerCodeForwarder } from "../interventions/public";
import { canRecheckPortalIntervention } from "../review/public";
import { RunDispatchService } from "./run-dispatch.service";
import { RunResumeRepository } from "./run-resume.repository";
import { summarizeRun } from "./run-summary";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RunResumeService {
  constructor(
    @Inject(RunResumeRepository) private readonly repository: RunResumeRepository,
    @Inject(RunDispatchService) private readonly dispatch: RunDispatchService,
    @Inject(WorkerCodeForwarder) private readonly codeForwarder: WorkerCodeForwarder,
  ) {}

  async resumeAuth(runId: string, actor: AuditActorContext) {
    this.validateRunId(runId);
    let invalidatedChallengeId: string | null = null;
    const run = await this.repository.transaction(async (transaction) => {
      const current = await this.repository.lockRun(runId, transaction);
      if (!current) throw new NotFoundException("Nie znaleziono zadania");
      if (current.startedByUserId !== actor.actorUserId) {
        throw new ForbiddenException("Tylko osoba uruchamiająca może obsłużyć kod SMS");
      }
      const incident = await this.repository.findSmsIntervention(runId, transaction);
      const retryCount = incident?.portal === "compensa" ? current.compensaSmsRetryCount : current.pzuSmsRetryCount;
      if (
        !incident ||
        !canRetrySms({
          status: current.status,
          errorCode: current.errorCode,
          reasonCode: incident.reasonCode,
          portal: incident.portal,
          retryCount,
        })
      ) {
        throw new ConflictException("Zadanie nie pozwala na dodatkowy SMS albo limit został wykorzystany");
      }
      if (incident.portal === "pzu") current.pzuSmsRetryCount += 1;
      else current.compensaSmsRetryCount += 1;

      const active = await this.repository.findActiveAuthChallenge(runId, transaction);
      if (active) {
        if (
          current.status !== "waiting_for_sms" ||
          current.errorCode !== "SMS_CODE_REJECTED" ||
          active.status !== "active" ||
          active.challengeId !== current.currentAuthChallengeId ||
          active.challengeId !== incident.challengeId
        ) {
          throw new ConflictException("Kod SMS jest już przekazywany albo stan zgłoszenia się zmienił");
        }
        active.status = "expired";
        active.updatedAt = new Date();
        await this.repository.saveAuthChallenge(active, transaction);
        invalidatedChallengeId = active.challengeId;
      }

      const now = new Date();
      const next = incident.portal === "pzu" ? "pzu_login" : "compensa_login";
      current.status = next;
      current.currentStep = next;
      current.errorCode = "SMS_RETRY_QUEUED";
      current.currentAuthChallengeId = null;
      current.authCycleId = null;
      current.authCyclePortal = null;
      current.authCycleStartedAt = null;
      current.authCycleExpiresAt = null;
      await this.repository.saveRun(current, transaction);
      incident.status = "resolved";
      incident.resolvedAt = now;
      incident.resolvedBy = actor.actorUserId;
      incident.updatedAt = now;
      incident.revision += 1;
      await this.repository.saveIntervention(incident, transaction);
      await this.repository.createActivity(
        {
          activityId: randomUUID(),
          interventionId: incident.interventionId,
          actorUserId: actor.actorUserId,
          eventType: "resolved",
          previousAssigneeUserId: incident.assigneeUserId,
          nextAssigneeUserId: incident.assigneeUserId,
          priority: incident.priority,
          createdAt: now,
        },
        transaction,
      );
      await this.dispatch.ensureDispatch(runId, "resume_auth", transaction);
      await this.repository.createEvent(
        {
          runId,
          status: next,
          step: "auth_retry_queued",
          errorCode: null,
          actorId: actor.actorUserId,
          metadata: {
            portal: incident.portal,
            retryCount: incident.portal === "pzu" ? current.pzuSmsRetryCount : current.compensaSmsRetryCount,
          },
          createdAt: now,
        },
        transaction,
      );
      await this.repository.recordAudit(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          action: "run.auth_resumed",
          resourceType: "run",
          resourceId: runId,
          outcome: "succeeded",
        },
        transaction,
      );
      await this.repository.recordAudit(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          action: "intervention.resolved",
          resourceType: "intervention",
          resourceId: incident.interventionId,
          outcome: "succeeded",
        },
        transaction,
      );
      return current;
    });
    if (invalidatedChallengeId) await this.codeForwarder.invalidate(invalidatedChallengeId);
    void this.dispatch.publishOutbox();
    return summarizeRun(run);
  }

  async resumeReview(runId: string, actor: AuditActorContext) {
    this.validateRunId(runId);
    const run = await this.repository.transaction(async (transaction) => {
      const current = await this.repository.lockRun(runId, transaction);
      if (!current) throw new NotFoundException("Nie znaleziono zadania");
      if (current.startedByUserId !== actor.actorUserId) {
        throw new ForbiddenException("Tylko osoba uruchamiająca może obsłużyć zgłoszenie");
      }
      if (current.status !== "waiting_for_manual_data" && current.status !== "identity_review") {
        throw new ConflictException("Zadanie nie oczekuje na rozwiązanie zgłoszenia");
      }
      const incident = await this.repository.findLatestOpenIntervention(runId, transaction);
      const override =
        current.manualDataVersion > 0
          ? await this.repository.findManualDataOverride(runId, current.manualDataVersion, transaction)
          : null;
      const portalRecheck =
        incident &&
        canRecheckPortalIntervention({
          role: "admin",
          runStatus: current.status,
          portal: incident.portal,
          kind: incident.kind,
          reasonCode: incident.reasonCode,
          fieldCode: incident.fieldCode,
          lastSafeStep: current.lastSafeStep,
          externalCaseRef: current.externalCaseRef,
        });
      if (
        !incident ||
        (!portalRecheck &&
          !canResumeManualIntervention({
            role: "admin",
            isRunStarter: current.startedByUserId === actor.actorUserId,
            runStatus: current.status,
            fieldCode: incident.fieldCode,
            lastSafeStep: current.lastSafeStep,
            externalCaseRef: current.externalCaseRef,
            manualDataVersion: current.manualDataVersion,
            overrideVersion: override?.version ?? null,
            fields: override?.fields ?? null,
          }))
      ) {
        throw new ConflictException(
          "Zgłoszenie wymaga poprawki do wskazanego pola albo uzgodnienia sprawy; wznowienie bez tego kroku jest zablokowane",
        );
      }
      const now = new Date();
      const next =
        incident.fieldCode === "EXPECTED_PERSON"
          ? "everest_search"
          : incident.portal === "pzu"
            ? "pzu_login"
            : "compensa_login";
      if (incident.fieldCode === "EXPECTED_PERSON" && (current.lastSafeStep || current.externalCaseRef)) {
        throw new ConflictException("Nie można zmienić osoby po rozpoczęciu oferty");
      }
      current.status = next;
      current.currentStep = next;
      current.errorCode = "REVIEW_RETRY_QUEUED";
      await this.repository.saveRun(current, transaction);
      incident.status = "resolved";
      incident.resolvedAt = now;
      incident.resolvedBy = actor.actorUserId;
      incident.updatedAt = now;
      incident.revision += 1;
      await this.repository.saveIntervention(incident, transaction);
      await this.repository.createActivity(
        {
          activityId: randomUUID(),
          interventionId: incident.interventionId,
          actorUserId: actor.actorUserId,
          eventType: "resolved",
          previousAssigneeUserId: incident.assigneeUserId,
          nextAssigneeUserId: incident.assigneeUserId,
          priority: incident.priority,
          createdAt: now,
        },
        transaction,
      );
      await this.dispatch.ensureDispatch(runId, "resume_review", transaction);
      await this.repository.createEvent(
        {
          runId,
          status: next,
          step: "manual_review_resumed",
          errorCode: null,
          actorId: actor.actorUserId,
          metadata: {
            fieldCode: incident.fieldCode,
            manualDataVersion: current.manualDataVersion,
            portalRecheck: Boolean(portalRecheck),
          },
          createdAt: now,
        },
        transaction,
      );
      await this.repository.recordAudit(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          action: "run.review_resumed",
          resourceType: "run",
          resourceId: runId,
          outcome: "succeeded",
        },
        transaction,
      );
      await this.repository.recordAudit(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId,
          action: "intervention.resolved",
          resourceType: "intervention",
          resourceId: incident.interventionId,
          outcome: "succeeded",
        },
        transaction,
      );
      return current;
    });
    void this.dispatch.publishOutbox();
    return summarizeRun(run);
  }

  private validateRunId(runId: string) {
    if (!uuidPattern.test(runId)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
  }
}
