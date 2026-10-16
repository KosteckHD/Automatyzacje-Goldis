import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from "@nestjs/common";
import { UniqueConstraintError } from "sequelize";
import type { PreparedSetChunk, PreparedSetExecution } from "../../infrastructure/database/db";
import type { SessionPrincipal } from "../auth";
import { BusinessLeadService } from "../leads/public";
import { NotificationService } from "../notifications/public";
import { ImportPreparationService, requireCurrentSealedPreparation } from "../preparations/public";
import { PreparedSetExecutionRepository, type PreparedSetExecutionStatus } from "./prepared-set-execution.repository";
import { PreparedSetExecutionControlRepository } from "./prepared-set-execution-control.repository";
import { RunSubmissionService } from "./run-submissions.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,120}$/;

type Actor = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;
type SetStatus = PreparedSetExecutionStatus;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function startInput(body: unknown): { idempotencyKey: string; preparationId: string; snapshotFingerprint: string } {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["idempotencyKey", "preparationId", "snapshotFingerprint"].includes(key))
  ) {
    throw new BadRequestException("Nieprawidłowe żądanie uruchomienia całego importu");
  }
  const input = body as { idempotencyKey?: unknown; preparationId?: unknown; snapshotFingerprint?: unknown };
  if (
    typeof input.idempotencyKey !== "string" ||
    !KEY.test(input.idempotencyKey) ||
    typeof input.preparationId !== "string" ||
    !UUID.test(input.preparationId) ||
    typeof input.snapshotFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.snapshotFingerprint)
  ) {
    throw new BadRequestException("Odśwież podgląd i podaj poprawny klucz uruchomienia");
  }
  return {
    idempotencyKey: input.idempotencyKey,
    preparationId: input.preparationId,
    snapshotFingerprint: input.snapshotFingerprint,
  };
}

function publicExecution(
  execution: PreparedSetExecution,
  chunks: readonly PreparedSetChunk[],
  totalRows: number,
  chunkCounts: Readonly<Record<string, number>>,
  hasMoreChunks: boolean,
) {
  const page = chunks.slice(0, 20);
  return {
    executionId: execution.executionId,
    resultSetId: execution.executionId,
    batchId: execution.batchId,
    preparationId: execution.preparationId,
    status: execution.status,
    version: execution.version,
    referenceDate: execution.referenceDate,
    snapshotFingerprint: execution.snapshotFingerprint,
    cursorRowNumber: execution.cursorRowNumber,
    chunkCount: execution.chunkCount,
    totalRows,
    progress: {
      generatedChunks: execution.chunkCount,
      completedChunks: chunkCounts.completed ?? 0,
      activeChunks: (chunkCounts.running ?? 0) + (chunkCounts.submitting ?? 0),
      waitingChunks: (chunkCounts.queued ?? 0) + (chunkCounts.waiting_attention ?? 0),
      failedChunks: chunkCounts.failed ?? 0,
      cancelledChunks: chunkCounts.cancelled ?? 0,
    },
    errorCode: execution.errorCode,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    finishedAt: execution.finishedAt,
    chunks: page.map((chunk) => ({
      ordinal: chunk.ordinal,
      firstRowNumber: chunk.firstRowNumber,
      lastRowNumber: chunk.lastRowNumber,
      rowCount: chunk.rowNumbers.length,
      status: chunk.status,
      childSubmissionId: chunk.childSubmissionId,
      finishedAt: chunk.finishedAt,
    })),
    chunkPage: { nextAfterOrdinal: hasMoreChunks && page.length ? page[page.length - 1].ordinal : null },
  };
}

function parseChunkCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) {
    throw new BadRequestException("Nieprawidłowy kursor listy porcji");
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new BadRequestException("Nieprawidłowy kursor listy porcji");
  return cursor;
}

@Injectable()
export class PreparedSetExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(
    @Inject(ImportPreparationService) private readonly preparations: ImportPreparationService,
    @Inject(RunSubmissionService) private readonly submissions: RunSubmissionService,
    @Inject(PreparedSetExecutionRepository) private readonly executionRepository: PreparedSetExecutionRepository,
    @Inject(PreparedSetExecutionControlRepository)
    private readonly controlRepository: PreparedSetExecutionControlRepository,
    @Optional() @Inject(BusinessLeadService) private readonly leads?: BusinessLeadService,
    @Optional() @Inject(NotificationService) private readonly notifications?: NotificationService,
  ) {}

  onModuleInit() {
    void this.processOne().catch(() => undefined);
    this.timer = setInterval(() => void this.processOne().catch(() => undefined), 2_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async preview(batchId: string, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException("Nie znaleziono importu");
    await this.preparations.requireExecutableBatch(batchId, actor);
    const preparation = await this.executionRepository.findLatestPreparationForBatch(batchId, actor.tenantId);
    if (!preparation?.sealedAt || !["completed", "completed_with_attention"].includes(preparation.status)) {
      throw new ConflictException("Najpierw zakończ przygotowanie całego importu");
    }
    if (preparation.totalRows < 1) throw new ConflictException("Pustego importu nie można uruchomić");
    await requireCurrentSealedPreparation(batchId, [], undefined, preparation.preparationId);
    return {
      batchId,
      preparationId: preparation.preparationId,
      revision: preparation.revision,
      snapshotFingerprint: preparation.sourceFingerprint,
      totalRows: preparation.totalRows,
      referenceDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date()),
      counts: {
        ready: preparation.readyCount,
        review: preparation.reviewCount,
        duplicates: preparation.duplicateCount,
        skippedNoIdentifiers: preparation.skippedCount,
        waitingRegistry: preparation.waitingRegistryCount,
      },
    };
  }

  async start(batchId: string, body: unknown, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException("Nie znaleziono importu");
    const request = startInput(body);
    const { idempotencyKey } = request;
    return this.executionRepository
      .transaction(async (transaction) => {
        const batch = await this.preparations.requireExecutableBatch(batchId, actor, transaction);
        const hash = digest({
          batchId,
          preparationId: request.preparationId,
          snapshotFingerprint: request.snapshotFingerprint,
        });
        const existing = await this.executionRepository.findExistingForActor(
          actor.tenantId,
          actor.userId,
          idempotencyKey,
          transaction,
          true,
        );
        if (existing) {
          if (existing.requestHash !== hash || existing.batchId !== batchId) {
            throw new ConflictException("Ten klucz został użyty dla innego zestawu");
          }
          const priorPreparation = await this.executionRepository.findPreparation(existing.preparationId, transaction);
          const chunks = await this.executionRepository.findChunks(existing.executionId, 0, 21, transaction);
          const statusRows = await this.executionRepository.countChunkStatuses(existing.executionId, transaction);
          if (!priorPreparation) throw new NotFoundException("Nie znaleziono rewizji przygotowania");
          const countsByStatus = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)]));
          return {
            ...publicExecution(existing, chunks, priorPreparation.totalRows, countsByStatus, chunks.length > 20),
            counts: {
              ready: priorPreparation.readyCount,
              review: priorPreparation.reviewCount,
              duplicates: priorPreparation.duplicateCount,
              skippedNoIdentifiers: priorPreparation.skippedCount,
              waitingRegistry: priorPreparation.waitingRegistryCount,
            },
            replayed: true,
          };
        }
        const preparation = await this.executionRepository.findLatestPreparation(batchId, actor.tenantId, transaction);
        if (!preparation?.sealedAt || !["completed", "completed_with_attention"].includes(preparation.status)) {
          throw new ConflictException("Najpierw zakończ przygotowanie całego importu");
        }
        if (
          preparation.preparationId !== request.preparationId ||
          preparation.sourceFingerprint !== request.snapshotFingerprint
        ) {
          throw new ConflictException("Import zmienił się od podglądu; odśwież podsumowanie");
        }
        if (preparation.totalRows < 1) throw new ConflictException("Pustego importu nie można uruchomić");
        await requireCurrentSealedPreparation(batchId, [], transaction, preparation.preparationId);
        const referenceDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date());
        const now = new Date();
        const execution = await this.executionRepository.createExecution(
          {
            executionId: randomUUID(),
            tenantId: actor.tenantId,
            batchId: batch.id,
            preparationId: preparation.preparationId,
            actorUserId: actor.userId,
            idempotencyKey,
            requestHash: hash,
            snapshotFingerprint: preparation.sourceFingerprint,
            referenceDate,
            status: "queued",
            cursorRowNumber: 1,
            chunkCount: 0,
            version: 1,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: now,
            errorCode: null,
            createdAt: now,
            updatedAt: now,
            finishedAt: null,
          },
          transaction,
        );
        await this.executionRepository.createResultSet(
          {
            resultSetId: execution.executionId,
            tenantId: actor.tenantId,
            batchId: batch.id,
            toolId: batch.toolId,
            actorUserId: actor.userId,
            sourceType: "prepared_set_execution",
            sourceId: execution.executionId,
            referenceDate,
            status: "queued",
            createdAt: now,
            updatedAt: now,
            finishedAt: null,
          },
          transaction,
        );
        await this.executionRepository.recordAudit(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: "run.prepared_set.created",
            resourceType: "prepared_set_execution",
            resourceId: execution.executionId,
            outcome: "succeeded",
            metadata: {
              batchId,
              preparationId: preparation.preparationId,
              revision: preparation.revision,
              totalRows: preparation.totalRows,
              referenceDate,
            },
          },
          transaction,
        );
        return {
          ...publicExecution(execution, [], preparation.totalRows, {}, false),
          counts: {
            ready: preparation.readyCount,
            review: preparation.reviewCount,
            duplicates: preparation.duplicateCount,
            skippedNoIdentifiers: preparation.skippedCount,
            waitingRegistry: preparation.waitingRegistryCount,
          },
          replayed: false,
        };
      })
      .catch(async (error) => {
        if (!(error instanceof UniqueConstraintError)) throw error;
        const prior = await this.executionRepository.findExistingForActor(actor.tenantId, actor.userId, idempotencyKey);
        if (!prior) throw new ConflictException("Dla tego importu istnieje już aktywne wykonanie całego zestawu");
        const preparation = await this.executionRepository.findPreparation(prior.preparationId);
        const expectedHash = preparation
          ? digest({
              batchId,
              preparationId: preparation.preparationId,
              snapshotFingerprint: preparation.sourceFingerprint,
            })
          : "";
        if (prior.requestHash !== expectedHash || prior.batchId !== batchId)
          throw new ConflictException("Ten klucz został użyty dla innego zestawu");
        return this.get(batchId, prior.executionId, actor);
      });
  }

  async get(batchId: string, executionId: string, actor: Actor, afterOrdinalInput?: unknown) {
    if (!UUID.test(batchId) || !UUID.test(executionId)) throw new NotFoundException("Nie znaleziono wykonania zestawu");
    const afterOrdinal = parseChunkCursor(afterOrdinalInput);
    await this.preparations.requireReadableBatch(batchId, actor);
    const execution = await this.executionRepository.findExecution(batchId, executionId, actor.tenantId);
    if (!execution) throw new NotFoundException("Nie znaleziono wykonania zestawu");
    const [preparation, chunks, statusRows] = await Promise.all([
      this.executionRepository.findPreparation(execution.preparationId),
      this.executionRepository.findChunks(executionId, afterOrdinal, 21),
      this.executionRepository.countChunkStatuses(executionId),
    ]);
    if (!preparation) throw new NotFoundException("Nie znaleziono rewizji przygotowania");
    const countsByStatus = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)]));
    return publicExecution(execution, chunks, preparation.totalRows, countsByStatus, chunks.length > 20);
  }

  async cancel(batchId: string, executionId: string, body: unknown, actor: Actor) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion)
    ) {
      throw new BadRequestException("Wymagana jest aktualna wersja wykonania");
    }
    await this.preparations.requireExecutableBatch(batchId, actor);
    const expectedVersion = Number((body as { expectedVersion: number }).expectedVersion);
    const changed = await this.controlRepository.withLockedExecution(
      executionId,
      batchId,
      actor.tenantId,
      async (execution, transaction) => {
        if (execution.version !== expectedVersion)
          throw new ConflictException("Wykonanie zmieniło się; odśwież jego stan");
        if (["completed", "cancelled", "failed"].includes(execution.status)) return { childId: null, changed: false };
        const current = await this.controlRepository.findLatestOpenChunk(executionId, transaction);
        execution.status = "cancelled";
        execution.version += 1;
        execution.finishedAt = new Date();
        execution.leaseOwner = null;
        execution.leaseExpiresAt = null;
        execution.nextAttemptAt = null;
        execution.updatedAt = new Date();
        await this.controlRepository.saveExecution(execution, transaction);
        await this.leads?.completeResultSet(executionId, "cancelled", transaction);
        if (current) {
          current.status = "cancelled";
          current.updatedAt = new Date();
          current.finishedAt = new Date();
          await this.controlRepository.saveChunk(current, transaction);
        }
        await this.controlRepository.recordCancellation(
          { tenantId: actor.tenantId, actorUserId: actor.userId },
          executionId,
          Boolean(current?.childSubmissionId),
          transaction,
        );
        return { childId: current?.childSubmissionId ?? null, changed: true };
      },
    );
    if (changed.childId) {
      const role = await this.currentRole(actor);
      if (role) {
        const child = await this.submissions.findVersion(changed.childId);
        if (child)
          await this.submissions
            .cancel(changed.childId, child.version, { tenantId: actor.tenantId, actorUserId: actor.userId }, role)
            .catch(() => undefined);
      }
    }
    return this.get(batchId, executionId, actor);
  }

  async pause(batchId: string, executionId: string, body: unknown, actor: Actor) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion)
    ) {
      throw new BadRequestException("Wymagana jest aktualna wersja wykonania");
    }
    await this.preparations.requireExecutableBatch(batchId, actor);
    const expectedVersion = Number((body as { expectedVersion: number }).expectedVersion);
    await this.controlRepository.withLockedExecution(
      executionId,
      batchId,
      actor.tenantId,
      async (execution, transaction) => {
        if (execution.version !== expectedVersion)
          throw new ConflictException("Wykonanie zmieniło się; odśwież jego stan");
        if (["completed", "cancelled", "failed"].includes(execution.status))
          throw new ConflictException("Zakończonego wykonania nie można wstrzymać");
        if (execution.status === "paused" || execution.status === "pause_requested") return;
        execution.status = "pause_requested";
        execution.errorCode = null;
        execution.version += 1;
        execution.nextAttemptAt = new Date();
        execution.updatedAt = new Date();
        await this.controlRepository.saveExecution(execution, transaction);
        await this.controlRepository.recordControlEvent(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: "run.prepared_set.pause_requested",
            resourceType: "prepared_set_execution",
            resourceId: executionId,
            outcome: "succeeded",
            metadata: { chunkCount: execution.chunkCount },
          },
          transaction,
        );
      },
    );
    return this.get(batchId, executionId, actor);
  }

  async resume(batchId: string, executionId: string, body: unknown, actor: Actor) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion)
    ) {
      throw new BadRequestException("Wymagana jest aktualna wersja wykonania");
    }
    await this.preparations.requireExecutableBatch(batchId, actor);
    const expectedVersion = Number((body as { expectedVersion: number }).expectedVersion);
    await this.controlRepository.withLockedExecution(
      executionId,
      batchId,
      actor.tenantId,
      async (execution, transaction) => {
        if (execution.version !== expectedVersion)
          throw new ConflictException("Wykonanie zmieniło się; odśwież jego stan");
        if (execution.status !== "paused") throw new ConflictException("Wznawiać można tylko wstrzymane wykonanie");
        const role = await this.currentRole(actor);
        if (!role) throw new ForbiddenException("Konto lub dostęp do firmy nie jest już aktywny");
        execution.status = "queued";
        execution.errorCode = null;
        execution.version += 1;
        execution.leaseOwner = null;
        execution.leaseExpiresAt = null;
        execution.nextAttemptAt = new Date();
        execution.finishedAt = null;
        execution.updatedAt = new Date();
        await this.controlRepository.saveExecution(execution, transaction);
        await this.controlRepository.recordControlEvent(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: "run.prepared_set.resumed",
            resourceType: "prepared_set_execution",
            resourceId: executionId,
            outcome: "succeeded",
            metadata: { chunkCount: execution.chunkCount },
          },
          transaction,
        );
      },
    );
    return this.get(batchId, executionId, actor);
  }

  private async currentRole(actor: Actor): Promise<Actor["role"] | null> {
    return this.executionRepository.findCurrentRole(actor.userId, actor.tenantId);
  }

  private async release(
    executionId: string,
    status: SetStatus,
    errorCode: string | null,
    delayMs: number,
    terminal = false,
  ) {
    const leads = this.leads;
    const notifications = this.notifications;
    await this.executionRepository.release(
      { executionId, workerId: this.workerId, status, errorCode, delayMs, terminal },
      {
        completeResultSet: leads
          ? (resultSetStatus, transaction) => leads.completeResultSet(executionId, resultSetStatus, transaction)
          : undefined,
        recordActionRequired: notifications
          ? (resultSet, transaction) => notifications.recordResultSetEvent(resultSet, "action_required", transaction)
          : undefined,
      },
    );
  }

  private async processClaimed(executionId: string) {
    const execution = await this.executionRepository.findExecutionById(executionId);
    if (!execution || execution.leaseOwner !== this.workerId) return;
    const pauseRequested = execution.status === "pause_requested";
    const role = await this.currentRole({
      tenantId: execution.tenantId,
      userId: execution.actorUserId,
      role: "operator",
    });
    if (!role) {
      await this.release(executionId, "waiting_attention", "ACTOR_INACTIVE", 60_000);
      return;
    }
    const actor = { tenantId: execution.tenantId, actorUserId: execution.actorUserId };
    let chunk = await this.executionRepository.findNextOpenChunk(executionId);
    if (!chunk && !pauseRequested) chunk = await this.executionRepository.ensureChunk(executionId, this.workerId);
    if (!chunk) {
      if (pauseRequested) {
        await this.release(executionId, "paused", null, 0);
        return;
      }
      const remaining = await this.executionRepository.countRemainingRows(
        execution.preparationId,
        execution.cursorRowNumber,
      );
      if (remaining > 0) {
        await this.release(executionId, "running", "CHUNK_RETRY", 2_000);
        return;
      }
      const incomplete = await this.executionRepository.countIncompleteChunks(executionId);
      if (incomplete) {
        await this.release(executionId, "waiting_attention", "CHUNK_REQUIRES_ATTENTION", 30_000);
        return;
      }
      await this.release(executionId, "completed", null, 0, true);
      return;
    }
    const chunkOrdinal = chunk.ordinal;
    if (chunk.childSubmissionId) {
      const child = await this.submissions.get(chunk.childSubmissionId, actor, role);
      const now = new Date();
      if (child.status === "completed") {
        await this.executionRepository.markChunkCompleted(executionId, chunkOrdinal, now);
        await this.release(executionId, pauseRequested ? "paused" : "running", null, 0);
        return;
      }
      if (child.status === "cancelled") {
        chunk.status = "waiting_attention";
        chunk.updatedAt = now;
        await this.executionRepository.saveChunk(chunk);
        await this.release(
          executionId,
          pauseRequested ? "paused" : "waiting_attention",
          "CHILD_SUBMISSION_CANCELLED",
          pauseRequested ? 0 : 30_000,
        );
        return;
      }
      const needsAttention = child.status === "waiting_attention";
      chunk.status = needsAttention ? "waiting_attention" : "running";
      chunk.updatedAt = now;
      await this.executionRepository.saveChunk(chunk);
      await this.release(
        executionId,
        pauseRequested ? "paused" : needsAttention ? "waiting_attention" : "running",
        needsAttention ? "CHILD_SUBMISSION_REQUIRES_ATTENTION" : null,
        pauseRequested ? 0 : needsAttention ? 30_000 : 5_000,
      );
      return;
    }
    if (pauseRequested && !chunk.childSubmissionId) {
      await this.release(executionId, "paused", null, 0);
      return;
    }
    chunk.status = "submitting";
    chunk.updatedAt = new Date();
    await this.executionRepository.saveChunk(chunk);
    const key = `set-${executionId}-${String(chunk.ordinal).padStart(8, "0")}`;
    const child = await this.submissions.createPreparedSetChunk({
      batchId: execution.batchId,
      rowNumbers: chunk.rowNumbers,
      preparationId: execution.preparationId,
      referenceDate: execution.referenceDate,
      resultSetId: execution.executionId,
      idempotencyKey: key,
      actor,
      role,
    });
    const linked = await this.executionRepository.linkChildSubmission(executionId, chunkOrdinal, child.submissionId);
    if (!linked) {
      const currentRole = await this.currentRole({ tenantId: execution.tenantId, userId: execution.actorUserId, role });
      const childRow = await this.submissions.findVersion(child.submissionId);
      if (currentRole && childRow)
        await this.submissions.cancel(child.submissionId, childRow.version, actor, currentRole).catch(() => undefined);
      return;
    }
    await this.release(executionId, "running", null, 1_000);
  }

  async processOne() {
    if (this.processing) return;
    this.processing = true;
    try {
      const executionId = await this.executionRepository.claim(this.workerId);
      if (executionId) {
        try {
          await this.processClaimed(executionId);
        } catch (error) {
          const code =
            error instanceof ConflictException
              ? "PREPARATION_CHANGED"
              : error instanceof ForbiddenException || error instanceof NotFoundException
                ? "EXECUTE_ACCESS_REVOKED"
                : "SET_EXECUTION_RETRY";
          const terminalAttention = code !== "SET_EXECUTION_RETRY";
          await this.release(
            executionId,
            terminalAttention ? "waiting_attention" : "running",
            code,
            terminalAttention ? 60_000 : 5_000,
          ).catch(() => undefined);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
