import { createHash, randomUUID } from "node:crypto";
import { assessRegonEnrichmentEligibility } from "@goldis/core";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Transaction } from "sequelize";
import type { EnrichmentJob, ImportBatch } from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit";
import type { SessionPrincipal } from "../auth";
import type { EnrichmentJobStartDto as StartBody } from "./enrichment-job.dto";
import { EnrichmentJobsRepository } from "./enrichment-jobs.repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 500;
type Actor = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;

function selectRows(body: StartBody): number[] {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestException("Nieprawidłowy wybór wierszy");
  const keys = Object.keys(body as object);
  if (
    keys.some((key) => !["idempotencyKey", "rowNumbers", "fromRow", "toRow"].includes(key)) ||
    typeof body.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{16,120}$/.test(body.idempotencyKey)
  ) {
    throw new BadRequestException("Nieprawidłowy klucz lub pola zadania");
  }
  const hasRows = Object.hasOwn(body, "rowNumbers");
  const hasRange = Object.hasOwn(body, "fromRow") || Object.hasOwn(body, "toRow");
  if (hasRows === hasRange) throw new BadRequestException("Podaj listę wierszy albo zakres");
  let rows: number[];
  if (hasRows) {
    if (
      !Array.isArray(body.rowNumbers) ||
      body.rowNumbers.length < 1 ||
      body.rowNumbers.length > MAX_ITEMS ||
      body.rowNumbers.some((value) => !Number.isSafeInteger(value) || (value as number) < 2)
    ) {
      throw new BadRequestException("Lista wierszy musi zawierać od 1 do 500 poprawnych numerów");
    }
    rows = [...body.rowNumbers] as number[];
    if (new Set(rows).size !== rows.length) throw new BadRequestException("Lista wierszy zawiera powtórzenia");
  } else {
    if (
      !Number.isSafeInteger(body.fromRow) ||
      !Number.isSafeInteger(body.toRow) ||
      (body.fromRow as number) < 2 ||
      (body.toRow as number) < (body.fromRow as number) ||
      (body.toRow as number) - (body.fromRow as number) + 1 > MAX_ITEMS
    ) {
      throw new BadRequestException("Zakres musi obejmować od 1 do 500 wierszy");
    }
    rows = Array.from(
      { length: (body.toRow as number) - (body.fromRow as number) + 1 },
      (_, index) => (body.fromRow as number) + index,
    );
  }
  return rows.sort((left, right) => left - right);
}

function payloadHash(rowNumbers: number[]): string {
  return createHash("sha256").update(JSON.stringify(rowNumbers)).digest("hex");
}

function publicJob(job: EnrichmentJob) {
  return {
    id: job.jobId,
    batchId: job.batchId,
    status: job.status,
    selectedCount: job.selectedCount,
    completedCount: job.completedCount,
    excludedCount: job.excludedCount,
    failedCount: job.failedCount,
    cancelledCount: job.cancelledCount,
    version: job.version,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

function reasonForEligibility(reasonCode: string | null): string {
  switch (reasonCode) {
    case "REGON_PRESENT":
      return "REGON_PRESENT";
    case "REGON_REQUIRES_REVIEW":
      return "REGON_REQUIRES_REVIEW";
    case "REGON_STATE_INCONSISTENT":
      return "REGON_STATE_INCONSISTENT";
    case "NIP_INVALID":
      return "NIP_INVALID";
    default:
      return "NOT_ELIGIBLE";
  }
}

async function assertExecuteGrant(
  batch: ImportBatch,
  actor: Actor,
  transaction: Transaction,
  repository: EnrichmentJobsRepository,
): Promise<void> {
  if (actor.role !== "admin" && actor.role !== "manager" && actor.role !== "operator") throw new ForbiddenException();
  if (!batch.tenantId || batch.tenantId !== actor.tenantId) throw new NotFoundException();
  if (actor.role === "operator" && batch.ownerUserId !== actor.userId) throw new NotFoundException();
  if (!(await repository.isToolAvailable(batch.toolId, transaction))) throw new NotFoundException();
  if (actor.role === "admin") return;
  const grant = await repository.hasExecuteGrant({
    tenantId: actor.tenantId,
    userId: actor.userId,
    toolId: batch.toolId,
    transaction,
  });
  if (!grant) throw new NotFoundException();
}

@Injectable()
export class EnrichmentJobService {
  constructor(
    @Inject(EnrichmentJobsRepository)
    private readonly repository: EnrichmentJobsRepository = new EnrichmentJobsRepository(),
  ) {}

  async start(batchId: string, body: StartBody, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException();
    const rowNumbers = selectRows(body);
    const selectionHash = payloadHash(rowNumbers);
    return this.repository.transaction(async (transaction) => {
      const batch = await this.repository.findBatchForUpdate(batchId, transaction);
      if (!batch) throw new NotFoundException();
      await assertExecuteGrant(batch, actor, transaction, this.repository);
      const existing = await this.repository.findJobForIdempotency({
        batchId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        idempotencyKey: body.idempotencyKey as string,
        transaction,
      });
      if (existing) {
        if (existing.selectionHash !== selectionHash)
          throw new ConflictException("Klucz idempotencji został użyty dla innego wyboru");
        return { ...publicJob(existing), replayed: true };
      }
      const rows = await this.repository.findSelectedRows(batchId, rowNumbers, transaction);
      if (rows.length !== rowNumbers.length) throw new BadRequestException("Wybór zawiera wiersz spoza tego importu");
      const ids = rows.map((row) => row.id);
      const [pendingCorrections, openConflicts, runIds] = await Promise.all([
        this.repository.findPendingCorrectionRowIds(ids, transaction),
        this.repository.findOpenConflictRowIds(ids, transaction),
        this.repository.findRowsAlreadyInRuns(batchId, ids, transaction),
      ]);
      const corrections = new Set(pendingCorrections.map((item) => item.sourceRowId));
      const conflicts = new Set(openConflicts.map((item) => item.sourceRowId));
      const runs = new Set(runIds);
      const now = new Date();
      const jobId = randomUUID();
      const items = rows.map((row) => {
        const eligibility = assessRegonEnrichmentEligibility({
          regonRaw: row.regonRaw,
          effectiveRegon: row.effectiveRegon,
          nipRaw: row.nipRaw,
        });
        let reasonCode: string | null = null;
        if (corrections.has(row.id)) reasonCode = "CORRECTION_PENDING";
        else if (conflicts.has(row.id)) reasonCode = "GROUPING_CONFLICT";
        else if (runs.has(row.id)) reasonCode = "RUN_EXISTS";
        else if (!eligibility.eligible) reasonCode = reasonForEligibility(eligibility.reasonCode);
        return {
          itemId: randomUUID(),
          jobId,
          batchId,
          sourceRowId: row.id,
          rowNumber: row.rowNumber,
          expectedRowVersion: row.rowVersion,
          status: reasonCode ? ("excluded" as const) : ("pending" as const),
          reasonCode,
          errorCode: null,
          attemptCount: 0,
          nextAttemptAt: null,
          auditId: null,
          createdAt: now,
          updatedAt: now,
          finishedAt: reasonCode ? now : null,
        };
      });
      const excludedCount = items.filter((item) => item.status === "excluded").length;
      const actionableCount = items.length - excludedCount;
      const job = await this.repository.createJob(
        {
          jobId,
          tenantId: actor.tenantId,
          batchId,
          actorUserId: actor.userId,
          idempotencyKey: body.idempotencyKey as string,
          selectionHash,
          status: actionableCount > 0 ? "queued" : "completed",
          selectedCount: items.length,
          completedCount: 0,
          excludedCount,
          failedCount: 0,
          cancelledCount: 0,
          version: 1,
          cancelRequested: false,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          finishedAt: actionableCount > 0 ? null : now,
        },
        transaction,
      );
      await this.repository.createItems(items, transaction);
      await recordAuditEvent(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "enrichment.job.created",
          resourceType: "enrichment_job",
          resourceId: job.jobId,
          outcome: "succeeded",
          metadata: { selectedCount: job.selectedCount, excludedCount: job.excludedCount },
        },
        transaction,
      );
      return { ...publicJob(job), replayed: false };
    });
  }

  async get(jobId: string, actor: Actor) {
    const job = await this.findAuthorized(jobId, actor);
    const pendingCount = await this.repository.countActiveItems(jobId);
    return { ...publicJob(job), pendingCount };
  }

  async listForBatch(batchId: string, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException();
    const batch = await this.repository.findBatchForTenant(batchId, actor.tenantId);
    if (
      !batch ||
      (actor.role === "operator" && batch.ownerUserId !== actor.userId) ||
      !["admin", "manager", "operator", "reviewer"].includes(actor.role)
    )
      throw new NotFoundException();
    const rows = await this.repository.findJobsForBatch(batchId, actor.tenantId);
    return { items: rows.map(publicJob) };
  }

  async listItems(jobId: string, rawCursor: unknown, actor: Actor) {
    const job = await this.findAuthorized(jobId, actor);
    const cursor = rawCursor === undefined || rawCursor === "" ? 1 : Number(rawCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > 1_000_000)
      throw new BadRequestException("Nieprawidłowy kursor wierszy");
    const page = await this.repository.findItemsPage(job.jobId, cursor);
    const hasMore = page.length > 50;
    const items = (hasMore ? page.slice(0, 50) : page).map((item) => ({
      rowNumber: item.rowNumber,
      expectedRowVersion: item.expectedRowVersion,
      status: item.status,
      reasonCode: item.reasonCode,
      errorCode: item.errorCode,
      attemptCount: item.attemptCount,
      nextAttemptAt: item.nextAttemptAt,
      updatedAt: item.updatedAt,
      finishedAt: item.finishedAt,
    }));
    const lastItem = items.at(-1);
    return { items, nextCursor: hasMore && lastItem ? String(lastItem.rowNumber + 1) : null, hasMore, limit: 50 };
  }

  async cancel(jobId: string, body: unknown, actor: Actor) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body as object).length !== 1 ||
      !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion) ||
      (body as { expectedVersion: number }).expectedVersion < 1
    ) {
      throw new BadRequestException("Wymagana jest aktualna wersja zadania");
    }
    return this.repository.transaction(async (transaction) => {
      const job = await this.repository.findJobForUpdate(jobId, actor.tenantId, transaction);
      if (!job) throw new NotFoundException();
      const batch = await this.repository.findBatchForJobForShare(job.batchId, transaction);
      if (!batch || batch.tenantId !== job.tenantId) throw new NotFoundException();
      await assertExecuteGrant(batch, actor, transaction, this.repository);
      if (
        job.status === "cancelled" ||
        job.status === "completed" ||
        job.status === "partial" ||
        job.status === "failed"
      ) {
        throw new ConflictException("Zadanie jest już zakończone");
      }
      if (job.version !== (body as { expectedVersion: number }).expectedVersion)
        throw new ConflictException("Zadanie zostało zmienione; odśwież jego status");
      const now = new Date();
      const count = await this.repository.cancelPendingItems(job.jobId, now, transaction);
      job.cancelRequested = true;
      job.cancelledCount += count;
      job.status = "cancelled";
      job.version += 1;
      job.updatedAt = now;
      job.finishedAt = now;
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
      await this.repository.saveJob(job, transaction);
      await recordAuditEvent(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "enrichment.job.cancelled",
          resourceType: "enrichment_job",
          resourceId: job.jobId,
          outcome: "succeeded",
          metadata: { cancelledCount: count },
        },
        transaction,
      );
      return publicJob(job);
    });
  }

  private async findAuthorized(jobId: string, actor: Actor) {
    if (!UUID.test(jobId)) throw new NotFoundException();
    const job = await this.repository.findJobForTenant(jobId, actor.tenantId);
    if (!job) throw new NotFoundException();
    const batch = await this.repository.findBatchForTenant(job.batchId, actor.tenantId);
    if (!batch || (actor.role === "operator" && batch.ownerUserId !== actor.userId)) throw new NotFoundException();
    if (!["admin", "manager", "operator", "reviewer"].includes(actor.role)) throw new NotFoundException();
    return job;
  }
}
