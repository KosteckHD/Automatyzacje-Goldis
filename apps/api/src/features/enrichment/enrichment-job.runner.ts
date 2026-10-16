import { randomUUID } from "node:crypto";
import { assessRegonEnrichmentEligibility } from "@goldis/core";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import type { EnrichmentJob, EnrichmentJobItemStatus, ImportBatch } from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit";
import type { SessionPrincipal } from "../auth";
import { EntityGroupingService } from "../grouping/public";
import { EnrichmentJobsRepository } from "./enrichment-jobs.repository";
import { RegistryEnrichmentService } from "./registry-enrichment.service";
import { RegistryLookupService } from "./registry-lookup.service";
import { type RegistryProvider, RegistryProviderError } from "./registry-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const retryableProviderCodes = new Set(["RATE_LIMITED", "UNAVAILABLE", "TIMEOUT"]);
type Actor = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;

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

/** Re-resolve the submitting actor at claim and commit time; session claims are not durable grants. */
async function jobActorCanStillExecute(
  job: EnrichmentJob,
  batch: ImportBatch,
  transaction: Transaction,
  repository: EnrichmentJobsRepository,
): Promise<boolean> {
  if (job.tenantId !== batch.tenantId || !batch.tenantId) return false;
  const [user, membership] = await Promise.all([
    repository.findUserStatusForShare(job.actorUserId, transaction),
    repository.findActiveMembershipForShare(job.tenantId, job.actorUserId, transaction),
  ]);
  if (
    user?.status !== "active" ||
    !membership ||
    (membership.role !== "admin" && membership.role !== "manager" && membership.role !== "operator")
  )
    return false;
  const actor: Actor = { tenantId: job.tenantId, userId: job.actorUserId, role: membership.role };
  try {
    await assertExecuteGrant(batch, actor, transaction, repository);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenException || error instanceof NotFoundException) return false;
    throw error;
  }
}

async function excludeUnauthorizedJob(
  job: EnrichmentJob,
  transaction: Transaction,
  repository: EnrichmentJobsRepository,
): Promise<void> {
  const now = new Date();
  await repository.excludeUnfinishedItems(job.jobId, "EXECUTION_PERMISSION_REVOKED", now, transaction);
  job.errorCode = "EXECUTION_PERMISSION_REVOKED";
  job.leaseOwner = null;
  job.leaseExpiresAt = null;
  await updateJobProgress(job, transaction, repository);
}

type ClaimedItem = Readonly<{
  jobId: string;
  batchId: string;
  itemId: string;
  sourceRowId: string;
  rowNumber: number;
  expectedRowVersion: number;
  attemptCount: number;
  nipRaw: string;
  workerId: string;
}>;

/** Persistent processor. The lookup response exists only in memory and is never copied into the job tables. */
export class RegistryEnrichmentJobRunner {
  private readonly lookup: RegistryLookupService | null;
  private readonly enrichment: RegistryEnrichmentService;

  constructor(
    provider: RegistryProvider | null,
    grouping = new EntityGroupingService(),
    private readonly repository = new EnrichmentJobsRepository(),
  ) {
    this.enrichment = new RegistryEnrichmentService(grouping);
    this.lookup = provider
      ? new RegistryLookupService(provider, { maxConcurrency: 1, timeoutMs: 10_000, maxRetries: 0 })
      : null;
  }

  async processOne(workerId = randomUUID()): Promise<boolean> {
    if (!UUID.test(workerId)) throw new Error("ENRICHMENT_WORKER_ID_INVALID");
    // Disabled mode must not claim or fail queued work. The operator can enable
    // a configured provider later and resume those same items.
    if (!this.lookup) return false;
    const claim = await this.claim(workerId);
    if (!claim) return false;
    if (claim === "skipped") {
      await this.releaseSlot(workerId);
      return true;
    }
    const claims = [claim];
    try {
      if (this.lookup.supportsBatch) claims.push(...(await this.claimAdditional(claim, 29)));
      const outcomes = await this.lookup.lookupManyByNip(claims.map((item) => item.nipRaw));
      for (const itemClaim of claims) {
        try {
          const outcome = outcomes.get(itemClaim.nipRaw.replace(/\D/g, ""));
          if (!outcome) throw new RegistryProviderError("INVALID_RESPONSE", "Registry batch omitted a requested NIP");
          if (outcome.kind === "error") throw outcome.error;
          await this.finishResult(itemClaim, outcome.result);
        } catch (error) {
          if (error instanceof ConflictException || error instanceof NotFoundException) {
            await this.finishExcluded(
              itemClaim,
              error instanceof ConflictException ? "ROW_NO_LONGER_ELIGIBLE" : "ROW_NOT_FOUND",
            );
          } else if (error instanceof RegistryProviderError) {
            await this.finishFailure(
              itemClaim,
              error.code,
              retryableProviderCodes.has(error.code),
              error.retryAfterSeconds,
            );
          } else {
            await this.finishFailure(itemClaim, "ENRICHMENT_PROCESSING_FAILED", true);
          }
        }
      }
    } catch (error) {
      for (const itemClaim of claims) {
        if (error instanceof RegistryProviderError) {
          await this.finishFailure(
            itemClaim,
            error.code,
            retryableProviderCodes.has(error.code),
            error.retryAfterSeconds,
          );
        } else {
          await this.finishFailure(itemClaim, "ENRICHMENT_PROCESSING_FAILED", true);
        }
      }
    } finally {
      await this.releaseSlot(workerId).catch(() => undefined);
    }
    return true;
  }

  private async finishResult(
    claim: ClaimedItem,
    result: Awaited<ReturnType<RegistryLookupService["lookupByNip"]>>,
  ): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      const job = await this.repository.findJobByIdForUpdate(claim.jobId, transaction);
      const item = await this.repository.findItemByIdForUpdate(claim.itemId, transaction);
      if (
        !job ||
        !item ||
        job.cancelRequested ||
        job.status === "cancelled" ||
        job.leaseOwner !== claim.workerId ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt.getTime() <= Date.now() ||
        item.status !== "processing"
      )
        return;
      // This writer later locks the same batch for update while regrouping.
      // Acquire that lock before permission rows to avoid a SHARE→UPDATE
      // upgrade deadlock when workers finish different rows in one import.
      const batch = await this.repository.findBatchByTenantForUpdate(job.batchId, job.tenantId, transaction);
      if (!batch || !(await jobActorCanStillExecute(job, batch, transaction, this.repository))) {
        await excludeUnauthorizedJob(job, transaction, this.repository);
        return;
      }
      const saved = await this.enrichment.recordResult(
        claim.batchId,
        claim.rowNumber,
        claim.expectedRowVersion,
        result,
        transaction,
      );
      item.status = saved.decision.status as EnrichmentJobItemStatus;
      item.auditId = saved.auditId;
      item.reasonCode = "reasonCode" in saved.decision ? saved.decision.reasonCode : null;
      item.errorCode = null;
      item.updatedAt = new Date();
      item.finishedAt = item.updatedAt;
      await this.repository.saveItem(item, transaction);
      await updateJobProgress(job, transaction, this.repository);
    });
  }

  private async claimAdditional(first: ClaimedItem, maximum: number): Promise<ClaimedItem[]> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 29) throw new Error("ENRICHMENT_BATCH_SIZE_INVALID");
    return this.repository.transaction(async (transaction) => {
      const now = new Date();
      const job = await this.repository.findJobByIdForUpdate(first.jobId, transaction);
      if (
        !job ||
        job.cancelRequested ||
        job.status === "cancelled" ||
        job.leaseOwner !== first.workerId ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt.getTime() <= now.getTime()
      )
        return [];
      const batch = await this.repository.findBatchByTenantForShare(job.batchId, job.tenantId, transaction);
      if (!batch || !(await jobActorCanStillExecute(job, batch, transaction, this.repository))) {
        await excludeUnauthorizedJob(job, transaction, this.repository);
        return [];
      }
      const rows = await this.repository.findAdditionalClaimCandidates({
        jobId: job.jobId,
        excludeItemId: first.itemId,
        now,
        maximum,
        transaction,
      });
      const claims: ClaimedItem[] = [];
      for (const candidate of rows) {
        const item = await this.repository.findItemByIdForUpdate(candidate.item_id, transaction);
        const row = await this.repository.findSourceRowForUpdate(job.batchId, candidate.source_row_id, transaction);
        if (!item || !row || item.status !== "pending" || job.cancelRequested || job.leaseOwner !== first.workerId)
          continue;
        let reasonCode: string | null = null;
        if (row.rowVersion !== item.expectedRowVersion) reasonCode = "ROW_VERSION_CHANGED";
        else if (await this.repository.findPendingCorrection(row.id, transaction)) reasonCode = "CORRECTION_PENDING";
        else if (await this.repository.findOpenGroupingConflict(row.id, transaction)) reasonCode = "GROUPING_CONFLICT";
        else if (await this.repository.hasRunForSourceRow(job.batchId, row.id, transaction)) reasonCode = "RUN_EXISTS";
        else {
          const eligibility = assessRegonEnrichmentEligibility({
            regonRaw: row.regonRaw,
            effectiveRegon: row.effectiveRegon,
            nipRaw: row.nipRaw,
          });
          if (!eligibility.eligible) reasonCode = reasonForEligibility(eligibility.reasonCode);
        }
        if (reasonCode) {
          item.status = "excluded";
          item.reasonCode = reasonCode;
          item.updatedAt = now;
          item.finishedAt = now;
          await this.repository.saveItem(item, transaction);
          await updateJobProgress(job, transaction, this.repository);
          continue;
        }
        item.status = "processing";
        item.attemptCount = Math.min(10, item.attemptCount + 1);
        item.errorCode = null;
        item.updatedAt = now;
        await this.repository.saveItem(item, transaction);
        claims.push({
          jobId: job.jobId,
          batchId: job.batchId,
          itemId: item.itemId,
          sourceRowId: row.id,
          rowNumber: row.rowNumber,
          expectedRowVersion: item.expectedRowVersion,
          attemptCount: item.attemptCount,
          nipRaw: row.nipRaw,
          workerId: first.workerId,
        });
      }
      if (claims.length > 0) {
        job.leaseExpiresAt = new Date(now.getTime() + JOB_LEASE_MS);
        job.updatedAt = now;
        await this.repository.saveJob(job, transaction);
      }
      return claims;
    });
  }

  private async claim(workerId: string): Promise<ClaimedItem | "skipped" | null> {
    return this.repository.transaction(async (transaction) => {
      const now = new Date();
      const slots = await this.repository.findAvailableWorkerSlot(workerId, now, transaction);
      if (slots.length === 0) return null;
      await this.repository.setWorkerSlotLease(
        slots[0].slot_id,
        workerId,
        new Date(now.getTime() + JOB_LEASE_MS),
        transaction,
      );
      const jobs = await this.repository.findClaimableJob(workerId, now, transaction);
      if (jobs.length === 0) {
        await this.repository.clearWorkerSlotLease(slots[0].slot_id, transaction);
        return null;
      }
      const job = await this.repository.findJobByIdForUpdate(jobs[0].job_id, transaction);
      if (!job || job.cancelRequested) {
        await this.repository.clearWorkerSlotLease(slots[0].slot_id, transaction);
        return null;
      }
      const batch = await this.repository.findBatchByTenantForShare(job.batchId, job.tenantId, transaction);
      if (!batch || !(await jobActorCanStillExecute(job, batch, transaction, this.repository))) {
        await excludeUnauthorizedJob(job, transaction, this.repository);
        await this.repository.clearWorkerSlotLease(slots[0].slot_id, transaction);
        return null;
      }
      const items = await this.repository.findFirstClaimableItem(job.jobId, now, transaction);
      if (items.length === 0) {
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        await this.repository.saveJob(job, transaction);
        await this.repository.clearWorkerSlotLease(slots[0].slot_id, transaction);
        return null;
      }
      const item = await this.repository.findItemByIdForUpdate(items[0].item_id, transaction);
      const row = await this.repository.findSourceRowForUpdate(job.batchId, items[0].source_row_id, transaction);
      if (!item || !row) {
        await this.repository.clearWorkerSlotLease(slots[0].slot_id, transaction);
        return "skipped";
      }
      let reasonCode: string | null = null;
      if (row.rowVersion !== item.expectedRowVersion) reasonCode = "ROW_VERSION_CHANGED";
      else if (await this.repository.findPendingCorrection(row.id, transaction)) reasonCode = "CORRECTION_PENDING";
      else if (await this.repository.findOpenGroupingConflict(row.id, transaction)) reasonCode = "GROUPING_CONFLICT";
      else if (await this.repository.hasRunForSourceRow(job.batchId, row.id, transaction)) reasonCode = "RUN_EXISTS";
      else {
        const eligibility = assessRegonEnrichmentEligibility({
          regonRaw: row.regonRaw,
          effectiveRegon: row.effectiveRegon,
          nipRaw: row.nipRaw,
        });
        if (!eligibility.eligible) reasonCode = reasonForEligibility(eligibility.reasonCode);
      }
      if (reasonCode) {
        item.status = "excluded";
        item.reasonCode = reasonCode;
        item.updatedAt = now;
        item.finishedAt = now;
        await this.repository.saveItem(item, transaction);
        await updateJobProgress(job, transaction, this.repository);
        return "skipped";
      }
      job.leaseOwner = workerId;
      job.leaseExpiresAt = new Date(now.getTime() + JOB_LEASE_MS);
      job.status = "processing";
      job.updatedAt = now;
      await this.repository.saveJob(job, transaction);
      item.status = "processing";
      item.attemptCount = Math.min(10, item.attemptCount + 1);
      item.errorCode = null;
      item.updatedAt = now;
      await this.repository.saveItem(item, transaction);
      return {
        jobId: job.jobId,
        batchId: job.batchId,
        itemId: item.itemId,
        sourceRowId: row.id,
        rowNumber: row.rowNumber,
        expectedRowVersion: item.expectedRowVersion,
        attemptCount: item.attemptCount,
        nipRaw: row.nipRaw,
        workerId,
      };
    });
  }

  private async finishExcluded(claim: ClaimedItem, reasonCode: string) {
    await this.repository.transaction(async (transaction) => {
      const job = await this.repository.findJobByIdForUpdate(claim.jobId, transaction);
      const item = await this.repository.findItemByIdForUpdate(claim.itemId, transaction);
      if (
        !job ||
        !item ||
        job.leaseOwner !== claim.workerId ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt.getTime() <= Date.now() ||
        item.status !== "processing"
      )
        return;
      const now = new Date();
      item.status = "excluded";
      item.reasonCode = reasonCode;
      item.errorCode = null;
      item.updatedAt = now;
      item.finishedAt = now;
      await this.repository.saveItem(item, transaction);
      await updateJobProgress(job, transaction, this.repository);
    });
  }

  private async finishFailure(
    claim: ClaimedItem,
    errorCode: string,
    retryable: boolean,
    retryAfterSeconds: number | null = null,
  ) {
    await this.repository.transaction(async (transaction) => {
      const job = await this.repository.findJobByIdForUpdate(claim.jobId, transaction);
      const item = await this.repository.findItemByIdForUpdate(claim.itemId, transaction);
      if (
        !job ||
        !item ||
        job.leaseOwner !== claim.workerId ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt.getTime() <= Date.now() ||
        job.cancelRequested ||
        job.status === "cancelled" ||
        item.status !== "processing"
      )
        return;
      const batch = await this.repository.findBatchByTenantForUpdate(job.batchId, job.tenantId, transaction);
      if (!batch || !(await jobActorCanStillExecute(job, batch, transaction, this.repository))) {
        await excludeUnauthorizedJob(job, transaction, this.repository);
        return;
      }
      const now = new Date();
      const shouldRetry = retryable && (errorCode === "RATE_LIMITED" || item.attemptCount < MAX_ATTEMPTS);
      item.errorCode = /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : "ENRICHMENT_PROCESSING_FAILED";
      item.updatedAt = now;
      if (shouldRetry) {
        item.status = "pending";
        const backoffMs = Math.min(30_000, 1_000 * 2 ** (item.attemptCount - 1));
        const providerDelayMs = retryAfterSeconds === null ? 0 : retryAfterSeconds * 1_000;
        item.nextAttemptAt = new Date(now.getTime() + Math.max(backoffMs, providerDelayMs));
      } else {
        item.status = "failed";
        item.finishedAt = now;
        job.errorCode ??= item.errorCode;
      }
      await this.repository.saveItem(item, transaction);
      await updateJobProgress(job, transaction, this.repository);
    });
  }

  private async releaseSlot(workerId: string) {
    await this.repository.clearWorkerSlots(workerId);
  }
}

async function updateJobProgress(
  job: EnrichmentJob,
  transaction: Transaction,
  repository: EnrichmentJobsRepository,
): Promise<void> {
  const rows = await repository.countJobItemsByStatus(job.jobId, transaction);
  const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
  job.completedCount = ["matched", "not_found", "ambiguous", "manual_review"].reduce(
    (sum, status) => sum + (counts.get(status) ?? 0),
    0,
  );
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
    job.status =
      job.failedCount === 0
        ? "completed"
        : job.completedCount + job.excludedCount + job.cancelledCount > 0
          ? "partial"
          : "failed";
    job.finishedAt = now;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    await recordAuditEvent(
      {
        tenantId: job.tenantId,
        actorUserId: job.actorUserId,
        action: "enrichment.job.completed",
        resourceType: "enrichment_job",
        resourceId: job.jobId,
        outcome: job.status === "failed" ? "failed" : "succeeded",
        metadata: {
          status: job.status,
          completedCount: job.completedCount,
          excludedCount: job.excludedCount,
          failedCount: job.failedCount,
        },
      },
      transaction,
    );
  }
  await repository.saveJob(job, transaction);
}
