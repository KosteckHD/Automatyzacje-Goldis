import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException,
  Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Op, QueryTypes, type Transaction } from "sequelize";
import type { Request } from "express";
import { assessRegonEnrichmentEligibility } from "@goldis/core";
import {
  EnrichmentJob, EnrichmentJobItem, ImportBatch, RegonCorrection, EntityGroupingConflict,
  SourceRow, Tool, ToolGrant, sequelize, type EnrichmentJobItemStatus,
} from "./db";
import { recordAuditEvent } from "./audit";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { SessionGuard, readSessionPrincipal, type SessionPrincipal } from "./session";
import { EntityGroupingService } from "./entity-grouping-service";
import { RegistryEnrichmentService } from "./registry-enrichment";
import { RegistryLookupService } from "./registry-lookup";
import { RegistryProvider, RegistryProviderError } from "./registry-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 500;
const JOB_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const retryableProviderCodes = new Set(["RATE_LIMITED", "UNAVAILABLE", "TIMEOUT"]);
type Actor = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;

type StartBody = Readonly<{
  idempotencyKey?: unknown;
  rowNumbers?: unknown;
  fromRow?: unknown;
  toRow?: unknown;
}>;

function selectRows(body: StartBody): number[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Nieprawidłowy wybór wierszy");
  const keys = Object.keys(body as object);
  if (keys.some((key) => !["idempotencyKey", "rowNumbers", "fromRow", "toRow"].includes(key))
    || typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,120}$/.test(body.idempotencyKey)) {
    throw new BadRequestException("Nieprawidłowy klucz lub pola zadania");
  }
  const hasRows = Object.hasOwn(body, "rowNumbers");
  const hasRange = Object.hasOwn(body, "fromRow") || Object.hasOwn(body, "toRow");
  if (hasRows === hasRange) throw new BadRequestException("Podaj listę wierszy albo zakres");
  let rows: number[];
  if (hasRows) {
    if (!Array.isArray(body.rowNumbers) || body.rowNumbers.length < 1 || body.rowNumbers.length > MAX_ITEMS
      || body.rowNumbers.some((value) => !Number.isSafeInteger(value) || (value as number) < 2)) {
      throw new BadRequestException("Lista wierszy musi zawierać od 1 do 500 poprawnych numerów");
    }
    rows = [...body.rowNumbers] as number[];
    if (new Set(rows).size !== rows.length) throw new BadRequestException("Lista wierszy zawiera powtórzenia");
  } else {
    if (!Number.isSafeInteger(body.fromRow) || !Number.isSafeInteger(body.toRow)
      || (body.fromRow as number) < 2 || (body.toRow as number) < (body.fromRow as number)
      || (body.toRow as number) - (body.fromRow as number) + 1 > MAX_ITEMS) {
      throw new BadRequestException("Zakres musi obejmować od 1 do 500 wierszy");
    }
    rows = Array.from({ length: (body.toRow as number) - (body.fromRow as number) + 1 }, (_, index) => (body.fromRow as number) + index);
  }
  return rows.sort((left, right) => left - right);
}

function payloadHash(rowNumbers: number[]): string {
  return createHash("sha256").update(JSON.stringify(rowNumbers)).digest("hex");
}

function publicJob(job: EnrichmentJob) {
  return {
    id: job.jobId, batchId: job.batchId, status: job.status, selectedCount: job.selectedCount,
    completedCount: job.completedCount, excludedCount: job.excludedCount, failedCount: job.failedCount,
    cancelledCount: job.cancelledCount, version: job.version, errorCode: job.errorCode,
    createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
  };
}

function reasonForEligibility(reasonCode: string | null): string {
  switch (reasonCode) {
    case "REGON_PRESENT": return "REGON_PRESENT";
    case "REGON_REQUIRES_REVIEW": return "REGON_REQUIRES_REVIEW";
    case "REGON_STATE_INCONSISTENT": return "REGON_STATE_INCONSISTENT";
    case "NIP_INVALID": return "NIP_INVALID";
    default: return "NOT_ELIGIBLE";
  }
}

async function hasRun(batchId: string, sourceRowId: string, transaction: Transaction): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `SELECT run.id FROM automation_runs AS run
      WHERE run.batch_id = $1 AND (run.source_row_id = $2 OR EXISTS (
        SELECT 1 FROM run_source_rows AS member WHERE member.run_id = run.id AND member.source_row_id = $2
      )) LIMIT 1 FOR UPDATE OF run`,
    { bind: [batchId, sourceRowId], transaction, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
}

async function assertExecuteGrant(batch: ImportBatch, actor: Actor, transaction: Transaction): Promise<void> {
  if (actor.role !== "admin" && actor.role !== "operator") throw new ForbiddenException();
  if (!batch.tenantId || batch.tenantId !== actor.tenantId) throw new NotFoundException();
  if (actor.role === "operator" && batch.ownerUserId !== actor.userId) throw new NotFoundException();
  const tool = await Tool.findByPk(batch.toolId, { attributes: ["status"], transaction, lock: transaction.LOCK.SHARE });
  if (!tool || tool.status !== "available") throw new NotFoundException();
  if (actor.role === "admin") return;
  const grant = await ToolGrant.findOne({
    where: { tenantId: actor.tenantId, userId: actor.userId, toolId: batch.toolId, canExecute: true },
    attributes: ["userId"], transaction, lock: transaction.LOCK.SHARE,
  });
  if (!grant) throw new NotFoundException();
}

@Injectable()
export class EnrichmentJobService {
  async start(batchId: string, body: StartBody, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException();
    const rowNumbers = selectRows(body);
    const selectionHash = payloadHash(rowNumbers);
    return sequelize.transaction(async (transaction) => {
      const batch = await ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!batch) throw new NotFoundException();
      await assertExecuteGrant(batch, actor, transaction);
      const existing = await EnrichmentJob.findOne({
        where: { batchId, tenantId: actor.tenantId, actorUserId: actor.userId, idempotencyKey: body.idempotencyKey as string },
        transaction, lock: transaction.LOCK.UPDATE,
      });
      if (existing) {
        if (existing.selectionHash !== selectionHash) throw new ConflictException("Klucz idempotencji został użyty dla innego wyboru");
        return { ...publicJob(existing), replayed: true };
      }
      const rows = await SourceRow.findAll({
        where: { batchId, rowNumber: rowNumbers }, order: [["rowNumber", "ASC"]], transaction, lock: transaction.LOCK.UPDATE,
      });
      if (rows.length !== rowNumbers.length) throw new BadRequestException("Wybór zawiera wiersz spoza tego importu");
      const ids = rows.map((row) => row.id);
      const pendingCorrections = await RegonCorrection.findAll({
        where: { sourceRowId: ids, status: "pending" }, attributes: ["sourceRowId"], transaction,
      });
      const openConflicts = await EntityGroupingConflict.findAll({
        where: { sourceRowId: ids, status: "open" }, attributes: ["sourceRowId"], transaction,
      });
      const runIds = await sequelize.query<{ source_row_id: string }>(
        `SELECT DISTINCT selected.id AS source_row_id FROM source_rows AS selected
           JOIN automation_runs AS run ON run.batch_id = selected.batch_id
          WHERE selected.batch_id = $1 AND selected.id = ANY($2::uuid[])
            AND (run.source_row_id = selected.id OR EXISTS (
              SELECT 1 FROM run_source_rows AS member WHERE member.run_id = run.id AND member.source_row_id = selected.id
            ))`,
        { bind: [batchId, ids], transaction, type: QueryTypes.SELECT },
      );
      const corrections = new Set(pendingCorrections.map((item) => item.sourceRowId));
      const conflicts = new Set(openConflicts.map((item) => item.sourceRowId));
      const runs = new Set(runIds.map((item) => item.source_row_id));
      const now = new Date();
      const jobId = randomUUID();
      const items = rows.map((row) => {
        const eligibility = assessRegonEnrichmentEligibility({ regonRaw: row.regonRaw, effectiveRegon: row.effectiveRegon, nipRaw: row.nipRaw });
        let reasonCode: string | null = null;
        if (corrections.has(row.id)) reasonCode = "CORRECTION_PENDING";
        else if (conflicts.has(row.id)) reasonCode = "GROUPING_CONFLICT";
        else if (runs.has(row.id)) reasonCode = "RUN_EXISTS";
        else if (!eligibility.eligible) reasonCode = reasonForEligibility(eligibility.reasonCode);
        return {
          itemId: randomUUID(), jobId, batchId, sourceRowId: row.id, rowNumber: row.rowNumber,
          expectedRowVersion: row.rowVersion, status: reasonCode ? "excluded" as const : "pending" as const,
          reasonCode, errorCode: null, attemptCount: 0, nextAttemptAt: null, auditId: null,
          createdAt: now, updatedAt: now, finishedAt: reasonCode ? now : null,
        };
      });
      const excludedCount = items.filter((item) => item.status === "excluded").length;
      const actionableCount = items.length - excludedCount;
      const job = await EnrichmentJob.create({
        jobId, tenantId: actor.tenantId, batchId, actorUserId: actor.userId,
        idempotencyKey: body.idempotencyKey as string, selectionHash,
        status: actionableCount > 0 ? "queued" : "completed", selectedCount: items.length,
        completedCount: 0, excludedCount, failedCount: 0, cancelledCount: 0,
        version: 1, cancelRequested: false, leaseOwner: null, leaseExpiresAt: null, errorCode: null,
        createdAt: now, updatedAt: now, finishedAt: actionableCount > 0 ? null : now,
      }, { transaction });
      await EnrichmentJobItem.bulkCreate(items, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "enrichment.job.created",
        resourceType: "enrichment_job", resourceId: job.jobId, outcome: "succeeded",
        metadata: { selectedCount: job.selectedCount, excludedCount: job.excludedCount },
      }, transaction);
      return { ...publicJob(job), replayed: false };
    });
  }

  async get(jobId: string, actor: Actor) {
    const job = await this.findAuthorized(jobId, actor);
    const pendingCount = await EnrichmentJobItem.count({ where: { jobId, status: ["pending", "processing"] } });
    return { ...publicJob(job), pendingCount };
  }

  async listForBatch(batchId: string, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException();
    const batch = await ImportBatch.findOne({ where: { id: batchId, tenantId: actor.tenantId } });
    if (!batch || (actor.role === "operator" && batch.ownerUserId !== actor.userId)
      || !["admin", "operator", "reviewer"].includes(actor.role)) throw new NotFoundException();
    const rows = await EnrichmentJob.findAll({
      where: { batchId, tenantId: actor.tenantId }, order: [["createdAt", "DESC"], ["jobId", "DESC"]], limit: 20,
    });
    return { items: rows.map(publicJob) };
  }

  async listItems(jobId: string, rawCursor: unknown, actor: Actor) {
    const job = await this.findAuthorized(jobId, actor);
    const cursor = rawCursor === undefined || rawCursor === "" ? 1 : Number(rawCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > 1_000_000) throw new BadRequestException("Nieprawidłowy kursor wierszy");
    const page = await EnrichmentJobItem.findAll({
      where: { jobId: job.jobId, rowNumber: { [Op.gte]: cursor } },
      order: [["rowNumber", "ASC"]], limit: 51,
      attributes: ["rowNumber", "expectedRowVersion", "status", "reasonCode", "errorCode", "attemptCount", "nextAttemptAt", "updatedAt", "finishedAt"],
    });
    const hasMore = page.length > 50;
    const items = (hasMore ? page.slice(0, 50) : page).map((item) => ({
      rowNumber: item.rowNumber, expectedRowVersion: item.expectedRowVersion, status: item.status,
      reasonCode: item.reasonCode, errorCode: item.errorCode, attemptCount: item.attemptCount,
      nextAttemptAt: item.nextAttemptAt, updatedAt: item.updatedAt, finishedAt: item.finishedAt,
    }));
    return { items, nextCursor: hasMore ? String(items.at(-1)!.rowNumber + 1) : null, hasMore, limit: 50 };
  }

  async cancel(jobId: string, body: unknown, actor: Actor) {
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body as object).length !== 1 || !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion)
      || ((body as { expectedVersion: number }).expectedVersion < 1)) {
      throw new BadRequestException("Wymagana jest aktualna wersja zadania");
    }
    return sequelize.transaction(async (transaction) => {
      const job = await EnrichmentJob.findOne({ where: { jobId, tenantId: actor.tenantId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!job) throw new NotFoundException();
      const batch = await ImportBatch.findByPk(job.batchId, { transaction, lock: transaction.LOCK.SHARE });
      if (!batch || batch.tenantId !== job.tenantId) throw new NotFoundException();
      await assertExecuteGrant(batch, actor, transaction);
      if (job.status === "cancelled" || job.status === "completed" || job.status === "partial" || job.status === "failed") {
        throw new ConflictException("Zadanie jest już zakończone");
      }
      if (job.version !== (body as { expectedVersion: number }).expectedVersion) throw new ConflictException("Zadanie zostało zmienione; odśwież jego status");
      const now = new Date();
      const cancelledItems = await sequelize.query(
        `UPDATE enrichment_job_items SET status = 'cancelled', updated_at = $1, finished_at = $1
          WHERE job_id = $2 AND status IN ('pending', 'processing') RETURNING item_id`,
        { bind: [now, job.jobId], transaction, type: QueryTypes.SELECT },
      );
      const count = cancelledItems.length;
      job.cancelRequested = true;
      job.cancelledCount += count;
      job.status = "cancelled";
      job.version += 1;
      job.updatedAt = now;
      job.finishedAt = now;
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
      await job.save({ transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "enrichment.job.cancelled",
        resourceType: "enrichment_job", resourceId: job.jobId, outcome: "succeeded",
        metadata: { cancelledCount: count },
      }, transaction);
      return publicJob(job);
    });
  }

  private async findAuthorized(jobId: string, actor: Actor) {
    if (!UUID.test(jobId)) throw new NotFoundException();
    const job = await EnrichmentJob.findOne({ where: { jobId, tenantId: actor.tenantId } });
    if (!job) throw new NotFoundException();
    const batch = await ImportBatch.findOne({ where: { id: job.batchId, tenantId: actor.tenantId } });
    if (!batch || (actor.role === "operator" && batch.ownerUserId !== actor.userId)) throw new NotFoundException();
    if (!["admin", "operator", "reviewer"].includes(actor.role)) throw new NotFoundException();
    return job;
  }
}

@Controller("api")
@UseGuards(SessionGuard, PermissionGuard)
export class EnrichmentJobController {
  constructor(private readonly jobs: EnrichmentJobService) {}

  @Post("imports/:batchId/enrichment-jobs")
  @RequirePermission("enrichment:start", "route-batch")
  start(@Param("batchId") batchId: string, @Body() body: StartBody, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.start(batchId, body, actor);
  }

  @Get("imports/:batchId/enrichment-jobs")
  @RequirePermission("enrichment:read", "route-batch")
  listForBatch(@Param("batchId") batchId: string, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.listForBatch(batchId, actor);
  }

  @Get("enrichment-jobs/:id")
  @RequirePermission("enrichment:read", "route-enrichment-job")
  get(@Param("id") id: string, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.get(id, actor);
  }

  @Get("enrichment-jobs/:id/items")
  @RequirePermission("enrichment:read", "route-enrichment-job")
  listItems(@Param("id") id: string, @Query("cursor") cursor: string | undefined, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.listItems(id, cursor, actor);
  }

  @Post("enrichment-jobs/:id/cancel")
  @RequirePermission("enrichment:cancel", "route-enrichment-job")
  cancel(@Param("id") id: string, @Body() body: unknown, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.cancel(id, body, actor);
  }
}

type ClaimedItem = Readonly<{
  jobId: string; batchId: string; itemId: string; sourceRowId: string; rowNumber: number;
  expectedRowVersion: number; attemptCount: number; nipRaw: string; workerId: string;
}>;

/** Persistent processor. The lookup response exists only in memory and is never copied into the job tables. */
export class RegistryEnrichmentJobRunner {
  private readonly lookup: RegistryLookupService | null;
  private readonly grouping: EntityGroupingService;
  private readonly enrichment: RegistryEnrichmentService;

  constructor(provider: RegistryProvider | null, grouping = new EntityGroupingService()) {
    this.grouping = grouping;
    this.enrichment = new RegistryEnrichmentService(grouping);
    this.lookup = provider ? new RegistryLookupService(provider, { maxConcurrency: 1, timeoutMs: 10_000, maxRetries: 0 }) : null;
  }

  async processOne(workerId = randomUUID()): Promise<boolean> {
    if (!UUID.test(workerId)) throw new Error("ENRICHMENT_WORKER_ID_INVALID");
    const claim = await this.claim(workerId);
    if (!claim) return false;
    if (claim === "skipped") {
      await this.releaseSlot(workerId);
      return true;
    }
    if (!this.lookup) {
      try { await this.finishFailure(claim, "PROVIDER_UNCONFIGURED", false); }
      finally { await this.releaseSlot(workerId).catch(() => undefined); }
      return true;
    }
    try {
      const result = await this.lookup.lookupByNip(claim.nipRaw);
      await sequelize.transaction(async (transaction) => {
        const job = await EnrichmentJob.findByPk(claim.jobId, { transaction, lock: transaction.LOCK.UPDATE });
        const item = await EnrichmentJobItem.findByPk(claim.itemId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!job || !item || job.cancelRequested || job.status === "cancelled" || job.leaseOwner !== claim.workerId
          || item.status !== "processing") return;
        const saved = await this.enrichment.recordResult(claim.batchId, claim.rowNumber, claim.expectedRowVersion, result, transaction);
        item.status = saved.decision.status as EnrichmentJobItemStatus;
        item.auditId = saved.auditId;
        item.reasonCode = "reasonCode" in saved.decision ? saved.decision.reasonCode : null;
        item.errorCode = null;
        item.updatedAt = new Date();
        item.finishedAt = item.updatedAt;
        await item.save({ transaction });
        await updateJobProgress(job, transaction);
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        await this.finishExcluded(claim, error instanceof ConflictException ? "ROW_NO_LONGER_ELIGIBLE" : "ROW_NOT_FOUND");
      } else if (error instanceof RegistryProviderError) {
        await this.finishFailure(claim, error.code, retryableProviderCodes.has(error.code));
      } else {
        await this.finishFailure(claim, "ENRICHMENT_PROCESSING_FAILED", true);
      }
    } finally {
      await this.releaseSlot(workerId).catch(() => undefined);
    }
    return true;
  }

  private async claim(workerId: string): Promise<ClaimedItem | "skipped" | null> {
    return sequelize.transaction(async (transaction) => {
      const now = new Date();
      const slots = await sequelize.query<{ slot_id: number }>(
        `SELECT slot_id FROM enrichment_worker_slots
          WHERE lease_owner = $1 OR lease_expires_at IS NULL OR lease_expires_at <= $2
          ORDER BY CASE WHEN lease_owner = $1 THEN 0 ELSE 1 END, slot_id
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        { bind: [workerId, now], transaction, type: QueryTypes.SELECT },
      );
      if (slots.length === 0) return null;
      await sequelize.query(
        `UPDATE enrichment_worker_slots SET lease_owner = $1, lease_expires_at = $2 WHERE slot_id = $3`,
        { bind: [workerId, new Date(now.getTime() + JOB_LEASE_MS), slots[0].slot_id], transaction },
      );
      const jobs = await sequelize.query<{ job_id: string; batch_id: string }>(
        `SELECT job.job_id, job.batch_id FROM enrichment_jobs AS job
          WHERE job.cancel_requested = FALSE AND job.status IN ('queued', 'processing')
            AND (job.lease_owner = $1 OR job.lease_expires_at IS NULL OR job.lease_expires_at <= $2)
            AND EXISTS (SELECT 1 FROM enrichment_job_items AS item
              WHERE item.job_id = job.job_id AND item.status IN ('pending', 'processing')
                AND (item.next_attempt_at IS NULL OR item.next_attempt_at <= $2))
          ORDER BY CASE WHEN job.lease_owner = $1 THEN 0 ELSE 1 END, job.created_at, job.job_id
          LIMIT 1 FOR UPDATE OF job SKIP LOCKED`,
        { bind: [workerId, now], transaction, type: QueryTypes.SELECT },
      );
      if (jobs.length === 0) {
        await sequelize.query(`UPDATE enrichment_worker_slots SET lease_owner = NULL, lease_expires_at = NULL WHERE slot_id = $1`, { bind: [slots[0].slot_id], transaction });
        return null;
      }
      const job = await EnrichmentJob.findByPk(jobs[0].job_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!job || job.cancelRequested) {
        await sequelize.query(`UPDATE enrichment_worker_slots SET lease_owner = NULL, lease_expires_at = NULL WHERE slot_id = $1`, { bind: [slots[0].slot_id], transaction });
        return null;
      }
      const items = await sequelize.query<{ item_id: string; source_row_id: string; row_number: number; expected_row_version: number; attempt_count: number }>(
        `SELECT item_id, source_row_id, row_number, expected_row_version, attempt_count
           FROM enrichment_job_items
          WHERE job_id = $1 AND status IN ('pending', 'processing') AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
          ORDER BY row_number, item_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        { bind: [job.jobId, now], transaction, type: QueryTypes.SELECT },
      );
      if (items.length === 0) {
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        await job.save({ transaction });
        await sequelize.query(`UPDATE enrichment_worker_slots SET lease_owner = NULL, lease_expires_at = NULL WHERE slot_id = $1`, { bind: [slots[0].slot_id], transaction });
        return null;
      }
      const item = await EnrichmentJobItem.findByPk(items[0].item_id, { transaction, lock: transaction.LOCK.UPDATE });
      const row = await SourceRow.findOne({ where: { id: items[0].source_row_id, batchId: job.batchId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!item || !row) {
        await sequelize.query(`UPDATE enrichment_worker_slots SET lease_owner = NULL, lease_expires_at = NULL WHERE slot_id = $1`, { bind: [slots[0].slot_id], transaction });
        return "skipped";
      }
      let reasonCode: string | null = null;
      if (row.rowVersion !== item.expectedRowVersion) reasonCode = "ROW_VERSION_CHANGED";
      else if (await RegonCorrection.findOne({ where: { sourceRowId: row.id, status: "pending" }, attributes: ["correctionId"], transaction })) reasonCode = "CORRECTION_PENDING";
      else if (await EntityGroupingConflict.findOne({ where: { sourceRowId: row.id, status: "open" }, attributes: ["conflictId"], transaction })) reasonCode = "GROUPING_CONFLICT";
      else if (await hasRun(job.batchId, row.id, transaction)) reasonCode = "RUN_EXISTS";
      else {
        const eligibility = assessRegonEnrichmentEligibility({ regonRaw: row.regonRaw, effectiveRegon: row.effectiveRegon, nipRaw: row.nipRaw });
        if (!eligibility.eligible) reasonCode = reasonForEligibility(eligibility.reasonCode);
      }
      if (reasonCode) {
        item.status = "excluded";
        item.reasonCode = reasonCode;
        item.updatedAt = now;
        item.finishedAt = now;
        await item.save({ transaction });
        await updateJobProgress(job, transaction);
        return "skipped";
      }
      job.leaseOwner = workerId;
      job.leaseExpiresAt = new Date(now.getTime() + JOB_LEASE_MS);
      job.status = "processing";
      job.updatedAt = now;
      await job.save({ transaction });
      item.status = "processing";
      item.attemptCount = Math.min(10, item.attemptCount + 1);
      item.errorCode = null;
      item.updatedAt = now;
      await item.save({ transaction });
      return {
        jobId: job.jobId, batchId: job.batchId, itemId: item.itemId, sourceRowId: row.id,
        rowNumber: row.rowNumber, expectedRowVersion: item.expectedRowVersion,
        attemptCount: item.attemptCount, nipRaw: row.nipRaw, workerId,
      };
    });
  }

  private async finishExcluded(claim: ClaimedItem, reasonCode: string) {
    await sequelize.transaction(async (transaction) => {
      const job = await EnrichmentJob.findByPk(claim.jobId, { transaction, lock: transaction.LOCK.UPDATE });
      const item = await EnrichmentJobItem.findByPk(claim.itemId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!job || !item || job.leaseOwner !== claim.workerId || item.status !== "processing") return;
      const now = new Date();
      item.status = "excluded";
      item.reasonCode = reasonCode;
      item.errorCode = null;
      item.updatedAt = now;
      item.finishedAt = now;
      await item.save({ transaction });
      await updateJobProgress(job, transaction);
    });
  }

  private async finishFailure(claim: ClaimedItem, errorCode: string, retryable: boolean) {
    await sequelize.transaction(async (transaction) => {
      const job = await EnrichmentJob.findByPk(claim.jobId, { transaction, lock: transaction.LOCK.UPDATE });
      const item = await EnrichmentJobItem.findByPk(claim.itemId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!job || !item || job.leaseOwner !== claim.workerId || job.cancelRequested || job.status === "cancelled" || item.status !== "processing") return;
      const now = new Date();
      const shouldRetry = retryable && item.attemptCount < MAX_ATTEMPTS;
      item.errorCode = /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : "ENRICHMENT_PROCESSING_FAILED";
      item.updatedAt = now;
      if (shouldRetry) {
        item.status = "pending";
        item.nextAttemptAt = new Date(now.getTime() + Math.min(30_000, 1_000 * (2 ** (item.attemptCount - 1))));
      } else {
        item.status = "failed";
        item.finishedAt = now;
        job.errorCode ??= item.errorCode;
      }
      await item.save({ transaction });
      await updateJobProgress(job, transaction);
    });
  }

  private async releaseSlot(workerId: string) {
    await sequelize.query(
      `UPDATE enrichment_worker_slots SET lease_owner = NULL, lease_expires_at = NULL WHERE lease_owner = $1`,
      { bind: [workerId] },
    );
  }
}

async function updateJobProgress(job: EnrichmentJob, transaction: Transaction): Promise<void> {
  const rows = await sequelize.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM enrichment_job_items WHERE job_id = $1 GROUP BY status`,
    { bind: [job.jobId], transaction, type: QueryTypes.SELECT },
  );
  const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
  job.completedCount = ["matched", "not_found", "ambiguous", "manual_review"].reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
  job.excludedCount = counts.get("excluded") ?? 0;
  job.failedCount = counts.get("failed") ?? 0;
  job.cancelledCount = counts.get("cancelled") ?? 0;
  const activeCount = (counts.get("pending") ?? 0) + (counts.get("processing") ?? 0);
  const now = new Date();
  job.version += 1;
  job.updatedAt = now;
  if (job.cancelRequested || job.status === "cancelled") {
    job.status = "cancelled";
    job.finishedAt = now;
  } else if (activeCount > 0) {
    job.status = "processing";
    job.finishedAt = null;
  } else {
    job.status = job.failedCount === 0 ? "completed"
      : job.completedCount + job.excludedCount + job.cancelledCount > 0 ? "partial" : "failed";
    job.finishedAt = now;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    await recordAuditEvent({
      tenantId: job.tenantId, actorUserId: job.actorUserId, action: "enrichment.job.completed",
      resourceType: "enrichment_job", resourceId: job.jobId, outcome: job.status === "failed" ? "failed" : "succeeded",
      metadata: { status: job.status, completedCount: job.completedCount, excludedCount: job.excludedCount, failedCount: job.failedCount },
    }, transaction);
  }
  await job.save({ transaction });
}

