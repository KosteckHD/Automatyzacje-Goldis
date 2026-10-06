import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import { Op, QueryTypes, UniqueConstraintError, type Transaction } from "sequelize";
import type { Request } from "express";
import { normalizeNip, normalizeRegon, todayInWarsaw } from "@goldis/core";
import { assessEntityGrouping } from "./entity-grouping";
import { normalizeBusinessName } from "./registry-result";
import {
  AutomationRun, CanonicalEntity, EntityGroupingConflict, ImportBatch, RegonCorrection,
  RunSubmission, RunSubmissionGroup, RunSubmissionItem, SourceEntityLink, SourceRow,
  TenantMembership, Tool, ToolGrant, ToolSettings, User, sequelize,
} from "./db";
import { EntityGroupingService } from "./entity-grouping-service";
import { CanonicalRunService, createLeadIdentityKey, isInsideRunWindow } from "./canonical-run-service";
import { recordAuditEvent, type AuditActorContext } from "./audit";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "./session";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { canAccessTool, type ToolPrincipal } from "./tool-access";
import { RunService } from "./runs";

const toolId = "oc-policy-verification";
const maxSelection = 500;
const terminalRunStatuses = ["completed", "failed", "no_matching_policies", "cancelled"];
const activeRunStatuses = ["queued", "validating", "pzu_login", "everest_search", "compensa_login", "compensa_form", "ufg_verification", "reading_oc", "export_ready", "waiting_for_sms", "waiting_for_manual_data", "identity_review"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

type Selection = Readonly<{ rowNumbers: readonly number[] }>;
type SelectionInput = Readonly<{ rowNumbers?: unknown; fromRow?: unknown; toRow?: unknown }>;
type SnapshotEntry = {
  sourceRowId: string;
  rowNumber: number;
  expectedRowVersion: number;
  state: "ready" | "review" | "excluded";
  reasonCode: string | null;
  groupKey: string | null;
  groupProvisional: boolean;
  alreadyActive: boolean;
};
type PreviewSnapshot = {
  referenceDate: string;
  selectionFingerprint: string;
  entries: SnapshotEntry[];
  counts: { selected: number; ready: number; needsReview: number; excluded: number; uniqueGroups: number; alreadyActive: number };
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function parseSelection(value: SelectionInput): Selection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Nieprawidłowy wybór wierszy");
  const keys = Object.keys(value);
  const hasRows = Object.hasOwn(value, "rowNumbers");
  const hasRange = Object.hasOwn(value, "fromRow") || Object.hasOwn(value, "toRow");
  if (keys.some((key) => !["rowNumbers", "fromRow", "toRow"].includes(key)) || hasRows === hasRange) {
    throw new BadRequestException("Wybierz listę wierszy albo jeden zakres");
  }
  let rowNumbers: number[];
  if (hasRows) {
    if (!Array.isArray(value.rowNumbers) || value.rowNumbers.length < 1 || value.rowNumbers.length > maxSelection
      || value.rowNumbers.some((item) => !Number.isSafeInteger(item) || Number(item) < 2)) {
      throw new BadRequestException("Lista musi zawierać od 1 do 500 poprawnych numerów wiersza");
    }
    rowNumbers = value.rowNumbers as number[];
    if (new Set(rowNumbers).size !== rowNumbers.length) throw new BadRequestException("Lista wierszy zawiera duplikaty");
  } else {
    const from = value.fromRow; const to = value.toRow;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || Number(from) < 2 || Number(to) < Number(from)
      || Number(to) - Number(from) + 1 > maxSelection) {
      throw new BadRequestException("Zakres musi obejmować od 1 do 500 wierszy Excela");
    }
    rowNumbers = Array.from({ length: Number(to) - Number(from) + 1 }, (_, index) => Number(from) + index);
  }
  return { rowNumbers: rowNumbers.sort((a, b) => a - b) };
}

function requestHash(batchId: string, selection: Selection): string {
  return digest({ batchId, rowNumbers: selection.rowNumbers });
}

function activeStatus(status: string): boolean { return !terminalRunStatuses.includes(status); }

@Injectable()
export class RunSubmissionService implements OnModuleInit, OnModuleDestroy {
  private readonly dispatcherId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private readonly dispatchWarningTimes = new Map<string, number>();
  private dispatchFailureCount = 0;
  private nextDispatchAttemptAt = 0;

  constructor(
    private readonly grouping: EntityGroupingService,
    private readonly canonicalRuns: CanonicalRunService,
    private readonly runs: RunService,
  ) {}

  onModuleInit() {
    void this.dispatchPendingOnce();
    this.timer = setInterval(() => void this.dispatchPendingOnce(), 2_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async assertCanExecute(actor: AuditActorContext, role: string, batch: ImportBatch, transaction?: Transaction) {
    if (batch.toolId !== toolId || batch.tenantId !== actor.tenantId || (role !== "admin" && batch.ownerUserId !== actor.actorUserId)) {
      throw new NotFoundException("Nie znaleziono importu");
    }
    if (role !== "admin" && role !== "operator") throw new ForbiddenException("Ta rola nie może uruchamiać automatyzacji");
    const principal: ToolPrincipal = { tenantId: actor.tenantId, userId: actor.actorUserId, role: role as ToolPrincipal["role"] };
    if (!transaction) {
      if (!await canAccessTool(principal, batch.toolId, "execute")) throw new ForbiddenException("Brak prawa do uruchomienia narzędzia");
      return;
    }
    const user = await User.findByPk(actor.actorUserId, { attributes: ["status"], transaction, lock: transaction.LOCK.UPDATE });
    const membership = await TenantMembership.findOne({ where: { tenantId: actor.tenantId, userId: actor.actorUserId }, transaction, lock: transaction.LOCK.UPDATE });
    const tool = await Tool.findByPk(batch.toolId, { transaction, lock: transaction.LOCK.UPDATE });
    const grant = await ToolGrant.findOne({ where: { tenantId: actor.tenantId, toolId: batch.toolId, userId: actor.actorUserId }, transaction, lock: transaction.LOCK.UPDATE });
    const canExecute = membership?.role === "admin" ? tool?.status === "available" : Boolean(grant?.canExecute && tool?.status === "available");
    if (user?.status !== "active" || membership?.status !== "active" || membership.role !== role || !canExecute) {
      throw new ForbiddenException("Konto, członkostwo lub prawo uruchomienia nie jest już aktywne");
    }
  }

  private async snapshot(batchId: string, selection: Selection, actor: AuditActorContext, role: string, transaction?: Transaction, lock = false): Promise<PreviewSnapshot> {
    const batch = await ImportBatch.findByPk(batchId, { transaction, ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!batch) throw new NotFoundException("Nie znaleziono importu");
    await this.assertCanExecute(actor, role, batch, transaction);
    const rows = await SourceRow.findAll({
      where: { batchId, rowNumber: selection.rowNumbers }, order: [["rowNumber", "ASC"]], transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (rows.length !== selection.rowNumbers.length) throw new ConflictException("Część wskazanych wierszy nie należy do tego importu");
    const sourceIds = rows.map((row) => row.id);
    const correctionQuery = () => RegonCorrection.findAll({ where: { sourceRowId: sourceIds, status: "pending" }, attributes: ["sourceRowId"], transaction,
        ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    const conflictQuery = () => EntityGroupingConflict.findAll({ where: { sourceRowId: sourceIds, status: "open" }, attributes: ["sourceRowId"], transaction,
        ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    const linksQuery = () => SourceEntityLink.findAll({ where: { sourceRowId: sourceIds, tenantId: actor.tenantId }, attributes: ["sourceRowId", "canonicalEntityId"], transaction,
        ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    const activeRunsQuery = () => sourceIds.length ? sequelize.query<{ sourceRowId: string; runId: string; status: string; referenceDate: string }>(
        `SELECT selected.source_row_id AS "sourceRowId", run.id AS "runId", run.status, run.reference_date AS "referenceDate"
           FROM automation_runs run
           JOIN LATERAL (
             SELECT member.source_row_id FROM run_source_rows member WHERE member.run_id = run.id
             UNION SELECT run.source_row_id
           ) selected ON TRUE
          WHERE run.batch_id = :batchId AND selected.source_row_id IN (:sourceIds)
            AND run.status NOT IN ('completed', 'failed', 'no_matching_policies', 'cancelled')`,
        { replacements: { batchId, sourceIds }, type: QueryTypes.SELECT, transaction },
      ) : Promise.resolve([]);
    const [corrections, conflicts, links, openRuns] = transaction
      ? [await correctionQuery(), await conflictQuery(), await linksQuery(), await activeRunsQuery()]
      : await Promise.all([correctionQuery(), conflictQuery(), linksQuery(), activeRunsQuery()]);
    const nipValues = rows.map((row) => normalizeNip(row.nipRaw).normalized).filter((value): value is string => Boolean(value));
    const regonValues = rows.map((row) => row.effectiveRegon ? normalizeRegon(row.effectiveRegon).normalized : null).filter((value): value is string => Boolean(value));
    const candidates = nipValues.length || regonValues.length ? await CanonicalEntity.findAll({
      where: { tenantId: actor.tenantId, [Op.or]: [
        ...(nipValues.length ? [{ nipNormalized: [...new Set(nipValues)] }] : []),
        ...(regonValues.length ? [{ regon: [...new Set(regonValues)] }] : []),
      ] }, attributes: ["canonicalEntityId", "nipNormalized", "regon", "businessName"], transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    }) : [];
    const pendingCorrectionIds = new Set(corrections.map((item) => item.sourceRowId));
    const openConflictIds = new Set(conflicts.map((item) => item.sourceRowId));
    const linkedBySource = new Map(links.map((item) => [item.sourceRowId, item.canonicalEntityId]));
    const activeBySource = new Map<string, typeof openRuns>();
    for (const run of openRuns) activeBySource.set(run.sourceRowId, [...(activeBySource.get(run.sourceRowId) ?? []), run]);
    const knownCandidates = candidates.map((candidate) => ({
      canonicalEntityId: candidate.canonicalEntityId,
      nipNormalized: candidate.nipNormalized,
      regon: candidate.regon,
      businessName: candidate.businessName,
    }));
    const virtualCandidates: typeof knownCandidates = [];
    const referenceDate = todayInWarsaw();
    const entries: SnapshotEntry[] = [];
    for (const row of rows) {
      let state: SnapshotEntry["state"] = "ready";
      let reasonCode: string | null = null;
      let groupKey: string | null = null;
      let groupProvisional = false;
      let alreadyActive = false;
      if (pendingCorrectionIds.has(row.id)) { state = "review"; reasonCode = "PENDING_REGON_CORRECTION"; }
      else if (openConflictIds.has(row.id)) { state = "review"; reasonCode = "OPEN_ENTITY_CONFLICT"; }
      else if (!row.effectiveRegon || row.issues.length > 0) {
        state = "excluded"; reasonCode = !row.effectiveRegon ? "REGON_REQUIRED" : "SOURCE_ROW_HAS_ISSUES";
      } else {
        const decision = assessEntityGrouping({ nipRaw: row.nipRaw, effectiveRegon: row.effectiveRegon,
          companyName: row.companyName, candidates: [...knownCandidates, ...virtualCandidates] });
        if (decision.outcome === "conflict") {
          state = "review"; reasonCode = decision.reasonCode;
        } else {
          const sourceLinkId = linkedBySource.get(row.id);
          if (sourceLinkId && decision.outcome === "link_existing" && sourceLinkId !== decision.canonicalEntityId) {
            state = "review"; reasonCode = "SOURCE_LINK_MISMATCH";
          } else {
            let identityId: string;
            if (decision.outcome === "link_existing") identityId = decision.canonicalEntityId;
            else {
              identityId = `preview-${digest([decision.nipNormalized, decision.regon, normalizeBusinessName(decision.businessName)])}`;
              virtualCandidates.push({ canonicalEntityId: identityId, nipNormalized: decision.nipNormalized,
                regon: decision.regon, businessName: decision.businessName });
            }
            groupProvisional = identityId.startsWith("preview-");
            groupKey = createLeadIdentityKey(identityId, row.decisionMakerName);
            const active = activeBySource.get(row.id) ?? [];
            if (active.length) {
              if (active.some((run) => run.referenceDate.slice(0, 10) !== referenceDate)) {
                state = "review"; reasonCode = "ACTIVE_RUN_REFERENCE_DATE_MISMATCH"; groupKey = null;
              } else alreadyActive = true;
            }
          }
        }
      }
      entries.push({ sourceRowId: row.id, rowNumber: row.rowNumber, expectedRowVersion: row.rowVersion,
        state, reasonCode, groupKey, groupProvisional, alreadyActive });
    }
    const fingerprint = digest({ batchId, rowNumbers: selection.rowNumbers, referenceDate,
      entries: entries.map(({ sourceRowId, rowNumber, expectedRowVersion, state, reasonCode, groupKey, alreadyActive: isActive }) =>
        [sourceRowId, rowNumber, expectedRowVersion, state, reasonCode, groupKey, entries.find((entry) => entry.sourceRowId === sourceRowId)?.groupProvisional, isActive]) });
    return {
      referenceDate, selectionFingerprint: fingerprint, entries,
      counts: {
        selected: entries.length,
        ready: entries.filter((entry) => entry.state === "ready").length,
        needsReview: entries.filter((entry) => entry.state === "review").length,
        excluded: entries.filter((entry) => entry.state === "excluded").length,
        uniqueGroups: new Set(entries.filter((entry) => entry.state === "ready" && entry.groupKey).map((entry) => entry.groupKey)).size,
        alreadyActive: entries.filter((entry) => entry.state === "ready" && entry.alreadyActive).length,
      },
    };
  }

  async preview(batchId: string, input: SelectionInput, actor: AuditActorContext, role: string) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new BadRequestException("Nieprawidłowy wybór wierszy");
    if (!uuidPattern.test(batchId)) throw new BadRequestException("Nieprawidłowy import");
    if (Object.keys(input).some((key) => !["rowNumbers", "fromRow", "toRow", "selectionFingerprint", "idempotencyKey"].includes(key))) {
      throw new BadRequestException("Nieznane pole zgłoszenia uruchomienia");
    }
    const selectionInput: SelectionInput = {
      ...(Object.hasOwn(input, "rowNumbers") ? { rowNumbers: input.rowNumbers } : {}),
      ...(Object.hasOwn(input, "fromRow") ? { fromRow: input.fromRow } : {}),
      ...(Object.hasOwn(input, "toRow") ? { toRow: input.toRow } : {}),
    };
    const selection = parseSelection(selectionInput);
    const snapshot = await this.snapshot(batchId, selection, actor, role);
    return {
      importBatchId: batchId, referenceDate: snapshot.referenceDate,
      selectionFingerprint: snapshot.selectionFingerprint, counts: snapshot.counts,
      items: snapshot.entries.map(({ rowNumber, expectedRowVersion, state, reasonCode, alreadyActive }) =>
        ({ rowNumber, expectedRowVersion, state, reasonCode, alreadyActive })),
    };
  }

  async create(batchId: string, input: SelectionInput & { selectionFingerprint?: unknown; idempotencyKey?: unknown }, actor: AuditActorContext, role: string) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new BadRequestException("Nieprawidłowe zgłoszenie uruchomienia");
    if (!uuidPattern.test(batchId) || typeof input.selectionFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(input.selectionFingerprint)
      || typeof input.idempotencyKey !== "string" || !keyPattern.test(input.idempotencyKey)) {
      throw new BadRequestException("Wymagane są wybór, podgląd i klucz idempotencji");
    }
    if (Object.keys(input).some((key) => !["rowNumbers", "fromRow", "toRow", "selectionFingerprint", "idempotencyKey"].includes(key))) {
      throw new BadRequestException("Nieznane pole zgłoszenia uruchomienia");
    }
    const selection = parseSelection({
      ...(Object.hasOwn(input, "rowNumbers") ? { rowNumbers: input.rowNumbers } : {}),
      ...(Object.hasOwn(input, "fromRow") ? { fromRow: input.fromRow } : {}),
      ...(Object.hasOwn(input, "toRow") ? { toRow: input.toRow } : {}),
    });
    const hash = requestHash(batchId, selection);
    const prior = await RunSubmission.findOne({ where: { tenantId: actor.tenantId, actorUserId: actor.actorUserId, idempotencyKey: input.idempotencyKey } });
    if (prior) {
      if (prior.requestHash !== hash || prior.importBatchId !== batchId) throw new ConflictException("Ten klucz został użyty dla innego wyboru");
      return this.get(prior.submissionId, actor, role);
    }
    try {
      const submissionId = await sequelize.transaction(async (transaction) => {
        const settings = await ToolSettings.findOne({ where: { tenantId: actor.tenantId, toolId }, transaction, lock: transaction.LOCK.UPDATE });
        if (!settings) throw new ConflictException("Narzędzie nie ma konfiguracji uruchomień");
        const batch = await ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!batch) throw new NotFoundException("Nie znaleziono importu");
        await this.assertCanExecute(actor, role, batch, transaction);
        const duplicate = await RunSubmission.findOne({ where: { tenantId: actor.tenantId, actorUserId: actor.actorUserId,
          idempotencyKey: input.idempotencyKey as string }, transaction, lock: transaction.LOCK.UPDATE });
        if (duplicate) {
          if (duplicate.requestHash !== hash || duplicate.importBatchId !== batchId) throw new ConflictException("Ten klucz został użyty dla innego wyboru");
          return duplicate.submissionId;
        }
        const snapshot = await this.snapshot(batchId, selection, actor, role, transaction, true);
        if (snapshot.selectionFingerprint !== input.selectionFingerprint) throw new ConflictException("Wiersze lub grupowanie zmieniły się; odśwież podsumowanie");

        const resolved = new Map<number, { canonicalEntityId: string; leadIdentityKey: string; sourceRowId: string }>();
        for (const entry of snapshot.entries.filter((item) => item.state === "ready")) {
          const outcomes = await this.grouping.resolveRelatedRows(batchId, entry.rowNumber, transaction);
          const selected = outcomes.find((outcome) => outcome.rowNumber === entry.rowNumber);
          if (!selected || selected.status !== "linked") throw new ConflictException("Grupowanie zmieniło się; odśwież podsumowanie");
          const link = await SourceEntityLink.findOne({ where: { sourceRowId: selected.sourceRowId, tenantId: actor.tenantId }, transaction });
          const row = await SourceRow.findByPk(selected.sourceRowId, { transaction });
          const canonical = await CanonicalEntity.findOne({ where: { canonicalEntityId: selected.canonicalEntityId, tenantId: actor.tenantId }, transaction });
          if (!link || !row || !canonical || !canonical.regon || row.effectiveRegon !== canonical.regon
            || row.issues.length > 0 || normalizeBusinessName(row.companyName) !== normalizeBusinessName(canonical.businessName)) {
            throw new ConflictException("Grupowanie zmieniło się; odśwież podsumowanie");
          }
          const actualLeadKey = createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName);
          resolved.set(entry.rowNumber, { canonicalEntityId: canonical.canonicalEntityId, leadIdentityKey: actualLeadKey, sourceRowId: row.id });
          if (actualLeadKey !== entry.groupKey && !entry.groupProvisional) {
            throw new ConflictException("Tożsamość grupy zmieniła się; odśwież podsumowanie");
          }
        }
        const expectedToActual = new Map<string, string>();
        const actualToExpected = new Map<string, string>();
        for (const entry of snapshot.entries.filter((item) => item.state === "ready")) {
          const value = resolved.get(entry.rowNumber)!;
          const actual = `${value.canonicalEntityId}:${value.leadIdentityKey}`;
          const priorActual = expectedToActual.get(entry.groupKey!);
          const priorExpected = actualToExpected.get(actual);
          if ((priorActual && priorActual !== actual) || (priorExpected && priorExpected !== entry.groupKey)) {
            throw new ConflictException("Grupowanie różni się od podglądu; odśwież podsumowanie");
          }
          expectedToActual.set(entry.groupKey!, actual);
          actualToExpected.set(actual, entry.groupKey!);
        }

        const now = new Date();
        const submission = await RunSubmission.create({
          submissionId: randomUUID(), importBatchId: batchId, tenantId: actor.tenantId, toolId: batch.toolId,
          actorUserId: actor.actorUserId, idempotencyKey: input.idempotencyKey as string, requestHash: hash,
          referenceDate: snapshot.referenceDate, status: "queued", version: 1, createdAt: now, updatedAt: now,
        }, { transaction });
        const groups = new Map<string, string>();
        for (const entry of snapshot.entries.filter((item) => item.state === "ready")) {
          const value = resolved.get(entry.rowNumber)!;
          const actual = `${value.canonicalEntityId}:${value.leadIdentityKey}`;
          if (!groups.has(actual)) {
            const groupId = randomUUID(); groups.set(actual, groupId);
            await RunSubmissionGroup.create({ groupId, submissionId: submission.submissionId, tenantId: actor.tenantId,
              canonicalEntityId: value.canonicalEntityId, leadIdentityKey: value.leadIdentityKey, runId: null,
              admissionState: "pending", reasonCode: null, nextAttemptAt: now, leaseOwner: null, leaseExpiresAt: null,
              version: 1, createdAt: now, updatedAt: now }, { transaction });
          }
        }
        await RunSubmissionItem.bulkCreate(snapshot.entries.map((entry) => {
          const value = resolved.get(entry.rowNumber);
          const groupId = value ? groups.get(`${value.canonicalEntityId}:${value.leadIdentityKey}`)! : null;
          return { itemId: randomUUID(), submissionId: submission.submissionId, importBatchId: batchId,
            sourceRowId: entry.sourceRowId, groupId, expectedRowVersion: entry.expectedRowVersion,
            preparationState: entry.state, reasonCode: entry.reasonCode, createdAt: now };
        }), { transaction });
        await recordAuditEvent({ tenantId: actor.tenantId, actorUserId: actor.actorUserId,
          action: "run.submission.created", resourceType: "run_submission", resourceId: submission.submissionId,
          outcome: "succeeded", metadata: { selectedRows: snapshot.counts.selected, readyRows: snapshot.counts.ready,
            uniqueGroups: groups.size, referenceDate: snapshot.referenceDate } }, transaction);
        return submission.submissionId;
      });
      return this.get(submissionId, actor, role);
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) throw error;
      const concurrent = await RunSubmission.findOne({ where: { tenantId: actor.tenantId, actorUserId: actor.actorUserId, idempotencyKey: input.idempotencyKey as string } });
      if (!concurrent) throw error;
      if (concurrent.requestHash !== hash || concurrent.importBatchId !== batchId) throw new ConflictException("Ten klucz został użyty dla innego wyboru");
      return this.get(concurrent.submissionId, actor, role);
    }
  }

  private async countState(submission: RunSubmission, actor: AuditActorContext) {
    const [items, groups] = await Promise.all([
      RunSubmissionItem.findAll({ where: { submissionId: submission.submissionId }, order: [["sourceRowId", "ASC"]] }),
      RunSubmissionGroup.findAll({ where: { submissionId: submission.submissionId } }),
    ]);
    const groupById = new Map(groups.map((group) => [group.groupId, group]));
    const runIds = groups.map((group) => group.runId).filter((id): id is string => Boolean(id));
    const runs = runIds.length ? await AutomationRun.findAll({ where: { id: runIds }, attributes: ["id", "status", "errorCode", "referenceDate"] }) : [];
    const runById = new Map(runs.map((run) => [run.id, run]));
    const itemCounts: Record<string, number> = { review: 0, excluded: 0, waiting: 0, running: 0, waiting_attention: 0,
      completed: 0, no_matching_policies: 0, failed: 0, cancelled: 0, blocked: 0 };
    for (const item of items) {
      if (item.preparationState !== "ready") { itemCounts[item.preparationState] = (itemCounts[item.preparationState] ?? 0) + 1; continue; }
      const group = item.groupId ? groupById.get(item.groupId) : null;
      if (!group) { itemCounts.blocked += 1; continue; }
      if (group.admissionState === "cancelled") { itemCounts.cancelled += 1; continue; }
      if (group.admissionState === "blocked") { itemCounts.blocked += 1; continue; }
      if (group.admissionState !== "accepted" || !group.runId) { itemCounts.waiting += 1; continue; }
      const run = runById.get(group.runId);
      if (!run) { itemCounts.blocked += 1; continue; }
      if (run.status === "completed") itemCounts.completed += 1;
      else if (run.status === "no_matching_policies") itemCounts.no_matching_policies += 1;
      else if (run.status === "failed") itemCounts.failed += 1;
      else if (run.status === "cancelled") itemCounts.cancelled += 1;
      else if (["identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(run.status)) itemCounts.waiting_attention += 1;
      else itemCounts.running += 1;
    }
    const groupCounts: Record<string, number> = { pending: 0, waiting: 0, accepted: 0, blocked: 0, cancelled: 0,
      completed: 0, no_matching_policies: 0, failed: 0, waiting_attention: 0, running: 0 };
    for (const group of groups) {
      if (group.admissionState === "blocked") { groupCounts.blocked += 1; continue; }
      if (group.admissionState === "cancelled") { groupCounts.cancelled += 1; continue; }
      if (group.admissionState === "waiting_capacity" || group.admissionState === "waiting_window" || group.admissionState === "waiting_paused") {
        groupCounts.waiting += 1; continue;
      }
      if (group.admissionState === "pending" || group.admissionState === "leased") { groupCounts.pending += 1; continue; }
      groupCounts.accepted += 1;
      const run = group.runId ? runById.get(group.runId) : null;
      if (run?.status === "completed") groupCounts.completed += 1;
      else if (run?.status === "no_matching_policies") groupCounts.no_matching_policies += 1;
      else if (run?.status === "failed" || run?.status === "cancelled") groupCounts.failed += 1;
      else if (run && ["identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(run.status)) groupCounts.waiting_attention += 1;
      else if (run) groupCounts.running += 1;
    }
    const allItemsSettled = items.length > 0 && itemCounts.waiting === 0 && itemCounts.running === 0;
    const status = submission.status === "cancelled" ? "cancelled"
      : itemCounts.waiting ? "queued"
      : itemCounts.running ? "running"
      : itemCounts.waiting_attention || itemCounts.blocked || itemCounts.review ? "waiting_attention"
      : allItemsSettled ? "completed" : "queued";
    return { status, itemCounts, groupCounts };
  }

  async get(id: string, actor: AuditActorContext, role: string) {
    if (!uuidPattern.test(id)) throw new BadRequestException("Nieprawidłowa partia");
    const submission = await RunSubmission.findOne({ where: { submissionId: id, tenantId: actor.tenantId } });
    if (!submission) throw new NotFoundException("Nie znaleziono partii");
    const batch = await ImportBatch.findByPk(submission.importBatchId);
    if (!batch) throw new NotFoundException("Nie znaleziono partii");
    await this.assertCanExecute(actor, role, batch);
    const state = await this.countState(submission, actor);
    const groupTotal = await RunSubmissionGroup.count({ where: { submissionId: submission.submissionId } });
    const itemTotal = await RunSubmissionItem.count({ where: { submissionId: submission.submissionId } });
    return { submissionId: submission.submissionId, importBatchId: submission.importBatchId, toolId: submission.toolId,
      referenceDate: submission.referenceDate, status: state.status, version: submission.version,
      counts: { items: state.itemCounts, groups: state.groupCounts, selectedRows: itemTotal, uniqueGroups: groupTotal },
      createdAt: submission.createdAt, updatedAt: submission.updatedAt };
  }

  async listItems(id: string, cursor: string | undefined, actor: AuditActorContext, role: string) {
    const submission = await RunSubmission.findOne({ where: { submissionId: id, tenantId: actor.tenantId } });
    if (!submission) throw new NotFoundException("Nie znaleziono partii");
    const batch = await ImportBatch.findByPk(submission.importBatchId);
    if (!batch) throw new NotFoundException("Nie znaleziono partii");
    await this.assertCanExecute(actor, role, batch);
    let after: { rowNumber: number; sourceRowId: string } | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (parsed?.submissionId !== id || !Number.isSafeInteger(parsed?.rowNumber) || !uuidPattern.test(parsed?.sourceRowId)) throw new Error();
        after = { rowNumber: parsed.rowNumber, sourceRowId: parsed.sourceRowId };
      } catch { throw new BadRequestException("Nieprawidłowy kursor partii"); }
    }
    const items = await sequelize.query<{
      itemId: string; sourceRowId: string; rowNumber: number; expectedRowVersion: number; preparationState: string;
      reasonCode: string | null; groupId: string | null; admissionState: string | null; groupReason: string | null;
      runId: string | null; runStatus: string | null; runErrorCode: string | null;
    }>(
      `SELECT item.item_id AS "itemId", item.source_row_id AS "sourceRowId", source.row_number AS "rowNumber",
              item.expected_row_version AS "expectedRowVersion", item.preparation_state AS "preparationState",
              item.reason_code AS "reasonCode", item.group_id AS "groupId", grp.admission_state AS "admissionState",
              grp.reason_code AS "groupReason", grp.run_id AS "runId", run.status AS "runStatus", run.error_code AS "runErrorCode"
         FROM run_submission_items item JOIN source_rows source ON source.id = item.source_row_id
         LEFT JOIN run_submission_groups grp ON grp.group_id = item.group_id
         LEFT JOIN automation_runs run ON run.id = grp.run_id
        WHERE item.submission_id = :submissionId
          AND (:cursorRowNumber IS NULL OR (source.row_number, item.source_row_id) > (:cursorRowNumber, CAST(:cursorSourceRowId AS uuid)))
        ORDER BY source.row_number ASC, item.source_row_id ASC LIMIT 51`,
      { replacements: { submissionId: id, cursorRowNumber: after?.rowNumber ?? null, cursorSourceRowId: after?.sourceRowId ?? null }, type: QueryTypes.SELECT },
    );
    const hasMore = items.length > 50;
    const page = items.slice(0, 50);
    const last = page.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ submissionId: id, rowNumber: last.rowNumber, sourceRowId: last.sourceRowId }), "utf8").toString("base64url") : null;
    return { items: page, nextCursor };
  }

  async cancel(id: string, expectedVersion: number, actor: AuditActorContext) {
    if (!uuidPattern.test(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new BadRequestException("Nieprawidłowa wersja partii");
    return sequelize.transaction(async (transaction) => {
      const submission = await RunSubmission.findOne({ where: { submissionId: id, tenantId: actor.tenantId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!submission) throw new NotFoundException("Nie znaleziono partii");
      const batch = await ImportBatch.findByPk(submission.importBatchId, { transaction });
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException("Nie znaleziono partii");
      if (submission.actorUserId !== actor.actorUserId) throw new NotFoundException("Nie znaleziono partii");
      if (submission.version !== expectedVersion) throw new ConflictException("Partia została zmieniona; odśwież stan");
      if (submission.status === "cancelled") return { submissionId: id, status: "cancelled", version: submission.version };
      const now = new Date();
      await RunSubmissionGroup.update({ admissionState: "cancelled", reasonCode: "SUBMISSION_CANCELLED", nextAttemptAt: null,
        leaseOwner: null, leaseExpiresAt: null, version: sequelize.literal("version + 1"), updatedAt: now }, {
        where: { submissionId: id, runId: null, admissionState: ["pending", "leased", "waiting_capacity", "waiting_window", "waiting_paused"] }, transaction,
      });
      submission.status = "cancelled"; submission.version += 1; submission.updatedAt = now;
      await submission.save({ transaction });
      await recordAuditEvent({ tenantId: actor.tenantId, actorUserId: actor.actorUserId,
        action: "run.submission.cancelled", resourceType: "run_submission", resourceId: id, outcome: "succeeded" }, transaction);
      return { submissionId: id, status: "cancelled", version: submission.version,
        acceptedRunsContinue: await RunSubmissionGroup.count({ where: { submissionId: id, runId: { [Op.ne]: null } }, transaction }) > 0 };
    });
  }

  private async claim(): Promise<string | null> {
    const now = new Date();
    return sequelize.transaction(async (transaction) => {
      const group = await RunSubmissionGroup.findOne({
        where: { runId: null, admissionState: { [Op.in]: ["pending", "waiting_capacity", "waiting_window", "waiting_paused", "leased"] },
          [Op.and]: [{ [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: now } }] },
            { [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: now } }] }] },
        order: [["createdAt", "ASC"], ["groupId", "ASC"]], transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
      });
      if (!group) return null;
      group.admissionState = "leased"; group.leaseOwner = this.dispatcherId;
      group.leaseExpiresAt = new Date(now.getTime() + 30_000); group.version += 1; group.updatedAt = now;
      await group.save({ transaction });
      return group.groupId;
    });
  }

  private async defer(group: RunSubmissionGroup, transaction: Transaction, state: RunSubmissionGroup["admissionState"], reasonCode: string, delayMs: number) {
    group.admissionState = state; group.reasonCode = reasonCode; group.nextAttemptAt = new Date(Date.now() + delayMs);
    group.leaseOwner = null; group.leaseExpiresAt = null; group.version += 1; group.updatedAt = new Date();
    await group.save({ transaction });
  }

  private async admit(groupId: string) {
    // Read only enough to discover which settings row must be locked first.
    const observed = await RunSubmissionGroup.findByPk(groupId, { attributes: ["submissionId", "canonicalEntityId", "tenantId", "leaseOwner", "runId"] });
    if (!observed || observed.leaseOwner !== this.dispatcherId || observed.runId) return;
    const observedSubmission = await RunSubmission.findByPk(observed.submissionId, { attributes: ["importBatchId", "actorUserId", "tenantId", "toolId", "referenceDate"] });
    if (!observedSubmission) return;
    await sequelize.transaction(async (transaction) => {
      const settings = await ToolSettings.findOne({ where: { tenantId: observedSubmission.tenantId, toolId: observedSubmission.toolId }, transaction, lock: transaction.LOCK.UPDATE });
      const actorUser = await User.findByPk(observedSubmission.actorUserId, { transaction, lock: transaction.LOCK.UPDATE });
      const membership = await TenantMembership.findOne({ where: { tenantId: observedSubmission.tenantId, userId: observedSubmission.actorUserId }, transaction, lock: transaction.LOCK.UPDATE });
      const tool = await Tool.findByPk(observedSubmission.toolId, { transaction, lock: transaction.LOCK.UPDATE });
      const grant = await ToolGrant.findOne({ where: { tenantId: observedSubmission.tenantId, toolId: observedSubmission.toolId, userId: observedSubmission.actorUserId }, transaction, lock: transaction.LOCK.UPDATE });
      const batch = await ImportBatch.findByPk(observedSubmission.importBatchId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!settings || !actorUser || !membership || !tool || !batch) {
        const group = await RunSubmissionGroup.findByPk(groupId, { transaction, lock: transaction.LOCK.UPDATE });
        if (group?.leaseOwner === this.dispatcherId && !group.runId) await this.defer(group, transaction, "blocked", "CONFIGURATION_MISSING", 0);
        return;
      }
      const groupItems = await RunSubmissionItem.findAll({ where: { submissionId: observed.submissionId, groupId }, order: [["sourceRowId", "ASC"]], transaction });
      const linkedRows = await SourceEntityLink.findAll({ where: { tenantId: observedSubmission.tenantId, canonicalEntityId: observed.canonicalEntityId }, attributes: ["sourceRowId", "canonicalEntityId"], transaction });
      const rowIds = [...new Set([...groupItems.map((item) => item.sourceRowId), ...linkedRows.map((link) => link.sourceRowId)])];
      const rows = await SourceRow.findAll({ where: { id: rowIds, batchId: observedSubmission.importBatchId }, order: [["rowNumber", "ASC"]], transaction, lock: transaction.LOCK.UPDATE });
      const canonical = await CanonicalEntity.findOne({ where: { canonicalEntityId: observed.canonicalEntityId, tenantId: observedSubmission.tenantId }, transaction, lock: transaction.LOCK.UPDATE });
      const group = await RunSubmissionGroup.findByPk(groupId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!group || group.leaseOwner !== this.dispatcherId || group.runId || group.admissionState !== "leased") return;
      if (observedSubmission.tenantId !== batch.tenantId || observedSubmission.toolId !== batch.toolId
        || observedSubmission.actorUserId !== batch.ownerUserId && membership.role !== "admin") {
        await this.defer(group, transaction, "blocked", "OWNER_SCOPE_CHANGED", 0); return;
      }
      if (actorUser.status !== "active" || membership.status !== "active"
        || (membership.role !== "admin" && membership.role !== "operator")
        || (membership.role !== "admin" && (!grant?.canExecute || tool.status !== "available"))) {
        await this.defer(group, transaction, "blocked", "EXECUTE_ACCESS_REVOKED", 0); return;
      }
      if (!settings.enabledForNewRuns || tool.status === "maintenance") {
        await this.defer(group, transaction, "waiting_paused", "NEW_RUNS_PAUSED", 60_000); return;
      }
      if (tool.status !== "available") {
        await this.defer(group, transaction, "blocked", "TOOL_UNAVAILABLE", 0); return;
      }
      if (!canonical || !canonical.regon || groupItems.length === 0) {
        await this.defer(group, transaction, "blocked", "GROUP_INVALID", 0); return;
      }
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const selectedRows = groupItems.map((item) => rowById.get(item.sourceRowId)).filter((row): row is SourceRow => Boolean(row));
      const stale = groupItems.some((item) => rowById.get(item.sourceRowId)?.rowVersion !== item.expectedRowVersion);
      const memberRows = rows.filter((row) => {
        const link = linkedRows.find((item) => item.sourceRowId === row.id);
        return link?.canonicalEntityId === canonical.canonicalEntityId
          && createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName) === group.leadIdentityKey;
      });
      const pendingCorrection = selectedRows.length ? await RegonCorrection.findOne({ where: { sourceRowId: selectedRows.map((row) => row.id), status: "pending" }, transaction, lock: transaction.LOCK.UPDATE }) : null;
      const openConflict = selectedRows.length ? await EntityGroupingConflict.findOne({ where: { sourceRowId: selectedRows.map((row) => row.id), status: "open" }, transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (stale || selectedRows.length !== groupItems.length || pendingCorrection || openConflict
        || memberRows.length === 0 || memberRows.some((row) => row.issues.length || row.effectiveRegon !== canonical.regon
          || normalizeBusinessName(row.companyName) !== normalizeBusinessName(canonical.businessName)
          || createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName) !== group.leadIdentityKey)) {
        await this.defer(group, transaction, "blocked", stale ? "SOURCE_VERSION_CHANGED" : pendingCorrection ? "PENDING_CORRECTION" : openConflict ? "OPEN_CONFLICT" : "GROUP_REVIEW_REQUIRED", 0); return;
      }
      const existing = await AutomationRun.findOne({ where: { batchId: batch.id, canonicalEntityId: canonical.canonicalEntityId,
        leadIdentityKey: group.leadIdentityKey, status: { [Op.notIn]: terminalRunStatuses } }, transaction, lock: transaction.LOCK.UPDATE });
      if (existing && existing.referenceDate !== observedSubmission.referenceDate) {
        await this.defer(group, transaction, "blocked", "ACTIVE_RUN_REFERENCE_DATE_MISMATCH", 0); return;
      }
      if (!existing) {
        const now = new Date();
        if (!isInsideRunWindow(now, settings.timezone, settings.allowedLocalStart, settings.allowedLocalEnd)) {
          await this.defer(group, transaction, "waiting_window", "OUTSIDE_RUN_WINDOW", 5 * 60_000); return;
        }
        if (settings.maxNewRunsPerHour !== null) {
          const recent = await sequelize.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
              WHERE b.tenant_id = :tenantId AND b.tool_id = :toolId AND r.created_at >= :since`,
            { replacements: { tenantId: observedSubmission.tenantId, toolId: observedSubmission.toolId,
              since: new Date(now.getTime() - 60 * 60_000) }, type: QueryTypes.SELECT, transaction },
          );
          if (Number(recent[0]?.count ?? 0) >= settings.maxNewRunsPerHour) {
            await this.defer(group, transaction, "waiting_capacity", "HOURLY_RUN_LIMIT", 60_000); return;
          }
        }
      }
      const actor = { tenantId: observedSubmission.tenantId, actorUserId: observedSubmission.actorUserId };
      const run = await this.canonicalRuns.createOrGet(batch.id, canonical.canonicalEntityId, group.leadIdentityKey,
        memberRows, actor, async (queuedRun, tx) => { await this.runs.ensureDispatchForAdmission(queuedRun.id, tx); },
        { transaction, referenceDate: observedSubmission.referenceDate });
      group.runId = run.id; group.admissionState = "accepted"; group.reasonCode = null; group.nextAttemptAt = null;
      group.leaseOwner = null; group.leaseExpiresAt = null; group.version += 1; group.updatedAt = new Date();
      await group.save({ transaction });
      await recordAuditEvent({ tenantId: observedSubmission.tenantId, actorUserId: observedSubmission.actorUserId,
        action: "run.submission.group_admitted", resourceType: "run_submission", resourceId: observedSubmission.submissionId,
        outcome: "succeeded", metadata: { groupId: group.groupId, runId: run.id, referenceDate: observedSubmission.referenceDate } }, transaction);
    });
  }

  async dispatchPendingOnce() {
    if (this.dispatching || Date.now() < this.nextDispatchAttemptAt) return;
    this.dispatching = true;
    try {
      const groupId = await this.claim();
      if (groupId) await this.admit(groupId);
      this.dispatchFailureCount = 0;
      this.nextDispatchAttemptAt = 0;
    } catch (error) {
      const now = Date.now();
      this.dispatchFailureCount += 1;
      this.nextDispatchAttemptAt = now + Math.min(30_000, 1_000 * (2 ** Math.min(this.dispatchFailureCount, 5)));
      const value = error as { name?: unknown; code?: unknown; parent?: { code?: unknown } } | null;
      const name = typeof value?.name === "string" && /^[A-Za-z]+Error$/.test(value.name) ? value.name : "UnknownError";
      const codeValue = value?.code ?? value?.parent?.code;
      const code = typeof codeValue === "string" && /^[A-Z0-9_]{4,16}$/.test(codeValue) ? codeValue : "UNKNOWN";
      const warningKey = `${name}:${code}`;
      if (now - (this.dispatchWarningTimes.get(warningKey) ?? 0) >= 60_000) {
        this.dispatchWarningTimes.set(warningKey, now);
        console.warn("RUN_SUBMISSION_DISPATCH_FAILED", name, code);
      }
    } finally { this.dispatching = false; }
  }
}

@Controller()
@UseGuards(SessionGuard, PermissionGuard)
export class RunSubmissionController {
  constructor(private readonly submissions: RunSubmissionService) {}

  @Post("imports/:batchId/run-submissions/preview")
  @RequirePermission("run:create", "route-batch")
  preview(@Param("batchId") batchId: string, @Body() body: SelectionInput, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.preview(batchId, body, { tenantId: principal.tenantId, actorUserId: principal.userId }, principal.role);
  }

  @Post("imports/:batchId/run-submissions")
  @RequirePermission("run:create", "route-batch")
  create(@Param("batchId") batchId: string, @Body() body: SelectionInput & { selectionFingerprint?: unknown; idempotencyKey?: unknown }, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.create(batchId, body, { tenantId: principal.tenantId, actorUserId: principal.userId }, principal.role);
  }

  @Get("run-submissions/:id")
  @RequirePermission("submission:read", "route-submission")
  get(@Param("id") id: string, @Req() request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.get(id, { tenantId: principal.tenantId, actorUserId: principal.userId }, principal.role);
  }

  @Get("run-submissions/:id/items")
  @RequirePermission("submission:read", "route-submission")
  items(@Param("id") id: string, @Query("cursor") cursor: string | undefined, @Req() request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.listItems(id, cursor, { tenantId: principal.tenantId, actorUserId: principal.userId }, principal.role);
  }

  @Post("run-submissions/:id/cancel")
  @RequirePermission("submission:cancel", "route-submission")
  cancel(@Param("id") id: string, @Body() body: { expectedVersion?: unknown }, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    if (!body || Object.keys(body).some((key) => key !== "expectedVersion")) throw new BadRequestException("Nieprawidłowe żądanie anulowania");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.cancel(id, body?.expectedVersion as number, { tenantId: principal.tenantId, actorUserId: principal.userId });
  }
}
