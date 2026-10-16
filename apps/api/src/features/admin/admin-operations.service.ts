import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import Redis from "ioredis";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { authMailOutboxSummary, readAuthMailConfig } from "../account-recovery/public";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { canAssignIntervention } from "../authorization";
import { automationReadiness } from "../health";
import { parseIso, strictObject, toolIdPattern, uuidPattern } from "./admin.support";
import { AdminMutationsService } from "./admin-mutations.service";
import { AdminOperationsRepository } from "./admin-operations.repository";
import { AdminOverviewRepository } from "./admin-overview.repository";
@Injectable()
export class AdminOperationsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdminMutationsService) private readonly mutations: AdminMutationsService,
    @Inject(AdminOperationsRepository) private readonly repository: AdminOperationsRepository,
    @Inject(AdminOverviewRepository) private readonly overview: AdminOverviewRepository,
  ) {}
  async operationsSummary(actor: SessionPrincipal) {
    const [summary, enrichment, authMail] = await Promise.all([
      this.repository.operationsSummary(actor.tenantId),
      this.overview.enrichmentOperationsSnapshot(actor.tenantId),
      authMailOutboxSummary(),
    ]);
    const pendingSubmissionStates = new Set([
      "pending",
      "leased",
      "waiting_capacity",
      "waiting_window",
      "waiting_paused",
      "blocked",
    ]);
    const submissionGroupCounts = summary.submissionGroups.map((row) => ({
      status: row.status,
      reasonCode: row.reasonCode,
      count: Number(row.count),
      oldestCreatedAt: row.oldestCreatedAt,
    }));
    const oldestPendingSubmissionAt =
      submissionGroupCounts
        .filter((row) => pendingSubmissionStates.has(row.status) && row.oldestCreatedAt)
        .map((row) => row.oldestCreatedAt as Date)
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
    const pendingSubmissionCount = submissionGroupCounts
      .filter((row) => pendingSubmissionStates.has(row.status))
      .reduce((sum, row) => sum + row.count, 0);
    let redisReady = false;
    const redisUrl = loadApiSecretConfig().redisUrl;
    if (redisUrl) {
      const redis = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 1500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      redis.on("error", () => undefined);
      try {
        await redis.connect();
        redisReady = (await redis.ping()) === "PONG";
      } catch {
        redisReady = false;
      } finally {
        await redis.quit().catch(() => redis.disconnect());
      }
    }
    const readiness = automationReadiness({ servicesReady: redisReady, worker: summary.workerRuntime });
    return {
      observedAt: new Date().toISOString(),
      api: "online",
      database: "online",
      redis: redisReady ? "online" : "offline",
      worker: readiness.worker,
      portalMode: readiness.portalMode,
      portalConfig: readiness.portalConfig,
      automationReady: readiness.automationReady,
      runCounts: Object.fromEntries(summary.runCounts.map((item) => [item.status, Number(item.count)])),
      openInterventionCount: summary.openInterventionCount,
      dispatch: {
        pendingCount: Number(summary.dispatch?.pendingCount ?? 0),
        oldestCreatedAt: summary.dispatch?.oldestCreatedAt ?? null,
      },
      submissionGroups: {
        pendingCount: pendingSubmissionCount,
        oldestPendingAt: oldestPendingSubmissionAt,
        byStateAndReason: submissionGroupCounts.map(({ status, reasonCode, count }) => ({ status, reasonCode, count })),
      },
      submissionCounts: Object.fromEntries(summary.submissionCounts.map((row) => [row.status, Number(row.count)])),
      authMail: { enabled: readAuthMailConfig().enabled, ...authMail },
      enrichment,
    };
  }

  async operationsRuns(actor: SessionPrincipal, toolId?: string, status?: string, rawPage?: string) {
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw new BadRequestException("Nieprawidłowa strona");
    if (toolId && !toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowe narzędzie");
    if (status && !/^[a-z_]{2,40}$/.test(status)) throw new BadRequestException("Nieprawidłowy status");
    const rows = await this.repository.operationsRuns({
      tenantId: actor.tenantId,
      toolId: toolId ?? null,
      status: status ?? null,
      offset: (page - 1) * 50,
    });
    return { page, hasMore: rows.length > 50, items: rows.slice(0, 50) };
  }

  async adminInterventions(
    actor: SessionPrincipal,
    status = "open",
    assigneeUserId?: string,
    toolId?: string,
    priority?: string,
    rawPage?: string,
  ) {
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (
      !new Set(["open", "resolved", "cancelled", "expired", "all"]).has(status) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      (assigneeUserId && !uuidPattern.test(assigneeUserId)) ||
      (toolId && !toolIdPattern.test(toolId)) ||
      (priority && !new Set(["normal", "high"]).has(priority))
    ) {
      throw new BadRequestException("Nieprawidłowy filtr interwencji");
    }
    const rows = await this.repository.adminInterventions({
      tenantId: actor.tenantId,
      status,
      assigneeUserId: assigneeUserId ?? null,
      toolId: toolId ?? null,
      priority: priority ?? null,
      offset: (page - 1) * 50,
    });
    return { page, hasMore: rows.length > 50, items: rows.slice(0, 50) };
  }

  async assignIntervention(interventionId: string, input: unknown, actor: SessionPrincipal) {
    const body = strictObject(input, ["assigneeUserId", "dueAt", "expectedRevision"]);
    if (
      !uuidPattern.test(interventionId) ||
      (body.assigneeUserId !== null &&
        (typeof body.assigneeUserId !== "string" || !uuidPattern.test(body.assigneeUserId))) ||
      !Number.isInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 1
    ) {
      throw new BadRequestException("Nieprawidłowe przypisanie");
    }
    let dueAt: Date | null = null;
    if (body.dueAt !== undefined && body.dueAt !== null) {
      if (typeof body.dueAt !== "string") throw new BadRequestException("Nieprawidłowy termin");
      dueAt = parseIso(body.dueAt, "dueAt");
    }
    return this.repository.transaction(async (transaction) => {
      await this.mutations.lockTenantAdminChanges(
        actor,
        transaction,
        body.assigneeUserId ? [body.assigneeUserId as string] : [],
      );
      const intervention = await this.repository.findInterventionForUpdate(interventionId, transaction);
      if (intervention?.status !== "open") throw new NotFoundException();
      if (intervention.revision !== Number(body.expectedRevision))
        throw new ConflictException("Zgłoszenie zmieniło się w innej sesji");
      const run = await this.repository.findRun(intervention.runId, transaction);
      const batch = run ? await this.repository.findBatch(run.batchId, transaction) : null;
      if (!run || !batch || batch.tenantId !== actor.tenantId || batch.toolId !== run.toolId)
        throw new NotFoundException();
      const nextAssignee = body.assigneeUserId as string | null;
      if (nextAssignee) {
        const member = await this.repository.findAssigneeMembership(actor.tenantId, nextAssignee, transaction);
        if (!member) throw new BadRequestException("Odbiorca nie jest aktywnym użytkownikiem tej organizacji");
        if (member.role !== "admin") {
          const grant = await this.repository.findToolGrant(actor.tenantId, batch.toolId, nextAssignee, transaction);
          const canAssign = canAssignIntervention({
            role: member.role,
            kind: intervention.kind as "sms" | "identity_review" | "portal_error",
            canViewResults: Boolean(grant?.canViewResults),
            canExecute: Boolean(grant?.canExecute),
          });
          if (!canAssign) throw new BadRequestException("Odbiorca nie ma roli ani dostępu do tego rodzaju zgłoszenia");
        }
      }
      const now = new Date();
      const oldAssignee = intervention.assigneeUserId;
      const changed = oldAssignee !== nextAssignee || intervention.dueAt?.getTime() !== dueAt?.getTime();
      if (!changed)
        return {
          interventionId,
          assigneeUserId: oldAssignee,
          dueAt: intervention.dueAt,
          revision: intervention.revision,
        };
      intervention.assigneeUserId = nextAssignee;
      intervention.assignedAt = nextAssignee ? now : null;
      intervention.assignedBy = nextAssignee ? actor.userId : null;
      intervention.dueAt = dueAt;
      intervention.updatedAt = now;
      intervention.revision += 1;
      await this.repository.saveIntervention(intervention, transaction);
      const eventType = nextAssignee ? "assigned" : "unassigned";
      await this.repository.createInterventionActivity(
        {
          activityId: randomUUID(),
          interventionId,
          actorUserId: actor.userId,
          eventType,
          previousAssigneeUserId: oldAssignee,
          nextAssigneeUserId: nextAssignee,
          priority: null,
          createdAt: now,
        },
        transaction,
      );
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: nextAssignee ? "intervention.assigned" : "intervention.unassigned",
          resourceType: "intervention",
          resourceId: interventionId,
          outcome: "succeeded",
          metadata: {
            previousAssigneeUserId: oldAssignee,
            assigneeUserId: nextAssignee,
            revision: intervention.revision,
          },
        },
        transaction,
      );
      return { interventionId, assigneeUserId: nextAssignee, dueAt, revision: intervention.revision };
    });
  }

  async setInterventionPriority(interventionId: string, input: unknown, actor: SessionPrincipal) {
    const body = strictObject(input, ["priority", "expectedRevision"]);
    if (
      !uuidPattern.test(interventionId) ||
      !new Set(["normal", "high"]).has(String(body.priority)) ||
      !Number.isInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 1
    ) {
      throw new BadRequestException("Nieprawidłowy priorytet");
    }
    return this.repository.transaction(async (transaction) => {
      await this.mutations.lockTenantAdminChanges(actor, transaction);
      const intervention = await this.repository.findInterventionForUpdate(interventionId, transaction);
      if (intervention?.status !== "open") throw new NotFoundException();
      if (intervention.revision !== Number(body.expectedRevision))
        throw new ConflictException("Zgłoszenie zmieniło się w innej sesji");
      const run = await this.repository.findRun(intervention.runId, transaction);
      const batch = run ? await this.repository.findBatch(run.batchId, transaction) : null;
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException();
      const priority = body.priority as "normal" | "high";
      if (intervention.priority === priority) return { interventionId, priority, revision: intervention.revision };
      const now = new Date();
      intervention.priority = priority;
      intervention.revision += 1;
      intervention.updatedAt = now;
      await this.repository.saveIntervention(intervention, transaction);
      await this.repository.createInterventionActivity(
        {
          activityId: randomUUID(),
          interventionId,
          actorUserId: actor.userId,
          eventType: "priority_changed",
          previousAssigneeUserId: null,
          nextAssigneeUserId: null,
          priority,
          createdAt: now,
        },
        transaction,
      );
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "intervention.priority_changed",
          resourceType: "intervention",
          resourceId: interventionId,
          outcome: "succeeded",
          metadata: { priority, revision: intervention.revision },
        },
        transaction,
      );
      return { interventionId, priority, revision: intervention.revision };
    });
  }

  async interventionActivity(interventionId: string, actor: SessionPrincipal) {
    if (!uuidPattern.test(interventionId)) throw new BadRequestException("Nieprawidłowe zgłoszenie");
    const rows = await this.repository.interventionActivity(actor.tenantId, interventionId);
    if (!rows) throw new NotFoundException();
    return { items: rows };
  }
}
