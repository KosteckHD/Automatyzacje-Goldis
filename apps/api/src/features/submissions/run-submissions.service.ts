import { randomUUID } from "node:crypto";
import { normalizeNip, normalizeRegon, todayInWarsaw } from "@goldis/core";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { type Transaction, UniqueConstraintError } from "sequelize";
import { normalizeBusinessName } from "../../contracts/registry-result";
import type { ImportBatch } from "../../infrastructure/database/db";
import type { AuditActorContext } from "../audit";
import { canAccessTool, type ToolPrincipal } from "../authorization/public";
import { assessEntityGrouping, EntityGroupingService } from "../grouping/public";
import { BusinessLeadService } from "../leads/public";
import { NotificationService } from "../notifications/public";
import { createLeadIdentityKey } from "../runs/public";
import {
  digestSubmissionValue as digest,
  parseRunSubmissionSelection as parseSelection,
  runSubmissionRequestHash as requestHash,
  type RunSubmissionSelection as Selection,
  type SelectionInput,
} from "./run-submission.dto";
import { RunSubmissionAccessRepository } from "./run-submission-access.repository";
import { RunSubmissionCancellationRepository } from "./run-submission-cancellation.repository";
import { RunSubmissionCreateRepository } from "./run-submission-create.repository";
import { RunSubmissionPreviewRepository } from "./run-submission-preview.repository";
import { RunSubmissionReadRepository } from "./run-submission-read.repository";

const toolId = "oc-policy-verification";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

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
  counts: {
    selected: number;
    ready: number;
    needsReview: number;
    excluded: number;
    uniqueGroups: number;
    alreadyActive: number;
  };
};

@Injectable()
export class RunSubmissionService {
  constructor(
    @Inject(EntityGroupingService) private readonly grouping: EntityGroupingService,
    @Inject(RunSubmissionReadRepository) private readonly readRepository: RunSubmissionReadRepository,
    @Inject(RunSubmissionCancellationRepository)
    private readonly cancellationRepository: RunSubmissionCancellationRepository,
    @Inject(RunSubmissionPreviewRepository) private readonly previewRepository: RunSubmissionPreviewRepository,
    @Inject(RunSubmissionAccessRepository) private readonly accessRepository: RunSubmissionAccessRepository,
    @Inject(RunSubmissionCreateRepository) private readonly createRepository: RunSubmissionCreateRepository,
    @Optional() @Inject(BusinessLeadService) private readonly leads?: BusinessLeadService,
    @Optional() @Inject(NotificationService) private readonly notifications?: NotificationService,
  ) {}

  private async assertCanExecute(
    actor: AuditActorContext & { sessionId?: string },
    role: string,
    batch: ImportBatch,
    transaction?: Transaction,
  ) {
    if (
      batch.toolId !== toolId ||
      batch.tenantId !== actor.tenantId ||
      (role !== "admin" && role !== "manager" && batch.ownerUserId !== actor.actorUserId)
    ) {
      throw new NotFoundException("Nie znaleziono importu");
    }
    if (role !== "admin" && role !== "manager" && role !== "operator")
      throw new ForbiddenException("Ta rola nie może uruchamiać automatyzacji");
    const principal: ToolPrincipal = {
      tenantId: actor.tenantId,
      userId: actor.actorUserId,
      role: role as ToolPrincipal["role"],
    };
    if (!transaction) {
      if (!(await canAccessTool(principal, batch.toolId, "execute")))
        throw new ForbiddenException("Brak prawa do uruchomienia narzędzia");
      return;
    }
    const { user, membership, session, tool, grant } = await this.accessRepository.findExecutionAccess(
      actor.tenantId,
      actor.actorUserId,
      batch.toolId,
      actor.sessionId,
      transaction,
    );
    const canExecute =
      membership?.role === "admin"
        ? tool?.status === "available"
        : Boolean(grant?.canExecute && tool?.status === "available");
    if (
      user?.status !== "active" ||
      membership?.status !== "active" ||
      membership.role !== role ||
      !canExecute ||
      (actor.sessionId &&
        (!session ||
          session.expiresAt.getTime() <= Date.now() ||
          session.credentialRevision !== user.credentialRevision))
    ) {
      throw new ForbiddenException("Konto, członkostwo lub prawo uruchomienia nie jest już aktywne");
    }
  }

  private async assertCanRead(actor: AuditActorContext, role: string, batch: ImportBatch) {
    if (batch.toolId !== toolId || batch.tenantId !== actor.tenantId) {
      throw new NotFoundException("Nie znaleziono importu");
    }
    if (role !== "admin" && role !== "manager" && role !== "operator") {
      throw new ForbiddenException("Ta rola nie może odczytać partii");
    }
    const principal: ToolPrincipal = {
      tenantId: actor.tenantId,
      userId: actor.actorUserId,
      role: role as ToolPrincipal["role"],
    };
    if (!(await canAccessTool(principal, batch.toolId, "view_results"))) {
      throw new ForbiddenException("Brak prawa do odczytu wyników");
    }
  }

  private async snapshot(
    batchId: string,
    selection: Selection,
    actor: AuditActorContext,
    role: string,
    transaction?: Transaction,
    lock = false,
    expectedPreparationId?: string,
    expectedReferenceDate?: string,
  ): Promise<PreviewSnapshot> {
    const batch = await this.previewRepository.findBatch(batchId, transaction, lock);
    if (!batch) throw new NotFoundException("Nie znaleziono importu");
    await this.assertCanExecute(actor, role, batch, transaction);
    const { rows, preparedBySourceId: preparedRows } = await this.previewRepository.loadRows(
      batchId,
      selection.rowNumbers,
      expectedPreparationId,
      transaction,
      lock,
    );
    if (rows.length !== selection.rowNumbers.length)
      throw new ConflictException("Część wskazanych wierszy nie należy do tego importu");
    const preparedBySourceId = preparedRows as NonNullable<typeof preparedRows>;
    const preparationId = preparedBySourceId.values().next().value?.preparationId ?? null;
    const nipValues = rows
      .map((row) => normalizeNip(row.nipRaw).normalized)
      .filter((value): value is string => Boolean(value));
    const regonValues = rows
      .map((row) => (row.effectiveRegon ? normalizeRegon(row.effectiveRegon).normalized : null))
      .filter((value): value is string => Boolean(value));
    const { corrections, conflicts, links, openRuns, candidates } = await this.previewRepository.loadSignals(
      batchId,
      actor.tenantId,
      rows,
      nipValues,
      regonValues,
      transaction,
      lock,
    );
    const pendingCorrectionIds = new Set(corrections.map((item) => item.sourceRowId));
    const openConflictIds = new Set(conflicts.map((item) => item.sourceRowId));
    const linkedBySource = new Map(links.map((item) => [item.sourceRowId, item.canonicalEntityId]));
    const activeBySource = new Map<string, typeof openRuns>();
    for (const run of openRuns)
      activeBySource.set(run.sourceRowId, [...(activeBySource.get(run.sourceRowId) ?? []), run]);
    const knownCandidates = candidates.map((candidate) => ({
      canonicalEntityId: candidate.canonicalEntityId,
      nipNormalized: candidate.nipNormalized,
      regon: candidate.regon,
      businessName: candidate.businessName,
    }));
    const virtualCandidates: typeof knownCandidates = [];
    const referenceDate = expectedReferenceDate ?? todayInWarsaw();
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) ||
      !Number.isFinite(new Date(`${referenceDate}T00:00:00.000Z`).getTime())
    ) {
      throw new ConflictException("Nieprawidłowa data zestawu");
    }
    const entries: SnapshotEntry[] = [];
    for (const row of rows) {
      let state: SnapshotEntry["state"] = "ready";
      let reasonCode: string | null = null;
      let groupKey: string | null = null;
      let groupProvisional = false;
      let alreadyActive = false;
      if (pendingCorrectionIds.has(row.id)) {
        state = "review";
        reasonCode = "PENDING_REGON_CORRECTION";
      } else if (openConflictIds.has(row.id)) {
        state = "review";
        reasonCode = "OPEN_ENTITY_CONFLICT";
      } else if (preparedBySourceId.get(row.id)?.status === "duplicate") {
        state = "excluded";
        reasonCode = "DUPLICATE_SOURCE_ROW";
      } else if (preparedBySourceId.get(row.id)?.status === "skipped_no_identifiers") {
        state = "excluded";
        reasonCode = "NO_NIP_OR_REGON";
      } else if (preparedBySourceId.get(row.id)?.status === "waiting_registry") {
        state = "excluded";
        reasonCode = "REGON_LOOKUP_REQUIRED";
      } else if (preparedBySourceId.get(row.id)?.status === "review") {
        state = "review";
        reasonCode = preparedBySourceId.get(row.id)?.reasonCode ?? "PREPARATION_REVIEW_REQUIRED";
      } else if (preparedBySourceId.get(row.id)?.status !== "ready") {
        state = "excluded";
        reasonCode = "PREPARATION_ROW_NOT_READY";
      } else if (row.issues.includes("DUPLICATE_SOURCE_ROW")) {
        state = "excluded";
        reasonCode = "DUPLICATE_SOURCE_ROW";
      } else if (!row.effectiveRegon || row.issues.length > 0) {
        state = "excluded";
        reasonCode = !row.effectiveRegon ? "REGON_REQUIRED" : "SOURCE_ROW_HAS_ISSUES";
      } else {
        const decision = assessEntityGrouping({
          nipRaw: row.nipRaw,
          effectiveRegon: row.effectiveRegon,
          companyName: row.companyName,
          candidates: [...knownCandidates, ...virtualCandidates],
        });
        if (decision.outcome === "conflict") {
          state = "review";
          reasonCode = decision.reasonCode;
        } else {
          const sourceLinkId = linkedBySource.get(row.id);
          if (sourceLinkId && decision.outcome === "link_existing" && sourceLinkId !== decision.canonicalEntityId) {
            state = "review";
            reasonCode = "SOURCE_LINK_MISMATCH";
          } else {
            let identityId: string;
            if (decision.outcome === "link_existing") identityId = decision.canonicalEntityId;
            else {
              identityId = `preview-${digest([decision.nipNormalized, decision.regon, normalizeBusinessName(decision.businessName)])}`;
              virtualCandidates.push({
                canonicalEntityId: identityId,
                nipNormalized: decision.nipNormalized,
                regon: decision.regon,
                businessName: decision.businessName,
              });
            }
            groupProvisional = identityId.startsWith("preview-");
            groupKey = createLeadIdentityKey(identityId, row.decisionMakerName);
            const active = activeBySource.get(row.id) ?? [];
            if (active.length) {
              if (active.some((run) => run.referenceDate.slice(0, 10) !== referenceDate)) {
                state = "review";
                reasonCode = "ACTIVE_RUN_REFERENCE_DATE_MISMATCH";
                groupKey = null;
              } else alreadyActive = true;
            }
          }
        }
      }
      entries.push({
        sourceRowId: row.id,
        rowNumber: row.rowNumber,
        expectedRowVersion: row.rowVersion,
        state,
        reasonCode,
        groupKey,
        groupProvisional,
        alreadyActive,
      });
    }
    const fingerprint = digest({
      batchId,
      preparationId,
      rowNumbers: selection.rowNumbers,
      referenceDate,
      entries: entries.map(
        ({ sourceRowId, rowNumber, expectedRowVersion, state, reasonCode, groupKey, alreadyActive: isActive }) => [
          sourceRowId,
          rowNumber,
          expectedRowVersion,
          state,
          reasonCode,
          groupKey,
          entries.find((entry) => entry.sourceRowId === sourceRowId)?.groupProvisional,
          isActive,
        ],
      ),
    });
    return {
      referenceDate,
      selectionFingerprint: fingerprint,
      entries,
      counts: {
        selected: entries.length,
        ready: entries.filter((entry) => entry.state === "ready").length,
        needsReview: entries.filter((entry) => entry.state === "review").length,
        excluded: entries.filter((entry) => entry.state === "excluded").length,
        uniqueGroups: new Set(
          entries.filter((entry) => entry.state === "ready" && entry.groupKey).map((entry) => entry.groupKey),
        ).size,
        alreadyActive: entries.filter((entry) => entry.state === "ready" && entry.alreadyActive).length,
      },
    };
  }

  async preview(
    batchId: string,
    input: SelectionInput,
    actor: AuditActorContext,
    role: string,
    expectedPreparationId?: string,
    expectedReferenceDate?: string,
  ) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new BadRequestException("Nieprawidłowy wybór wierszy");
    if (!uuidPattern.test(batchId)) throw new BadRequestException("Nieprawidłowy import");
    if (
      Object.keys(input).some(
        (key) => !["rowNumbers", "fromRow", "toRow", "selectionFingerprint", "idempotencyKey"].includes(key),
      )
    ) {
      throw new BadRequestException("Nieznane pole zgłoszenia uruchomienia");
    }
    const selectionInput: SelectionInput = {
      ...(Object.hasOwn(input, "rowNumbers") ? { rowNumbers: input.rowNumbers } : {}),
      ...(Object.hasOwn(input, "fromRow") ? { fromRow: input.fromRow } : {}),
      ...(Object.hasOwn(input, "toRow") ? { toRow: input.toRow } : {}),
    };
    const selection = parseSelection(selectionInput);
    const snapshot = await this.snapshot(
      batchId,
      selection,
      actor,
      role,
      undefined,
      false,
      expectedPreparationId,
      expectedReferenceDate,
    );
    return {
      importBatchId: batchId,
      referenceDate: snapshot.referenceDate,
      selectionFingerprint: snapshot.selectionFingerprint,
      counts: snapshot.counts,
      items: snapshot.entries.map(({ rowNumber, expectedRowVersion, state, reasonCode, alreadyActive }) => ({
        rowNumber,
        expectedRowVersion,
        state,
        reasonCode,
        alreadyActive,
      })),
    };
  }

  async create(
    batchId: string,
    input: SelectionInput & { selectionFingerprint?: unknown; idempotencyKey?: unknown },
    actor: AuditActorContext & { sessionId?: string },
    role: string,
    expectedPreparationId?: string,
    expectedReferenceDate?: string,
    parentResultSetId?: string,
  ) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new BadRequestException("Nieprawidłowe zgłoszenie uruchomienia");
    if (
      !uuidPattern.test(batchId) ||
      typeof input.selectionFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(input.selectionFingerprint) ||
      typeof input.idempotencyKey !== "string" ||
      !keyPattern.test(input.idempotencyKey)
    ) {
      throw new BadRequestException("Wymagane są wybór, podgląd i klucz idempotencji");
    }
    if (
      Object.keys(input).some(
        (key) => !["rowNumbers", "fromRow", "toRow", "selectionFingerprint", "idempotencyKey"].includes(key),
      )
    ) {
      throw new BadRequestException("Nieznane pole zgłoszenia uruchomienia");
    }
    const selection = parseSelection({
      ...(Object.hasOwn(input, "rowNumbers") ? { rowNumbers: input.rowNumbers } : {}),
      ...(Object.hasOwn(input, "fromRow") ? { fromRow: input.fromRow } : {}),
      ...(Object.hasOwn(input, "toRow") ? { toRow: input.toRow } : {}),
    });
    const hash = requestHash(batchId, selection);
    const prior = await this.createRepository.findByActorKey(
      actor.tenantId,
      actor.actorUserId,
      input.idempotencyKey as string,
    );
    if (prior) {
      if (prior.requestHash !== hash || prior.importBatchId !== batchId)
        throw new ConflictException("Ten klucz został użyty dla innego wyboru");
      return this.get(prior.submissionId, actor, role);
    }
    try {
      const submissionId = await this.createRepository.transaction(async (transaction) => {
        await this.createRepository.lockActor(actor.actorUserId, transaction);
        const settings = await this.createRepository.findToolSettings(actor.tenantId, toolId, transaction);
        if (!settings) throw new ConflictException("Narzędzie nie ma konfiguracji uruchomień");
        const batch = await this.createRepository.findBatch(batchId, transaction, true);
        if (!batch) throw new NotFoundException("Nie znaleziono importu");
        await this.assertCanExecute(actor, role, batch, transaction);
        const duplicate = await this.createRepository.findByActorKey(
          actor.tenantId,
          actor.actorUserId,
          input.idempotencyKey as string,
          transaction,
          true,
        );
        if (duplicate) {
          if (duplicate.requestHash !== hash || duplicate.importBatchId !== batchId)
            throw new ConflictException("Ten klucz został użyty dla innego wyboru");
          return duplicate.submissionId;
        }
        const snapshot = await this.snapshot(
          batchId,
          selection,
          actor,
          role,
          transaction,
          true,
          expectedPreparationId,
          expectedReferenceDate,
        );
        if (snapshot.selectionFingerprint !== input.selectionFingerprint)
          throw new ConflictException("Wiersze lub grupowanie zmieniły się; odśwież podsumowanie");

        const resolved = new Map<number, { canonicalEntityId: string; leadIdentityKey: string; sourceRowId: string }>();
        for (const entry of snapshot.entries.filter((item) => item.state === "ready")) {
          const outcomes = await this.grouping.resolveRelatedRows(batchId, entry.rowNumber, transaction);
          const selected = outcomes.find((outcome) => outcome.rowNumber === entry.rowNumber);
          if (selected?.status !== "linked")
            throw new ConflictException("Grupowanie zmieniło się; odśwież podsumowanie");
          const link = await this.createRepository.findEntityLink(selected.sourceRowId, actor.tenantId, transaction);
          const row = await this.createRepository.findSourceRow(selected.sourceRowId, transaction);
          const canonical = await this.createRepository.findCanonicalEntity(
            selected.canonicalEntityId,
            actor.tenantId,
            transaction,
          );
          if (
            !link ||
            !row ||
            !canonical?.regon ||
            row.effectiveRegon !== canonical.regon ||
            row.issues.length > 0 ||
            normalizeBusinessName(row.companyName) !== normalizeBusinessName(canonical.businessName)
          ) {
            throw new ConflictException("Grupowanie zmieniło się; odśwież podsumowanie");
          }
          const actualLeadKey = createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName);
          resolved.set(entry.rowNumber, {
            canonicalEntityId: canonical.canonicalEntityId,
            leadIdentityKey: actualLeadKey,
            sourceRowId: row.id,
          });
          if (actualLeadKey !== entry.groupKey && !entry.groupProvisional) {
            throw new ConflictException("Tożsamość grupy zmieniła się; odśwież podsumowanie");
          }
        }
        const expectedToActual = new Map<string, string>();
        const actualToExpected = new Map<string, string>();
        for (const entry of snapshot.entries.filter((item) => item.state === "ready")) {
          const value = resolved.get(entry.rowNumber);
          const expectedGroupKey = entry.groupKey;
          if (!value || !expectedGroupKey) throw new ConflictException("Grupowanie zmieniło się; odśwież podsumowanie");
          const actual = `${value.canonicalEntityId}:${value.leadIdentityKey}`;
          const priorActual = expectedToActual.get(expectedGroupKey);
          const priorExpected = actualToExpected.get(actual);
          if ((priorActual && priorActual !== actual) || (priorExpected && priorExpected !== expectedGroupKey)) {
            throw new ConflictException("Grupowanie różni się od podglądu; odśwież podsumowanie");
          }
          expectedToActual.set(expectedGroupKey, actual);
          actualToExpected.set(actual, expectedGroupKey);
        }

        const now = new Date();
        const submissionId = randomUUID();
        const resultSetId = parentResultSetId ?? randomUUID();
        if (parentResultSetId) {
          const parent = await this.createRepository.findParentResultSet(
            parentResultSetId,
            actor.tenantId,
            transaction,
          );
          if (
            parent?.sourceType !== "prepared_set_execution" ||
            parent.batchId !== batchId ||
            parent.actorUserId !== actor.actorUserId ||
            !["queued", "running", "waiting_attention"].includes(parent.status)
          ) {
            throw new ConflictException("Wykonanie całego importu nie przyjmuje już kolejnych paczek");
          }
        } else {
          await this.createRepository.createResultSet(
            {
              resultSetId,
              tenantId: actor.tenantId,
              batchId,
              toolId: batch.toolId,
              actorUserId: actor.actorUserId,
              sourceType: "run_submission",
              sourceId: submissionId,
              referenceDate: snapshot.referenceDate,
              status: "queued",
              createdAt: now,
              updatedAt: now,
              finishedAt: null,
            },
            transaction,
          );
        }
        const submission = await this.createRepository.createSubmission(
          {
            submissionId,
            importBatchId: batchId,
            tenantId: actor.tenantId,
            toolId: batch.toolId,
            actorUserId: actor.actorUserId,
            idempotencyKey: input.idempotencyKey as string,
            requestHash: hash,
            referenceDate: snapshot.referenceDate,
            resultSetId,
            status: "queued",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
          transaction,
        );
        const groups = new Map<string, string>();
        for (const entry of snapshot.entries.filter((item) => item.state === "ready")) {
          const value = resolved.get(entry.rowNumber);
          if (!value) throw new ConflictException("Grupowanie zmieniło się; odśwież podsumowanie");
          const actual = `${value.canonicalEntityId}:${value.leadIdentityKey}`;
          if (!groups.has(actual)) {
            const groupId = randomUUID();
            groups.set(actual, groupId);
            await this.createRepository.createGroup(
              {
                groupId,
                submissionId: submission.submissionId,
                tenantId: actor.tenantId,
                canonicalEntityId: value.canonicalEntityId,
                leadIdentityKey: value.leadIdentityKey,
                runId: null,
                admissionState: "pending",
                reasonCode: null,
                nextAttemptAt: now,
                leaseOwner: null,
                leaseExpiresAt: null,
                version: 1,
                createdAt: now,
                updatedAt: now,
              },
              transaction,
            );
          }
        }
        await this.createRepository.createItems(
          snapshot.entries.map((entry) => {
            const value = resolved.get(entry.rowNumber);
            const groupId = value ? (groups.get(`${value.canonicalEntityId}:${value.leadIdentityKey}`) ?? null) : null;
            return {
              itemId: randomUUID(),
              submissionId: submission.submissionId,
              importBatchId: batchId,
              sourceRowId: entry.sourceRowId,
              groupId,
              expectedRowVersion: entry.expectedRowVersion,
              preparationState: entry.state,
              reasonCode: entry.reasonCode,
              createdAt: now,
            };
          }),
          transaction,
        );
        await this.leads?.attachSubmissionGroups(
          resultSetId,
          [...groups.entries()].map(([identity, groupId]) => {
            const separator = identity.indexOf(":");
            return {
              groupId,
              canonicalEntityId: identity.slice(0, separator),
              leadIdentityKey: identity.slice(separator + 1),
            };
          }),
          transaction,
        );
        await this.createRepository.recordCreated(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.actorUserId,
            action: "run.submission.created",
            resourceType: "run_submission",
            resourceId: submission.submissionId,
            outcome: "succeeded",
            metadata: {
              selectedRows: snapshot.counts.selected,
              readyRows: snapshot.counts.ready,
              uniqueGroups: groups.size,
              referenceDate: snapshot.referenceDate,
            },
          },
          transaction,
        );
        return submission.submissionId;
      });
      return this.get(submissionId, actor, role);
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) throw error;
      const concurrent = await this.createRepository.findByActorKey(
        actor.tenantId,
        actor.actorUserId,
        input.idempotencyKey as string,
      );
      if (!concurrent) throw error;
      if (concurrent.requestHash !== hash || concurrent.importBatchId !== batchId)
        throw new ConflictException("Ten klucz został użyty dla innego wyboru");
      return this.get(concurrent.submissionId, actor, role);
    }
  }

  /** Idempotent internal child creation for a frozen prepared-set chunk. */
  async createPreparedSetChunk(
    input: Readonly<{
      batchId: string;
      rowNumbers: readonly number[];
      preparationId: string;
      referenceDate: string;
      resultSetId: string;
      idempotencyKey: string;
      actor: AuditActorContext;
      role: string;
    }>,
  ) {
    const selection: Selection = { rowNumbers: [...input.rowNumbers].sort((a, b) => a - b) };
    const hash = requestHash(input.batchId, selection);
    const prior = await this.createRepository.findByActorKey(
      input.actor.tenantId,
      input.actor.actorUserId,
      input.idempotencyKey,
    );
    if (prior) {
      if (
        prior.requestHash !== hash ||
        prior.importBatchId !== input.batchId ||
        prior.resultSetId !== input.resultSetId
      ) {
        throw new ConflictException("Klucz paczki został użyty dla innego zestawu");
      }
      return this.get(prior.submissionId, input.actor, input.role);
    }
    const preview = await this.preview(
      input.batchId,
      selection,
      input.actor,
      input.role,
      input.preparationId,
      input.referenceDate,
    );
    return this.create(
      input.batchId,
      { ...selection, selectionFingerprint: preview.selectionFingerprint, idempotencyKey: input.idempotencyKey },
      input.actor,
      input.role,
      input.preparationId,
      input.referenceDate,
      input.resultSetId,
    );
  }

  findVersion(id: string) {
    return this.readRepository.findSubmissionVersion(id);
  }

  async get(id: string, actor: AuditActorContext, role: string) {
    if (!uuidPattern.test(id)) throw new BadRequestException("Nieprawidłowa partia");
    const submission = await this.readRepository.findSubmission(id, actor.tenantId);
    if (!submission) throw new NotFoundException("Nie znaleziono partii");
    const batch = await this.readRepository.findBatch(submission.importBatchId);
    if (!batch) throw new NotFoundException("Nie znaleziono partii");
    await this.assertCanRead(actor, role, batch);
    const state = await this.readRepository.countState(submission);
    const resultSetId = submission.resultSetId;
    if (resultSetId) {
      const resultSet = await this.readRepository.findResultSet(resultSetId);
      if (resultSet?.sourceType === "run_submission") {
        if (state.status === "completed" || state.status === "cancelled") {
          await this.readRepository.transaction(
            (transaction) =>
              this.leads?.completeResultSet(
                resultSetId,
                state.status === "completed" ? "completed" : "cancelled",
                transaction,
              ) ?? Promise.resolve(),
          );
        } else if (state.status === "waiting_attention") {
          await this.readRepository.transaction(async (transaction) => {
            const current = await this.readRepository.lockResultSet(resultSetId, transaction);
            if (!current || ["completed", "cancelled", "failed"].includes(current.status)) return;
            const enteringAttention = current.status !== "waiting_attention";
            current.status = "waiting_attention";
            current.updatedAt = new Date();
            await this.readRepository.saveResultSet(current, transaction);
            if (enteringAttention)
              await this.notifications?.recordResultSetEvent(current, "action_required", transaction);
          });
        } else {
          const status = state.status === "running" ? "running" : "queued";
          await this.readRepository.updateActiveResultSet(resultSetId, status);
        }
      }
    }
    const [groupTotal, itemTotal] = await this.readRepository.countTotals(submission.submissionId);
    return {
      submissionId: submission.submissionId,
      importBatchId: submission.importBatchId,
      toolId: submission.toolId,
      referenceDate: submission.referenceDate,
      status: state.status,
      version: submission.version,
      counts: { items: state.itemCounts, groups: state.groupCounts, selectedRows: itemTotal, uniqueGroups: groupTotal },
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    };
  }

  async listItems(id: string, cursor: string | undefined, actor: AuditActorContext, role: string) {
    const submission = await this.readRepository.findSubmission(id, actor.tenantId);
    if (!submission) throw new NotFoundException("Nie znaleziono partii");
    const batch = await this.readRepository.findBatch(submission.importBatchId);
    if (!batch) throw new NotFoundException("Nie znaleziono partii");
    await this.assertCanRead(actor, role, batch);
    let after: { rowNumber: number; sourceRowId: string } | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
          parsed?.submissionId !== id ||
          !Number.isSafeInteger(parsed?.rowNumber) ||
          !uuidPattern.test(parsed?.sourceRowId)
        )
          throw new Error();
        after = { rowNumber: parsed.rowNumber, sourceRowId: parsed.sourceRowId };
      } catch {
        throw new BadRequestException("Nieprawidłowy kursor partii");
      }
    }
    const items = await this.readRepository.listItems(id, after);
    const hasMore = items.length > 50;
    const page = items.slice(0, 50);
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ submissionId: id, rowNumber: last.rowNumber, sourceRowId: last.sourceRowId }),
            "utf8",
          ).toString("base64url")
        : null;
    return { items: page, nextCursor };
  }

  async cancel(id: string, expectedVersion: number, actor: AuditActorContext & { sessionId?: string }, role: string) {
    if (!uuidPattern.test(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new BadRequestException("Nieprawidłowa wersja partii");
    return this.cancellationRepository.withLockedSubmission(id, actor, async (submission, batch, transaction) => {
      if (role !== "admin" && role !== "manager" && submission.actorUserId !== actor.actorUserId)
        throw new NotFoundException("Nie znaleziono partii");
      await this.assertCanExecute(actor, role, batch, transaction);
      if (submission.version !== expectedVersion) throw new ConflictException("Partia została zmieniona; odśwież stan");
      if (submission.status === "cancelled")
        return { submissionId: id, status: "cancelled", version: submission.version };
      const now = new Date();
      await this.cancellationRepository.cancelUnadmittedGroups(id, now, transaction);
      submission.status = "cancelled";
      submission.version += 1;
      submission.updatedAt = now;
      await this.cancellationRepository.saveSubmission(submission, transaction);
      await this.cancellationRepository.recordCancelled(id, actor, transaction);
      return {
        submissionId: id,
        status: "cancelled",
        version: submission.version,
        acceptedRunsContinue: await this.cancellationRepository.hasAcceptedRuns(id, transaction),
      };
    });
  }
}
