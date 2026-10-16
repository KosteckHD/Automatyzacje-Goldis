import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { normalizeBusinessName } from "../../contracts/registry-result";
import type { SourceRow } from "../../infrastructure/database/db";
import { CanonicalRunService, createLeadIdentityKey, isInsideRunWindow, RunDispatchService } from "../runs/public";
import { RunSubmissionAdmissionRepository } from "./run-submission-admission.repository";

@Injectable()
export class RunSubmissionAdmissionService implements OnModuleInit, OnModuleDestroy {
  private readonly dispatcherId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private readonly dispatchWarningTimes = new Map<string, number>();
  private dispatchFailureCount = 0;
  private nextDispatchAttemptAt = 0;

  constructor(
    @Inject(CanonicalRunService) private readonly canonicalRuns: CanonicalRunService,
    @Inject(RunDispatchService) private readonly runDispatch: RunDispatchService,
    @Inject(RunSubmissionAdmissionRepository) private readonly admissionRepository: RunSubmissionAdmissionRepository,
  ) {}

  onModuleInit() {
    void this.dispatchPendingOnce();
    this.timer = setInterval(() => void this.dispatchPendingOnce(), 2_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async admit(groupId: string) {
    const target = await this.admissionRepository.findTarget(groupId, this.dispatcherId);
    if (!target) return;
    const { submission: observedSubmission } = target;
    await this.admissionRepository.withAdmissionTransaction(target, async (base, transaction) => {
      const { settings, actorUser, membership, tool, grant, batch } = base;
      if (!settings || !actorUser || !membership || !tool || !batch) {
        const group = await this.admissionRepository.lockGroup(groupId, transaction);
        if (group?.leaseOwner === this.dispatcherId && !group.runId)
          await this.admissionRepository.defer(group, transaction, "blocked", "CONFIGURATION_MISSING", 0);
        return;
      }
      const groupContext = await this.admissionRepository.findGroupContext(target, transaction);
      const { group, groupItems, linkedRows, rows, canonical } = groupContext;
      if (!group || group.leaseOwner !== this.dispatcherId || group.runId || group.admissionState !== "leased") return;
      if (
        observedSubmission.tenantId !== batch.tenantId ||
        observedSubmission.toolId !== batch.toolId ||
        (observedSubmission.actorUserId !== batch.ownerUserId &&
          membership.role !== "admin" &&
          membership.role !== "manager")
      ) {
        await this.admissionRepository.defer(group, transaction, "blocked", "OWNER_SCOPE_CHANGED", 0);
        return;
      }
      if (
        actorUser.status !== "active" ||
        membership.status !== "active" ||
        (membership.role !== "admin" && membership.role !== "manager" && membership.role !== "operator") ||
        (membership.role !== "admin" && (!grant?.canExecute || tool.status !== "available"))
      ) {
        await this.admissionRepository.defer(group, transaction, "blocked", "EXECUTE_ACCESS_REVOKED", 0);
        return;
      }
      if (!settings.enabledForNewRuns || tool.status === "maintenance") {
        await this.admissionRepository.defer(group, transaction, "waiting_paused", "NEW_RUNS_PAUSED", 60_000);
        return;
      }
      if (tool.status !== "available") {
        await this.admissionRepository.defer(group, transaction, "blocked", "TOOL_UNAVAILABLE", 0);
        return;
      }
      if (!canonical?.regon || groupItems.length === 0) {
        await this.admissionRepository.defer(group, transaction, "blocked", "GROUP_INVALID", 0);
        return;
      }
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const selectedRows = groupItems
        .map((item) => rowById.get(item.sourceRowId))
        .filter((row): row is SourceRow => Boolean(row));
      const stale = groupItems.some((item) => rowById.get(item.sourceRowId)?.rowVersion !== item.expectedRowVersion);
      const memberRows = rows.filter((row) => {
        const link = linkedRows.find((item) => item.sourceRowId === row.id);
        return (
          link?.canonicalEntityId === canonical.canonicalEntityId &&
          createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName) === group.leadIdentityKey
        );
      });
      const { pendingCorrection, openConflict } = await this.admissionRepository.findBlockers(
        selectedRows.map((row) => row.id),
        transaction,
      );
      if (
        stale ||
        selectedRows.length !== groupItems.length ||
        pendingCorrection ||
        openConflict ||
        memberRows.length === 0 ||
        memberRows.some(
          (row) =>
            row.issues.length ||
            row.effectiveRegon !== canonical.regon ||
            normalizeBusinessName(row.companyName) !== normalizeBusinessName(canonical.businessName) ||
            createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName) !== group.leadIdentityKey,
        )
      ) {
        await this.admissionRepository.defer(
          group,
          transaction,
          "blocked",
          stale
            ? "SOURCE_VERSION_CHANGED"
            : pendingCorrection
              ? "PENDING_CORRECTION"
              : openConflict
                ? "OPEN_CONFLICT"
                : "GROUP_REVIEW_REQUIRED",
          0,
        );
        return;
      }
      const existing = await this.admissionRepository.findExistingRun(
        batch.id,
        canonical.canonicalEntityId,
        group.leadIdentityKey,
        transaction,
      );
      if (existing && existing.referenceDate !== observedSubmission.referenceDate) {
        await this.admissionRepository.defer(group, transaction, "blocked", "ACTIVE_RUN_REFERENCE_DATE_MISMATCH", 0);
        return;
      }
      if (!existing) {
        const now = new Date();
        if (!isInsideRunWindow(now, settings.timezone, settings.allowedLocalStart, settings.allowedLocalEnd)) {
          await this.admissionRepository.defer(group, transaction, "waiting_window", "OUTSIDE_RUN_WINDOW", 5 * 60_000);
          return;
        }
        if (settings.maxNewRunsPerHour !== null) {
          const recent = await this.admissionRepository.countRecentRuns(
            observedSubmission.tenantId,
            observedSubmission.toolId,
            new Date(now.getTime() - 60 * 60_000),
            transaction,
          );
          if (recent >= settings.maxNewRunsPerHour) {
            await this.admissionRepository.defer(group, transaction, "waiting_capacity", "HOURLY_RUN_LIMIT", 60_000);
            return;
          }
        }
      }
      const actor = { tenantId: observedSubmission.tenantId, actorUserId: observedSubmission.actorUserId };
      const run = await this.canonicalRuns.createOrGet(
        batch.id,
        canonical.canonicalEntityId,
        group.leadIdentityKey,
        memberRows,
        actor,
        async (queuedRun, tx) => {
          await this.runDispatch.ensureDispatchForAdmission(queuedRun.id, tx);
        },
        { transaction, referenceDate: observedSubmission.referenceDate },
      );
      await this.admissionRepository.accept(group, run.id, actor, observedSubmission.referenceDate, transaction);
    });
  }
  async dispatchPendingOnce() {
    if (this.dispatching || Date.now() < this.nextDispatchAttemptAt) return;
    this.dispatching = true;
    try {
      const groupId = await this.admissionRepository.claim(this.dispatcherId);
      if (groupId) await this.admit(groupId);
      this.dispatchFailureCount = 0;
      this.nextDispatchAttemptAt = 0;
    } catch (error) {
      const now = Date.now();
      this.dispatchFailureCount += 1;
      this.nextDispatchAttemptAt = now + Math.min(30_000, 1_000 * 2 ** Math.min(this.dispatchFailureCount, 5));
      const value = error as { name?: unknown; code?: unknown; parent?: { code?: unknown } } | null;
      const name = typeof value?.name === "string" && /^[A-Za-z]+Error$/.test(value.name) ? value.name : "UnknownError";
      const codeValue = value?.code ?? value?.parent?.code;
      const code = typeof codeValue === "string" && /^[A-Z0-9_]{4,16}$/.test(codeValue) ? codeValue : "UNKNOWN";
      const warningKey = `${name}:${code}`;
      if (now - (this.dispatchWarningTimes.get(warningKey) ?? 0) >= 60_000) {
        this.dispatchWarningTimes.set(warningKey, now);
        console.warn("RUN_SUBMISSION_DISPATCH_FAILED", name, code);
      }
    } finally {
      this.dispatching = false;
    }
  }
}
