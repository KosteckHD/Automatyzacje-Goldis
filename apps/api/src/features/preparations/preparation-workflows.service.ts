import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { ImportPreparationWorkflow, ImportPreparationWorkflowStatus } from "../../infrastructure/database/db";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { EnrichmentJobService } from "../enrichment/public";
import { ImportPreparationWorkflowsRepository } from "./preparation-workflows.repository";
import { requireCurrentSealedPreparation } from "./preparations.repository";
import { ImportPreparationService } from "./preparations.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK_SIZE = 500;
const LEASE_MS = 2 * 60_000;
const POLL_MS = 2_000;
type Actor = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;
function parseIdempotency(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Podaj poprawny klucz idempotencji procesu automatyzacji");
  }
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== "idempotencyKey") ||
    typeof input.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{16,120}$/.test(input.idempotencyKey)
  ) {
    throw new BadRequestException("Podaj poprawny klucz idempotencji procesu automatyzacji");
  }
  return input.idempotencyKey;
}

function publicWorkflow(workflow: ImportPreparationWorkflow) {
  return {
    workflowId: workflow.workflowId,
    batchId: workflow.batchId,
    sourcePreparationId: workflow.sourcePreparationId,
    status: workflow.status,
    version: workflow.version,
    reanalysisPreparationId: workflow.reanalysisPreparationId,
    errorCode: workflow.errorCode,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    finishedAt: workflow.finishedAt,
  };
}

function isTerminalPreparation(status: string): boolean {
  return ["completed", "completed_with_attention", "cancelled", "failed"].includes(status);
}

function isActiveWorkflow(status: ImportPreparationWorkflowStatus): boolean {
  return ["queued", "starting_registry", "waiting_registry", "starting_reanalysis", "waiting_reanalysis"].includes(
    status,
  );
}

@Injectable()
export class ImportPreparationWorkflowService implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(
    @Inject(ImportPreparationService) private readonly preparations: ImportPreparationService,
    @Inject(EnrichmentJobService) private readonly enrichmentJobs: EnrichmentJobService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ImportPreparationWorkflowsRepository) private readonly repository: ImportPreparationWorkflowsRepository,
  ) {}

  onModuleInit() {
    void this.processOne().catch(() => undefined);
    this.timer = setInterval(() => void this.processOne().catch(() => undefined), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async start(batchId: string, preparationId: string, body: unknown, actor: Actor) {
    if (!UUID.test(batchId) || !UUID.test(preparationId)) throw new NotFoundException("Nie znaleziono przygotowania");
    const idempotencyKey = parseIdempotency(body);
    return this.repository.transaction(async (transaction) => {
      await this.preparations.requireExecutableBatch(batchId, actor, transaction);
      const existing = await this.repository.findByIdempotency(
        actor.tenantId,
        batchId,
        actor.userId,
        idempotencyKey,
        transaction,
      );
      if (existing) {
        if (existing.sourcePreparationId !== preparationId)
          throw new ConflictException("Klucz idempotencji wykorzystano dla innej rewizji");
        return { ...publicWorkflow(existing), replayed: true };
      }
      const preparation = await this.repository.findPreparationForStart(
        preparationId,
        actor.tenantId,
        batchId,
        transaction,
      );
      if (!preparation?.sealedAt || !["completed", "completed_with_attention"].includes(preparation.status)) {
        throw new ConflictException("Najpierw zamknij rewizję przygotowania importu");
      }
      const latest = await this.repository.findLatestPreparation(actor.tenantId, batchId, transaction);
      if (latest?.preparationId !== preparationId)
        throw new ConflictException("Wybierz najnowszą rewizję przygotowania");
      const sourceRows = await this.repository.findSourceRowVersions(batchId, transaction);
      await requireCurrentSealedPreparation(batchId, sourceRows, transaction);

      const active = await this.repository.findActiveWorkflow(actor.tenantId, batchId, transaction);
      if (active) throw new ConflictException("Automatyzacja importu już trwa; odśwież jej stan");
      const now = new Date();
      const workflow = await this.repository.createWorkflow(
        {
          workflowId: randomUUID(),
          tenantId: actor.tenantId,
          batchId,
          sourcePreparationId: preparationId,
          actorUserId: actor.userId,
          idempotencyKey,
          status: "queued",
          version: 1,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          reanalysisPreparationId: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
        },
        transaction,
      );
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "import.preparation.workflow.started",
          resourceType: "preparation_workflow",
          resourceId: workflow.workflowId,
          outcome: "succeeded",
          metadata: { batchId, sourceRevision: preparation.revision, workflowId: workflow.workflowId },
        },
        transaction,
      );
      return { ...publicWorkflow(workflow), replayed: false };
    });
  }

  async listForBatch(batchId: string, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException("Nie znaleziono importu");
    await this.preparations.requireReadableBatch(batchId, actor);
    const workflows = await this.repository.listWorkflows(batchId, actor.tenantId);
    return { workflows: await Promise.all(workflows.map((workflow) => this.details(workflow))) };
  }

  async get(batchId: string, workflowId: string, actor: Actor) {
    if (!UUID.test(batchId) || !UUID.test(workflowId)) throw new NotFoundException("Nie znaleziono automatyzacji");
    const workflow = await this.repository.findWorkflow(workflowId, batchId, actor.tenantId);
    if (!workflow) throw new NotFoundException("Nie znaleziono automatyzacji");
    await this.preparations.get(batchId, workflow.sourcePreparationId, actor);
    return this.details(workflow);
  }

  private async details(workflow: ImportPreparationWorkflow) {
    const links = await this.repository.findWorkflowJobs(workflow.workflowId);
    const jobs = links.length
      ? await this.repository.findEnrichmentJobs(
          links.map((link) => link.jobId),
          workflow.batchId,
          ["jobId", "status", "selectedCount", "completedCount", "excludedCount", "failedCount", "cancelledCount"],
        )
      : [];
    const reanalysis = workflow.reanalysisPreparationId
      ? await this.repository.findPreparationById(workflow.reanalysisPreparationId, [
          "preparationId",
          "revision",
          "status",
          "readyCount",
          "reviewCount",
          "duplicateCount",
          "skippedCount",
          "waitingRegistryCount",
        ])
      : null;
    return {
      ...publicWorkflow(workflow),
      registryJobs: jobs.map((job) => ({
        jobId: job.jobId,
        status: job.status,
        selectedCount: job.selectedCount,
        completedCount: job.completedCount,
        excludedCount: job.excludedCount,
        failedCount: job.failedCount,
        cancelledCount: job.cancelledCount,
      })),
      reanalysis: reanalysis
        ? {
            preparationId: reanalysis.preparationId,
            revision: reanalysis.revision,
            status: reanalysis.status,
            counts: {
              ready: reanalysis.readyCount,
              review: reanalysis.reviewCount,
              duplicates: reanalysis.duplicateCount,
              skippedNoIdentifiers: reanalysis.skippedCount,
              waitingRegistry: reanalysis.waitingRegistryCount,
            },
          }
        : null,
    };
  }

  async cancel(batchId: string, workflowId: string, body: unknown, actor: Actor) {
    if (!UUID.test(batchId) || !UUID.test(workflowId)) throw new NotFoundException("Nie znaleziono automatyzacji");
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "expectedVersion") ||
      !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion) ||
      Number((body as { expectedVersion: number }).expectedVersion) < 1
    ) {
      throw new BadRequestException("Podaj poprawną wersję automatyzacji");
    }
    await this.preparations.requireExecutableBatch(batchId, actor);
    const cancelled = await this.repository.transaction(async (transaction) => {
      const workflow = await this.repository.findWorkflowForUpdate(workflowId, batchId, actor.tenantId, transaction);
      if (!workflow) throw new NotFoundException("Nie znaleziono automatyzacji");
      if (workflow.version !== (body as { expectedVersion: number }).expectedVersion) {
        throw new ConflictException("Automatyzacja zmieniła się; odśwież jej stan");
      }
      if (!isActiveWorkflow(workflow.status)) return workflow;
      const now = new Date();
      workflow.status = "cancelled";
      workflow.version += 1;
      workflow.updatedAt = now;
      workflow.finishedAt = now;
      workflow.leaseOwner = null;
      workflow.leaseExpiresAt = null;
      workflow.nextAttemptAt = null;
      await this.repository.saveWorkflow(workflow, transaction);
      await this.audit.record(
        {
          tenantId: workflow.tenantId,
          actorUserId: actor.userId,
          action: "import.preparation.workflow.cancelled",
          resourceType: "preparation_workflow",
          resourceId: workflow.workflowId,
          outcome: "succeeded",
          metadata: { batchId, workflowId },
        },
        transaction,
      );
      const links = await this.repository.findWorkflowJobs(workflowId, transaction);
      const jobs = links.length
        ? await this.repository.findEnrichmentJobsByIds(
            links.map((link) => link.jobId),
            batchId,
            transaction,
          )
        : [];
      const preparation = workflow.reanalysisPreparationId
        ? await this.repository.findPreparationById(workflow.reanalysisPreparationId, undefined, transaction)
        : null;
      return { workflow, jobs, preparation };
    });
    if ("workflow" in cancelled) {
      for (const job of cancelled.jobs) {
        if (["queued", "processing"].includes(job.status)) {
          await this.enrichmentJobs.cancel(job.jobId, { expectedVersion: job.version }, actor).catch(() => undefined);
        }
      }
      const preparation = cancelled.preparation;
      if (preparation && ["queued", "processing", "waiting_registry"].includes(preparation.status)) {
        await this.preparations
          .cancel(batchId, preparation.preparationId, { expectedVersion: preparation.version }, actor)
          .catch(() => undefined);
      }
      return publicWorkflow(cancelled.workflow);
    }
    return publicWorkflow(cancelled);
  }

  private async claim(): Promise<string | null> {
    return this.repository.transaction(async (transaction) => {
      const now = new Date();
      const workflow = await this.repository.findActiveForClaim(now, transaction);
      if (!workflow) return null;
      workflow.leaseOwner = this.workerId;
      workflow.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      workflow.version += 1;
      workflow.updatedAt = now;
      await this.repository.saveWorkflow(workflow, transaction);
      return workflow.workflowId;
    });
  }

  private async currentActor(workflow: ImportPreparationWorkflow): Promise<Actor> {
    const [user, membership] = await this.repository.findActorStatus(workflow.actorUserId, workflow.tenantId);
    if (user?.status !== "active" || !membership || !["admin", "manager", "operator"].includes(membership.role)) {
      throw new ForbiddenException("EXECUTION_PERMISSION_REVOKED");
    }
    const actor: Actor = {
      tenantId: workflow.tenantId,
      userId: workflow.actorUserId,
      role: membership.role as Actor["role"],
    };
    await this.preparations.requireExecutableBatch(workflow.batchId, actor);
    return actor;
  }

  private async saveProgress(workflowId: string, patch: Partial<ImportPreparationWorkflow>): Promise<boolean> {
    return this.repository.transaction(async (transaction) => {
      const current = await this.repository.findWorkflowById(workflowId, transaction, true);
      if (!current || current.leaseOwner !== this.workerId || current.status === "cancelled") return false;
      Object.assign(current, patch, { version: current.version + 1, updatedAt: new Date() });
      await this.repository.saveWorkflow(current, transaction);
      return true;
    });
  }

  private async scheduleRetry(workflowId: string) {
    await this.saveProgress(workflowId, {
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(Date.now() + POLL_MS),
    });
  }

  private async finishFailure(workflowId: string, errorCode: string) {
    await this.repository.transaction(async (transaction) => {
      const workflow = await this.repository.findWorkflowById(workflowId, transaction, true);
      if (!workflow || workflow.leaseOwner !== this.workerId || workflow.status === "cancelled") return;
      const now = new Date();
      workflow.status = "failed";
      workflow.errorCode = errorCode;
      workflow.leaseOwner = null;
      workflow.leaseExpiresAt = null;
      workflow.nextAttemptAt = null;
      workflow.finishedAt = now;
      workflow.version += 1;
      workflow.updatedAt = now;
      await this.repository.saveWorkflow(workflow, transaction);
      await this.audit.record(
        {
          tenantId: workflow.tenantId,
          actorUserId: workflow.actorUserId,
          action: "import.preparation.workflow.failed",
          resourceType: "preparation_workflow",
          resourceId: workflow.workflowId,
          outcome: "failed",
          metadata: { batchId: workflow.batchId, workflowId, errorCode },
        },
        transaction,
      );
    });
  }

  private async startRegistryJobs(workflow: ImportPreparationWorkflow, actor: Actor): Promise<boolean> {
    const preparation = await this.repository.findSealedPreparation(workflow.sourcePreparationId, workflow.batchId);
    if (!preparation?.sealedAt || !["completed", "completed_with_attention"].includes(preparation.status)) {
      throw new ConflictException("SOURCE_PREPARATION_NOT_SEALED");
    }
    const rows = await this.repository.findWaitingRegistryRows(preparation.preparationId);
    if (rows.length === 0) return false;
    const sourceRows = await this.repository.findSourceRowVersions(workflow.batchId);
    await requireCurrentSealedPreparation(workflow.batchId, sourceRows);
    for (let offset = 0, chunkNumber = 1; offset < rows.length; offset += CHUNK_SIZE, chunkNumber += 1) {
      const currentWorkflow = await this.repository.findWorkflowById(workflow.workflowId);
      if (!currentWorkflow || currentWorkflow.status === "cancelled") return true;
      const rowNumbers = rows.slice(offset, offset + CHUNK_SIZE).map((row) => row.rowNumber);
      const job = await this.enrichmentJobs.start(
        workflow.batchId,
        {
          idempotencyKey: `preparation-workflow:${workflow.workflowId}:${chunkNumber}`,
          rowNumbers,
        },
        actor,
      );
      await this.repository.createWorkflowJobIfMissing(
        workflow.workflowId,
        chunkNumber,
        job.id,
        workflow.batchId,
        new Date(),
      );
      const saved = await this.repository.findWorkflowJob(workflow.workflowId, chunkNumber);
      if (!saved || saved.jobId !== job.id) throw new ConflictException("WORKFLOW_JOB_LINK_MISMATCH");
      const afterCreate = await this.repository.findWorkflowById(workflow.workflowId);
      if (!afterCreate || afterCreate.status === "cancelled") {
        await this.enrichmentJobs.cancel(job.id, { expectedVersion: job.version }, actor).catch(() => undefined);
        return true;
      }
    }
    return true;
  }

  private async processClaim(workflowId: string) {
    let workflow = await this.repository.findWorkflowById(workflowId);
    if (!workflow || workflow.leaseOwner !== this.workerId || workflow.status === "cancelled") return;
    const actor = await this.currentActor(workflow);

    if (["queued", "starting_registry"].includes(workflow.status)) {
      await this.saveProgress(workflowId, { status: "starting_registry" });
      workflow = await this.repository.findWorkflowById(workflowId);
      if (!workflow || workflow.status === "cancelled") return;
      const started = await this.startRegistryJobs(workflow, actor);
      if (!started) {
        const source = await this.repository.findPreparationById(workflow.sourcePreparationId);
        const status = source?.status === "completed" ? "completed" : "completed_with_attention";
        await this.finish(workflowId, status);
        return;
      }
      await this.saveProgress(workflowId, {
        status: "waiting_registry",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + POLL_MS),
      });
      return;
    }

    if (workflow.status === "waiting_registry") {
      const links = await this.repository.findWorkflowJobs(workflowId);
      const jobs = links.length
        ? await this.repository.findEnrichmentJobsByIds(
            links.map((link) => link.jobId),
            workflow.batchId,
          )
        : [];
      if (jobs.length !== links.length) throw new ConflictException("WORKFLOW_REGISTRY_JOB_MISSING");
      if (jobs.some((job) => ["queued", "processing"].includes(job.status))) {
        await this.scheduleRetry(workflowId);
        return;
      }
      await this.saveProgress(workflowId, { status: "starting_reanalysis" });
      workflow = await this.repository.findWorkflowById(workflowId);
      if (!workflow || workflow.status === "cancelled") return;
    }

    if (["starting_reanalysis", "waiting_reanalysis"].includes(workflow.status)) {
      if (!workflow.reanalysisPreparationId) {
        if (!(await this.saveProgress(workflowId, { status: "starting_reanalysis" }))) return;
        const started = await this.preparations.start(
          workflow.batchId,
          {
            idempotencyKey: `preparation-workflow:${workflow.workflowId}:revision`,
          },
          actor,
        );
        const saved = await this.saveProgress(workflowId, {
          status: "waiting_reanalysis",
          reanalysisPreparationId: started.preparationId,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + POLL_MS),
        });
        if (!saved) {
          const followUp = await this.repository.findPreparationById(started.preparationId);
          if (followUp && ["queued", "processing", "waiting_registry"].includes(followUp.status)) {
            await this.preparations
              .cancel(workflow.batchId, followUp.preparationId, { expectedVersion: followUp.version }, actor)
              .catch(() => undefined);
          }
        }
        return;
      }
      const reanalysis = await this.repository.findPreparationById(workflow.reanalysisPreparationId);
      if (!reanalysis) throw new ConflictException("WORKFLOW_REANALYSIS_MISSING");
      if (!isTerminalPreparation(reanalysis.status)) {
        await this.scheduleRetry(workflowId);
        return;
      }
      const status = reanalysis.status === "completed" ? "completed" : "completed_with_attention";
      await this.finish(workflowId, status);
    }
  }

  private async finish(workflowId: string, status: "completed" | "completed_with_attention") {
    await this.repository.transaction(async (transaction) => {
      const workflow = await this.repository.findWorkflowById(workflowId, transaction, true);
      if (!workflow || workflow.leaseOwner !== this.workerId || workflow.status === "cancelled") return;
      const now = new Date();
      workflow.status = status;
      workflow.leaseOwner = null;
      workflow.leaseExpiresAt = null;
      workflow.nextAttemptAt = null;
      workflow.finishedAt = now;
      workflow.version += 1;
      workflow.updatedAt = now;
      await this.repository.saveWorkflow(workflow, transaction);
      await this.audit.record(
        {
          tenantId: workflow.tenantId,
          actorUserId: workflow.actorUserId,
          action: "import.preparation.workflow.completed",
          resourceType: "preparation_workflow",
          resourceId: workflow.workflowId,
          outcome: "succeeded",
          metadata: { batchId: workflow.batchId, workflowId, status },
        },
        transaction,
      );
    });
  }

  async processOne(): Promise<boolean> {
    if (this.processing) return false;
    this.processing = true;
    try {
      const workflowId = await this.claim();
      if (!workflowId) return false;
      try {
        await this.processClaim(workflowId);
      } catch (error) {
        const status =
          typeof error === "object" &&
          error !== null &&
          "getStatus" in error &&
          typeof (error as { getStatus?: unknown }).getStatus === "function"
            ? Number((error as { getStatus: () => number }).getStatus())
            : 0;
        if (status >= 400 && status < 500) {
          await this.finishFailure(
            workflowId,
            status === 403 || status === 404 ? "EXECUTION_PERMISSION_REVOKED" : "WORKFLOW_STATE_CONFLICT",
          );
        } else {
          await this.scheduleRetry(workflowId);
        }
      }
      return true;
    } finally {
      this.processing = false;
    }
  }
}
