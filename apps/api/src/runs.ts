import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Op } from "sequelize";
import type { Request, Response } from "express";
import { ArtifactDownloadError, getVerifiedArtifactDownload } from "./artifact-download";
import { artifactDownloadHeaders } from "./artifact-download-headers";
import { AuthChallenge, AutomationRun, CanonicalEntity, ExportArtifact, InterventionActivity, ManualIntervention, OcPolicyRecord, OcSnapshot, RunDispatchOutbox, RunEvent, RunManualDataOverride, sequelize, SourceRow } from "./db";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "./session";
import { createRunJob } from "./run-queue";
import { WorkerCodeForwarder } from "./auth-challenges";
import { EntityGroupingService } from "./entity-grouping-service";
import { CanonicalRunService, createLeadIdentityKey } from "./canonical-run-service";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { recordAuditEvent, type AuditActorContext } from "./audit";
import { canResumeManualIntervention } from "./manual-data";
import { canRetrySms } from "./sms-retry-policy";

const queueName = "oc-verification";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redisConnection() {
  const value = process.env.REDIS_URL;
  if (!value) throw new Error("REDIS_URL is required");
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis: or rediss:");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: 1,
  };
}

@Injectable()
export class RunService implements OnModuleInit, OnModuleDestroy {
  private readonly queue = new Queue<{ runId: string }>(queueName, { connection: redisConnection() });
  private timer: NodeJS.Timeout | null = null;
  private readonly dispatcherId = randomUUID();

  constructor(
    private readonly codeForwarder: WorkerCodeForwarder,
    private readonly entityGrouping: EntityGroupingService,
    private readonly canonicalRuns: CanonicalRunService,
  ) {}

  onModuleInit() {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 5_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.queue.close();
  }

  private async ensureDispatch(runId: string, intentType: "create" | "resume_auth" | "resume_review" | "recovery" | "result_delivery", transaction: import("sequelize").Transaction) {
    const unresolved = await RunDispatchOutbox.findOne({
      where: { runId, status: ["pending", "publishing", "published"] }, transaction, lock: transaction.LOCK.UPDATE,
    });
    if (unresolved) return unresolved;
    const now = new Date();
    return RunDispatchOutbox.create({
      dispatchId: randomUUID(), runId, intentType, status: "pending", attemptCount: 0,
      nextAttemptAt: now, claimedAt: null, claimedBy: null, lastErrorCode: null,
      createdAt: now, updatedAt: now,
    }, { transaction });
  }

  private async publishOutbox() {
    const now = new Date();
    const staleClaim = new Date(now.getTime() - 30_000);
    const claimed = await sequelize.transaction(async (transaction) => {
      const rows = await RunDispatchOutbox.findAll({
        where: { [Op.or]: [
          { status: "pending", nextAttemptAt: { [Op.lte]: now } },
          { status: "publishing", claimedAt: { [Op.lte]: staleClaim } },
        ] },
        order: [["createdAt", "ASC"], ["dispatchId", "ASC"]], limit: 50,
        transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
      });
      for (const dispatch of rows) {
        dispatch.status = "publishing";
        dispatch.attemptCount += 1;
        dispatch.claimedAt = now;
        dispatch.claimedBy = this.dispatcherId;
        dispatch.updatedAt = now;
        await dispatch.save({ transaction });
      }
      return rows.map((dispatch) => ({ dispatchId: dispatch.dispatchId, runId: dispatch.runId, attemptCount: dispatch.attemptCount }));
    });
    for (const dispatch of claimed) {
      try {
        const job = createRunJob(dispatch.runId, dispatch.dispatchId);
        await this.queue.add(job.name, job.data, job.options);
        await RunDispatchOutbox.update({ status: "published", claimedAt: null, claimedBy: null, lastErrorCode: null, updatedAt: new Date() }, {
          where: { dispatchId: dispatch.dispatchId, status: "publishing", claimedBy: this.dispatcherId },
        });
      } catch {
        const delays = [5_000, 15_000, 60_000];
        const delay = delays[Math.min(dispatch.attemptCount - 1, delays.length - 1)];
        await RunDispatchOutbox.update({
          status: "pending", claimedAt: null, claimedBy: null, lastErrorCode: "QUEUE_PUBLISH_FAILED",
          nextAttemptAt: new Date(Date.now() + delay), updatedAt: new Date(),
        }, { where: { dispatchId: dispatch.dispatchId, status: "publishing", claimedBy: this.dispatcherId } }).catch(() => undefined);
      }
    }
  }

  private async recoverPublishedOutbox() {
    const staleBefore = new Date(Date.now() - 60_000);
    const published = await RunDispatchOutbox.findAll({
      where: { status: "published", updatedAt: { [Op.lte]: staleBefore } }, order: [["updatedAt", "ASC"]], limit: 50,
    });
    for (const dispatch of published) {
      const jobId = createRunJob(dispatch.runId, dispatch.dispatchId).options.jobId;
      const job = await this.queue.getJob(jobId);
      const state = job ? await job.getState().catch(() => "unknown") : "missing";
      if (job && !["completed", "failed"].includes(state)) continue;
      const retry = await sequelize.transaction(async (transaction) => {
        const current = await RunDispatchOutbox.findByPk(dispatch.dispatchId, { transaction, lock: transaction.LOCK.UPDATE });
        const run = await AutomationRun.findByPk(dispatch.runId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!current || current.status !== "published" || !run) return false;
        if (run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now()) return false;
        if (["completed", "cancelled", "failed", "no_matching_policies", "identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(run.status)) {
          current.status = "consumed";
          current.updatedAt = new Date();
          await current.save({ transaction });
          return false;
        }
        current.status = "pending";
        current.nextAttemptAt = new Date();
        current.claimedAt = null;
        current.claimedBy = null;
        current.updatedAt = new Date();
        await current.save({ transaction });
        return true;
      });
      if (retry && job) await job.remove().catch(() => undefined);
    }
  }

  private async ensureResultDispatches() {
    await sequelize.transaction(async (transaction) => {
      const runs = await AutomationRun.findAll({
        where: {
          status: ["reading_oc", "export_ready"],
          [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: new Date() } }],
        }, order: [["updatedAt", "ASC"]], limit: 100,
        transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
      });
      for (const run of runs) await this.ensureDispatch(run.id, "result_delivery", transaction);
    });
  }

  /** Recovers only checkpoints whose next operation is safe to repeat or result-only. */
  private async recoverOrphanRuns() {
    const now = new Date();
    const candidates = await AutomationRun.findAll({
      where: {
        status: ["queued", "validating", "pzu_login", "everest_search", "compensa_login", "compensa_form", "ufg_verification", "reading_oc", "export_ready"],
        [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: now } }],
      },
      order: [["updatedAt", "ASC"]], limit: 50,
    });
    for (const candidate of candidates) {
      await sequelize.transaction(async (transaction) => {
        const run = await AutomationRun.findByPk(candidate.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!run || !["queued", "validating", "pzu_login", "everest_search", "compensa_login", "compensa_form", "ufg_verification", "reading_oc", "export_ready"].includes(run.status)
          || (run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now())) return;
        const dispatch = await RunDispatchOutbox.findOne({
          where: { runId: run.id, status: ["pending", "publishing", "published"] }, transaction, lock: transaction.LOCK.UPDATE,
        });
        if (dispatch) return;
        const incident = await ManualIntervention.findOne({
          where: { runId: run.id, status: "open" }, transaction, lock: transaction.LOCK.UPDATE,
        });
        if (incident) return;
        const count = Number(run.technicalAttemptCount ?? 0);
        if (count >= 2) {
          run.status = "waiting_for_manual_data";
          run.currentStep = "waiting_for_manual_data";
          run.errorCode = "PORTAL_FAILURE";
          run.updatedAt = now;
          await run.save({ transaction });
          await ManualIntervention.create({
            interventionId: randomUUID(), runId: run.id, challengeId: null, portal: null, kind: "portal_error",
            status: "open", reasonCode: "PORTAL_FAILURE", createdAt: now, resolvedAt: null, resolvedBy: null,
          }, { transaction });
          await RunEvent.create({
            runId: run.id, status: run.status, step: "operator_review_required", errorCode: "PORTAL_FAILURE",
            actorId: null, metadata: { source: "lease_recovery", attempts: count }, createdAt: now,
          }, { transaction });
          return;
        }
        const intent = run.status === "reading_oc" || run.status === "export_ready" ? "result_delivery" : "recovery";
        run.technicalCycleId ??= randomUUID();
        run.technicalAttemptCount = count + 1;
        run.updatedAt = now;
        await run.save({ transaction });
        const delay = count === 0 ? 5_000 : 15_000;
        const next = new Date(Date.now() + delay);
        await RunDispatchOutbox.create({
          dispatchId: randomUUID(), runId: run.id, intentType: intent, status: "pending", attemptCount: 0,
          nextAttemptAt: next, claimedAt: null, claimedBy: null, lastErrorCode: null, createdAt: now, updatedAt: now,
        }, { transaction });
        await RunEvent.create({
          runId: run.id, status: run.status, step: "lease_recovery_scheduled", errorCode: null,
          actorId: null, metadata: { intent, delaySeconds: delay / 1000, attempt: count + 1 }, createdAt: now,
        }, { transaction });
      });
    }
  }

  private async reconcile() {
    try {
      await this.ensureResultDispatches();
      await this.recoverPublishedOutbox();
      await this.recoverOrphanRuns();
      await this.publishOutbox();
    } catch {
      // The next interval retries. Do not include row data or Redis errors in logs.
      console.warn("RUN_QUEUE_RECONCILE_FAILED");
    }
  }

  async create(batchId: string, rowNumber: number, actor: AuditActorContext) {
    if (!uuidPattern.test(batchId) || !Number.isInteger(rowNumber) || rowNumber < 2) throw new BadRequestException("Nieprawidłowy import lub numer wiersza");
    const initial = await SourceRow.findOne({ where: { batchId, rowNumber } });
    if (!initial) throw new NotFoundException("Nie znaleziono wiersza");
    const grouping = await this.entityGrouping.resolveRelatedRows(batchId, rowNumber);
    const groupConflicts = grouping.filter((result) => result.status === "conflict");
    if (groupConflicts.length) throw new ConflictException("Rekordy powiązane wymagają rozstrzygnięcia przed uruchomieniem");
    const linkedGrouping = grouping.filter((result) => result.status === "linked");
    const selectedGroup = linkedGrouping.find((result) => result.rowNumber === rowNumber);
    if (!selectedGroup) throw new ConflictException("Nie udało się przypisać wiersza do grupy podmiotu");

    const canonical = await CanonicalEntity.findByPk(selectedGroup.canonicalEntityId);
    if (!canonical) throw new ConflictException("Brak grupy kanonicznej dla wiersza");
    const linkedIds = linkedGrouping.filter((result) => result.canonicalEntityId === canonical.canonicalEntityId)
      .map((result) => result.sourceRowId);
    const linkedRows = await SourceRow.findAll({ where: { id: linkedIds, batchId }, order: [["rowNumber", "ASC"]] });
    const leadIdentityKey = createLeadIdentityKey(canonical.canonicalEntityId, initial.decisionMakerName);
    const members = linkedRows.filter((row) => createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName) === leadIdentityKey);
    if (!members.some((row) => row.id === initial.id)) throw new ConflictException("Wiersz nie należy do uruchamianej grupy osoby");
    if (!canonical.regon || members.some((row) => !row.effectiveRegon || row.effectiveRegon !== canonical.regon || row.issues.length > 0)) {
      throw new BadRequestException("Wszystkie wiersze grupy muszą mieć zgodny, sprawdzony REGON i komplet wymaganych danych");
    }

    const legacyActiveRun = await AutomationRun.findOne({
      where: {
        sourceRowId: members.map((row) => row.id),
        canonicalEntityId: null,
        status: { [Op.notIn]: ["completed", "failed", "no_matching_policies", "cancelled"] },
      },
    });
    if (legacyActiveRun) throw new ConflictException("Wiersz ma już aktywne zadanie ze starszej wersji systemu");

    const run = await this.canonicalRuns.createOrGet(batchId, canonical.canonicalEntityId, leadIdentityKey, members, actor,
      async (queuedRun, transaction) => { await this.ensureDispatch(queuedRun.id, "create", transaction); });
    void this.publishOutbox();
    return this.summary(run);
  }

  async list(batchId: string) {
    if (!uuidPattern.test(batchId)) throw new BadRequestException("Nieprawidłowy identyfikator importu");
    return (await AutomationRun.findAll({ where: { batchId }, order: [["createdAt", "DESC"]], limit: 50 })).map((run) => this.summary(run));
  }

  async get(id: string, role: string | null = null) {
    if (!uuidPattern.test(id)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    const run = await AutomationRun.findByPk(id);
    if (!run) throw new NotFoundException("Nie znaleziono zadania");
    const snapshot = await OcSnapshot.findByPk(id);
    const currentOcCount = snapshot ? await OcPolicyRecord.count({
      where: { runId: id, coverageTo: { [Op.gte]: run.referenceDate } },
    }) : null;
    const events = await RunEvent.findAll({ where: { runId: id }, order: [["createdAt", "ASC"], ["id", "ASC"]] });
    const incident = ["identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(run.status)
      ? await ManualIntervention.findOne({ where: { runId: id, status: "open" }, order: [["createdAt", "DESC"]] }) : null;
    const manualOverride = run.manualDataVersion > 0 ? await RunManualDataOverride.findOne({ where: { runId: id, version: run.manualDataVersion } }) : null;
    const canResumeAuth = incident?.kind === "sms" && ["admin", "operator"].includes(role ?? "")
      && canRetrySms({ status: run.status, errorCode: run.errorCode, reasonCode: incident.reasonCode,
        portal: incident.portal, retryCount: run.pzuSmsRetryCount });
    const artifact = run.status === "completed" ? await ExportArtifact.findOne({ where: { runId: id, state: "ready" } }) : null;
    return {
      ...this.summary(run),
      policyCounts: snapshot ? { totalOcCount: snapshot.totalCount, currentOcCount } : null,
      artifactAvailable: Boolean(artifact && artifact.policyCount > 0),
      incident: incident ? { kind: incident.kind, portal: incident.portal, reasonCode: incident.reasonCode,
        fieldCode: incident.fieldCode, createdAt: incident.createdAt, retryAllowed: canResumeAuth, canResumeAuth,
        canResumeReview: canResumeManualIntervention({
          role: role ?? "", runStatus: run.status, fieldCode: incident.fieldCode, lastSafeStep: run.lastSafeStep,
          externalCaseRef: run.externalCaseRef, manualDataVersion: run.manualDataVersion,
          overrideVersion: manualOverride?.version ?? null, fields: manualOverride?.fields ?? null,
        }) } : null,
      events: events.map((event) => ({ status: event.status, step: event.step, errorCode: event.errorCode, createdAt: event.createdAt })),
    };
  }

  async downloadArtifact(id: string) {
    return getVerifiedArtifactDownload(id);
  }

  async resumeAuth(id: string, actor: AuditActorContext) {
    if (!uuidPattern.test(id)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    let invalidatedChallengeId: string | null = null;
    const run = await sequelize.transaction(async (transaction) => {
      const current = await AutomationRun.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current) throw new NotFoundException("Nie znaleziono zadania");
      const incident = await ManualIntervention.findOne({
        where: { runId: id, kind: "sms", status: "open" }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!incident || !canRetrySms({ status: current.status, errorCode: current.errorCode,
        reasonCode: incident.reasonCode, portal: incident.portal, retryCount: current.pzuSmsRetryCount })) {
        throw new ConflictException("Zadanie nie pozwala na dodatkowy SMS albo limit został wykorzystany");
      }
      if (incident.portal === "pzu") {
        if (current.pzuSmsRetryCount >= 1) throw new ConflictException("Limit dodatkowego SMS PZU został wykorzystany");
        current.pzuSmsRetryCount += 1;
      }
      const active = await AuthChallenge.findOne({
        where: { runId: id, status: ["active", "claimed", "submitted"] }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (active) {
        if (current.status !== "waiting_for_sms" || current.errorCode !== "SMS_CODE_REJECTED"
          || active.status !== "active" || active.challengeId !== current.currentAuthChallengeId
          || active.challengeId !== incident.challengeId) throw new ConflictException("Kod SMS jest już przekazywany albo stan zgłoszenia się zmienił");
        active.status = "expired";
        active.updatedAt = new Date();
        await active.save({ transaction });
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
      await current.save({ transaction });
      incident.status = "resolved";
      incident.resolvedAt = now;
      incident.resolvedBy = actor.actorUserId;
      incident.updatedAt = now;
      incident.revision += 1;
      await incident.save({ transaction });
      await InterventionActivity.create({
        activityId: randomUUID(), interventionId: incident.interventionId, actorUserId: actor.actorUserId,
        eventType: "resolved", previousAssigneeUserId: incident.assigneeUserId, nextAssigneeUserId: incident.assigneeUserId,
        priority: incident.priority, createdAt: now,
      }, { transaction });
      await this.ensureDispatch(id, "resume_auth", transaction);
      await RunEvent.create({
        runId: id, status: next, step: "auth_retry_queued", errorCode: null,
        actorId: actor.actorUserId, metadata: { portal: incident.portal, pzuRetryCount: current.pzuSmsRetryCount }, createdAt: now,
      }, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.actorUserId,
        action: "run.auth_resumed", resourceType: "run", resourceId: id, outcome: "succeeded",
      }, transaction);
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.actorUserId,
        action: "intervention.resolved", resourceType: "intervention", resourceId: incident.interventionId, outcome: "succeeded",
      }, transaction);
      return current;
    });
    if (invalidatedChallengeId) await this.codeForwarder.invalidate(invalidatedChallengeId);
    void this.publishOutbox();
    return this.summary(run);
  }

  async resumeReview(id: string, actor: AuditActorContext) {
    if (!uuidPattern.test(id)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    const run = await sequelize.transaction(async (transaction) => {
      const current = await AutomationRun.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current) throw new NotFoundException("Nie znaleziono zadania");
      if (current.status !== "waiting_for_manual_data" && current.status !== "identity_review") {
        throw new ConflictException("Zadanie nie oczekuje na rozwiązanie zgłoszenia");
      }
      const incident = await ManualIntervention.findOne({
        where: { runId: id, status: "open" }, order: [["createdAt", "DESC"]], transaction, lock: transaction.LOCK.UPDATE,
      });
      const override = current.manualDataVersion > 0 ? await RunManualDataOverride.findOne({
        where: { runId: id, version: current.manualDataVersion }, transaction,
      }) : null;
      if (!incident || !canResumeManualIntervention({
        role: "admin", runStatus: current.status, fieldCode: incident.fieldCode, lastSafeStep: current.lastSafeStep,
        externalCaseRef: current.externalCaseRef, manualDataVersion: current.manualDataVersion,
        overrideVersion: override?.version ?? null, fields: override?.fields ?? null,
      })) {
        throw new ConflictException("Zgłoszenie wymaga poprawki do wskazanego pola albo uzgodnienia sprawy; wznowienie bez tego kroku jest zablokowane");
      }
      const now = new Date();
      const next = incident.fieldCode === "EXPECTED_PERSON" ? "everest_search"
        : incident.portal === "pzu" ? "pzu_login" : "compensa_login";
      if (incident.fieldCode === "EXPECTED_PERSON" && (current.lastSafeStep || current.externalCaseRef)) {
        throw new ConflictException("Nie można zmienić osoby po rozpoczęciu oferty");
      }
      current.status = next;
      current.currentStep = next;
      current.errorCode = "REVIEW_RETRY_QUEUED";
      await current.save({ transaction });
      incident.status = "resolved";
      incident.resolvedAt = now;
      incident.resolvedBy = actor.actorUserId;
      incident.updatedAt = now;
      incident.revision += 1;
      await incident.save({ transaction });
      await InterventionActivity.create({
        activityId: randomUUID(), interventionId: incident.interventionId, actorUserId: actor.actorUserId,
        eventType: "resolved", previousAssigneeUserId: incident.assigneeUserId, nextAssigneeUserId: incident.assigneeUserId,
        priority: incident.priority, createdAt: now,
      }, { transaction });
      await this.ensureDispatch(id, "resume_review", transaction);
      await RunEvent.create({
        runId: id, status: next, step: "manual_review_resumed", errorCode: null, actorId: actor.actorUserId,
        metadata: { fieldCode: incident.fieldCode, manualDataVersion: current.manualDataVersion }, createdAt: now,
      }, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.actorUserId,
        action: "run.review_resumed", resourceType: "run", resourceId: id, outcome: "succeeded",
      }, transaction);
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.actorUserId,
        action: "intervention.resolved", resourceType: "intervention", resourceId: incident.interventionId, outcome: "succeeded",
      }, transaction);
      return current;
    });
    void this.publishOutbox();
    return this.summary(run);
  }

  async cancel(id: string, actor: AuditActorContext) {
    if (!uuidPattern.test(id)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    const cancellation = await sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new NotFoundException("Nie znaleziono zadania");
      if (run.status === "cancelled") return { summary: this.summary(run), challengeId: null as string | null };
      if (run.status !== "queued" && run.status !== "awaiting_portal_adapter" && run.status !== "waiting_for_sms") {
        throw new ConflictException("Nie można anulować zadania w tym kroku");
      }
      let challengeId: string | null = null;
      if (run.status === "waiting_for_sms") {
        const challenge = run.currentAuthChallengeId
          ? await AuthChallenge.findByPk(run.currentAuthChallengeId, { transaction, lock: transaction.LOCK.UPDATE })
          : null;
        if (challenge && challenge.runId === run.id && ["active", "claimed", "submitted"].includes(challenge.status)) {
          challenge.status = "invalidated";
          challenge.updatedAt = new Date();
          await challenge.save({ transaction });
          challengeId = challenge.challengeId;
          await ManualIntervention.update({
            status: "cancelled", resolvedAt: challenge.updatedAt, reasonCode: "RUN_CANCELLED",
            updatedAt: challenge.updatedAt, revision: sequelize.literal("revision + 1"),
          }, {
            where: { challengeId, status: "open" }, transaction,
          });
        }
      }
      const now = new Date();
      run.status = "cancelled";
      run.currentStep = "cancelled";
      run.finishedAt = now;
      await run.save({ transaction });
      await RunDispatchOutbox.update({ status: "cancelled", claimedAt: null, claimedBy: null, updatedAt: now }, {
        where: { runId: run.id, status: ["pending", "publishing", "published"] }, transaction,
      });
      await RunEvent.create({
        runId: run.id, status: "cancelled", step: "cancelled", errorCode: null,
        metadata: challengeId ? { challengeId, reason: "operator_cancelled_during_sms" } : {}, createdAt: now,
      }, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.actorUserId,
        action: "run.cancelled", resourceType: "run", resourceId: run.id, outcome: "succeeded",
      }, transaction);
      return { summary: this.summary(run), challengeId };
    });
    if (cancellation.challengeId) await this.codeForwarder.invalidate(cancellation.challengeId);
    return cancellation.summary;
  }

  private summary(run: AutomationRun) {
    return { id: run.id, batchId: run.batchId, rowNumber: run.rowNumber, toolId: run.toolId, status: run.status, currentStep: run.currentStep, referenceDate: run.referenceDate, errorCode: run.errorCode, manualDataVersion: run.manualDataVersion, createdAt: run.createdAt, updatedAt: run.updatedAt };
  }
}

@Controller("runs")
@UseGuards(SessionGuard, PermissionGuard)
export class RunController {
  constructor(private readonly runs: RunService) {}

  @Post()
  @RequirePermission("run:create", "body-batch")
  create(@Body() body: { batchId?: string; rowNumber?: number }, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.create(body?.batchId ?? "", body?.rowNumber as number, {
      tenantId: principal.tenantId, actorUserId: principal.userId,
    });
  }

  @Get()
  @RequirePermission("run:read", "query-batch")
  list(@Query("batchId") batchId?: string) {
    return this.runs.list(batchId ?? "");
  }

  @Get(":id")
  @RequirePermission("run:read", "route-run")
  get(@Param("id") id: string, @Req() req: Request) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.get(id, principal.role);
  }

  @Get(":id/artifact")
  @RequirePermission("artifact:download", "route-run")
  async artifact(@Param("id") id: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    let artifact: Awaited<ReturnType<RunService["downloadArtifact"]>>;
    try {
      artifact = await this.runs.downloadArtifact(id);
    } catch (error) {
      if (error instanceof ArtifactDownloadError
        && error.code === "ARTIFACT_STORAGE_UNAVAILABLE") {
        throw new ServiceUnavailableException("Plik wynikowy jest chwilowo niedostępny");
      }
      throw new NotFoundException("Nie znaleziono gotowego pliku wynikowego");
    }
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    try {
      await recordAuditEvent({
        tenantId: principal.tenantId, actorUserId: principal.userId,
        action: "artifact.downloaded", resourceType: "artifact", resourceId: id, outcome: "succeeded",
      });
    } catch {
      throw new ServiceUnavailableException("Nie można zapisać zdarzenia audytu pobrania");
    }
    for (const [name, value] of Object.entries(artifactDownloadHeaders(artifact.fileName, artifact.bytes.byteLength))) {
      response.setHeader(name, value);
    }
    response.status(200).send(artifact.bytes);
  }

  @Post(":id/cancel")
  @RequirePermission("run:cancel", "route-run")
  cancel(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.cancel(id, { tenantId: principal.tenantId, actorUserId: principal.userId });
  }

  @Post(":id/resume-auth")
  @RequirePermission("run:resume", "route-run")
  resumeAuth(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.resumeAuth(id, { tenantId: principal.tenantId, actorUserId: principal.userId });
  }

  @Post(":id/resume-review")
  @RequirePermission("run:manual_data", "route-run")
  resumeReview(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    if (principal.role !== "admin") throw new ForbiddenException("Tylko administrator może wznowić zgłoszenie");
    return this.runs.resumeReview(id, { tenantId: principal.tenantId, actorUserId: principal.userId });
  }
}
