import { normalizeNip, normalizeRegon } from "@goldis/core";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Transaction } from "sequelize";
import { sanitizePublicFileName, sanitizePublicText } from "../../infrastructure/http";
import {
  createListCursor,
  filterFingerprint,
  parseIsoDateTime,
  parseListCursor,
  parseListLimit,
  parseToolId,
  parseUuidFilter,
  validateDateRange,
} from "../../shared/list-query";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { assessEntityGrouping, EntityGroupingService } from "../grouping/public";
import { parseConflictResolutionRequest, parseCorrectionDecisionRequest } from "./review.dto";
import {
  type ReviewQueueFilters,
  type ReviewImportOption,
  ReviewRepository,
  type ReviewSourceLinkRecord,
  type ReviewSourceRowRecord,
} from "./review.repository";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const correctionStatuses = new Set(["pending", "approved", "rejected"]);
const conflictStatuses = new Set(["open", "resolved"]);

type QueueInput = Readonly<{
  status?: string;
  batchId?: string;
  toolId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
  search?: string;
}>;
type QueuePrincipal = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;
function parseQueue(input: QueueInput, listName: string, statuses: Set<string>, defaultStatus: string | undefined) {
  const status = input.status === undefined || input.status === "" ? defaultStatus : input.status;
  if (status && !statuses.has(status)) throw new BadRequestException("Nieprawidłowy status kolejki");
  const batchId = parseUuidFilter(input.batchId, "batchId");
  const toolId = parseToolId(input.toolId);
  const from = parseIsoDateTime(input.from, "from");
  const to = parseIsoDateTime(input.to, "to");
  validateDateRange(from, to);
  const limit = parseListLimit(input.limit);
  const fingerprint = filterFingerprint(listName, { status, batchId, toolId, from, to, limit });
  const cursor = parseListCursor(input.cursor, fingerprint);
  const filters: ReviewQueueFilters = { status, batchId, toolId, from, to };
  return { limit, fingerprint, cursor, filters };
}

function pageResult<T extends { id: string; created_at?: Date | string; createdAt?: Date | string }>(
  rows: T[],
  limit: number,
  fingerprint: string,
) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const publicItems = items.map((item) => {
    const { created_at: _cursorTimestamp, ...publicItem } = item;
    return publicItem;
  });
  const lastTimestamp = last?.created_at ?? last?.createdAt;
  return {
    items: publicItems,
    nextCursor:
      hasMore && last && lastTimestamp !== undefined ? createListCursor(lastTimestamp, last.id, fingerprint) : null,
    hasMore,
    limit,
  };
}

@Injectable()
export class ReviewService {
  constructor(
    @Inject(EntityGroupingService) private readonly grouping: EntityGroupingService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReviewRepository) private readonly repository: ReviewRepository,
  ) {}

  async listCorrections(actor: QueuePrincipal, input: QueueInput, ownOnly = false) {
    const parsed = parseQueue(
      input,
      ownOnly ? "my-corrections" : "review-corrections",
      correctionStatuses,
      ownOnly ? undefined : "pending",
    );
    try {
      const rows = await this.repository.listCorrections({
        ...actor,
        filters: parsed.filters,
        cursor: parsed.cursor,
        limit: parsed.limit,
        ownOnly,
      });
      return pageResult(
        rows.map((row) => ({
          id: row.id,
          created_at: row.created_at,
          status: row.status,
          createdAt: row.created_at,
          reviewedAt: row.reviewed_at,
          reviewReason: row.review_reason,
          previousRegon: row.previous_regon,
          proposedRegon: row.proposed_regon,
          reason: sanitizePublicText(row.reason),
          rowNumber: Number(row.row_number),
          rowVersion: Number(row.row_version),
          companyName: sanitizePublicText(row.company_name),
          batchId: row.batch_id,
          toolId: row.tool_id,
        })),
        parsed.limit,
        parsed.fingerprint,
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("Kolejka korekt jest chwilowo niedostępna");
    }
  }

  async listImportOptions(actor: QueuePrincipal, input: QueueInput, queue: "corrections" | "conflicts", ownOnly = false) {
    const search = input.search?.trim() ?? "";
    if (search.length > 120) throw new BadRequestException("Fraza wyszukiwania może mieć maksymalnie 120 znaków");
    const allowedStatuses = queue === "conflicts" ? conflictStatuses : correctionStatuses;
    const defaultStatus = ownOnly ? undefined : queue === "conflicts" ? "open" : "pending";
    const status = input.status === undefined || input.status === "" ? defaultStatus : input.status;
    if (status && !allowedStatuses.has(status)) throw new BadRequestException("Nieprawidłowy status kolejki");
    const toolId = parseToolId(input.toolId);
    const limit = parseListLimit(input.limit);
    if (limit > 50) throw new BadRequestException("Limit opcji importu nie może przekraczać 50");
    const fingerprint = filterFingerprint(`review-import-options:${queue}:${ownOnly ? "own" : "scoped"}`, { search, toolId, status, limit });
    const cursor = parseListCursor(input.cursor, fingerprint);
    const filters: ReviewQueueFilters = { search, ...(status ? { status } : {}), ...(toolId ? { toolId } : {}) };
    let rows: ReviewImportOption[];
    try {
      rows = await this.repository.listImportOptions({ ...actor, filters, cursor, limit, queue, ownOnly });
    } catch {
      throw new ServiceUnavailableException("Lista dostępnych importów jest chwilowo niedostępna");
    }
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items: items.map((row) => ({ batchId: row.batch_id, fileName: sanitizePublicFileName(row.file_name), toolId: row.tool_id, createdAt: new Date(row.created_at).toISOString() })),
      nextCursor: hasMore && last ? createListCursor(last.created_at, last.batch_id, fingerprint) : null,
    };
  }

  async listConflicts(actor: QueuePrincipal, input: QueueInput) {
    const parsed = parseQueue(input, "review-conflicts", conflictStatuses, "open");
    try {
      const { rows, candidates } = await this.repository.listConflicts({
        ...actor,
        filters: parsed.filters,
        cursor: parsed.cursor,
        limit: parsed.limit,
      });
      const candidateById = new Map(candidates.map((candidate) => [candidate.canonicalEntityId, candidate]));
      const items = rows.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        status: row.status,
        createdAt: row.created_at,
        reasonCode: row.reason_code,
        rowNumber: Number(row.row_number),
        rowVersion: Number(row.row_version),
        companyName: sanitizePublicText(row.company_name),
        effectiveRegon: row.effective_regon,
        batchId: row.batch_id,
        toolId: row.tool_id,
        candidates: (Array.isArray(row.candidate_entity_ids) ? row.candidate_entity_ids : []).flatMap((id) => {
          const candidate = candidateById.get(id);
          return candidate
            ? [{ id, businessName: sanitizePublicText(candidate.businessName), regon: candidate.regon }]
            : [];
        }),
      }));
      return pageResult(items, parsed.limit, parsed.fingerprint);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("Kolejka konfliktów jest chwilowo niedostępna");
    }
  }

  async decideCorrection(correctionId: string, actor: QueuePrincipal, body: unknown) {
    const input = parseCorrectionDecisionRequest(body);
    if (!uuidPattern.test(correctionId)) throw new BadRequestException("Nieprawidłowa decyzja korekty");
    const route = await this.repository.correctionRoute(correctionId);
    if (!route) throw new NotFoundException();

    return this.repository.withTransaction(async (transaction) => {
      const batch = await this.repository.lockBatch(route.batchId, transaction);
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException();
      if (!(await this.repository.reviewGrantAllowed({ ...actor, toolId: batch.toolId }, transaction)))
        throw new NotFoundException();
      const row = await this.repository.lockSourceRow(route.sourceRowId, transaction);
      const correction = await this.repository.lockCorrection(correctionId, transaction);
      if (!row || !correction || row.batchId !== batch.id || correction.sourceRowId !== row.id)
        throw new NotFoundException();
      if (correction.status !== "pending") throw new ConflictException("Korekta została już rozpatrzona");
      if (row.rowVersion !== input.expectedRowVersion)
        throw new ConflictException("Wiersz zmienił się; odśwież kolejkę przed decyzją");
      const link = await this.repository.lockSourceLink(row.id, transaction);
      const blocker = await this.repository.reviewWriteBlocker(
        row.id,
        link?.canonicalEntityId ?? null,
        actor.tenantId,
        transaction,
      );
      if (blocker === "canonical_missing") throw new NotFoundException();
      if (blocker === "run_exists")
        throw new ConflictException("Decyzja jest zablokowana, ponieważ wiersz lub encja ma już przypisane zadanie");

      const now = new Date();
      await this.repository.updateCorrection(
        correctionId,
        {
          status: input.decision,
          reviewerRef: actor.userId,
          reviewedAt: now,
          reviewReason: input.reasonCode,
        },
        transaction,
      );
      let rowVersion = row.rowVersion + 1;
      let effectiveRegon = row.effectiveRegon;
      let issues = [...row.issues];

      if (input.decision === "approved") {
        const normalized = normalizeRegon(correction.proposedRegon);
        if (!normalized.normalized || normalized.issues.length)
          throw new ConflictException("Proponowany REGON wymaga ponownej weryfikacji");
        effectiveRegon = normalized.normalized;
        issues = issues.filter((issue) => !issue.startsWith("REGON_"));
        const updatedRow = { ...row, effectiveRegon, issues, rowVersion };
        await this.repository.updateSourceRow(row.id, { effectiveRegon, issues, rowVersion }, transaction);
        if (link) await this.updateSoleLinkedEntity(updatedRow, link, transaction);
        const grouping = await this.grouping.resolveSourceRow(batch.id, row.rowNumber, transaction);
        rowVersion = grouping.rowVersion;
      } else {
        await this.repository.updateSourceRow(row.id, { issues, rowVersion }, transaction);
      }

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "regon.correction.reviewed",
          resourceType: "correction",
          resourceId: correction.correctionId,
          outcome: "succeeded",
          metadata: { decision: input.decision, reasonCode: input.reasonCode },
        },
        transaction,
      );
      return {
        correctionId: correction.correctionId,
        decision: input.decision,
        rowNumber: row.rowNumber,
        rowVersion,
        effectiveRegon,
        grouping: input.decision === "approved" ? "rechecked" : "unchanged",
      };
    });
  }

  async resolveConflict(conflictId: string, actor: QueuePrincipal, body: unknown) {
    const input = parseConflictResolutionRequest(body);
    const action = input.action;
    if (!uuidPattern.test(conflictId)) throw new BadRequestException("Nieprawidłowe rozstrzygnięcie konfliktu");
    const route = await this.repository.conflictRoute(conflictId);
    if (!route) throw new NotFoundException();

    return this.repository.withTransaction(async (transaction) => {
      const batch = await this.repository.lockBatch(route.batchId, transaction);
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException();
      if (!(await this.repository.reviewGrantAllowed({ ...actor, toolId: batch.toolId }, transaction)))
        throw new NotFoundException();
      const row = await this.repository.lockSourceRow(route.sourceRowId, transaction);
      const conflict = await this.repository.lockConflict(conflictId, transaction);
      if (!row || !conflict || row.batchId !== batch.id || conflict.sourceRowId !== row.id)
        throw new NotFoundException();
      if (conflict.status !== "open") throw new ConflictException("Konflikt został już rozstrzygnięty");
      if (row.rowVersion !== input.expectedRowVersion)
        throw new ConflictException("Wiersz zmienił się; odśwież kolejkę przed decyzją");
      const link = await this.repository.lockSourceLink(row.id, transaction);
      const blocker = await this.repository.reviewWriteBlocker(
        row.id,
        link?.canonicalEntityId ?? null,
        actor.tenantId,
        transaction,
      );
      if (blocker === "canonical_missing") throw new NotFoundException();
      if (blocker === "run_exists")
        throw new ConflictException("Decyzja jest zablokowana, ponieważ wiersz lub encja ma już przypisane zadanie");
      const now = new Date();
      await this.repository.updateConflict(
        conflictId,
        {
          status: "resolved",
          resolutionNote: input.reasonCode,
          resolvedBy: actor.userId,
          resolvedAt: now,
        },
        transaction,
      );
      let rowVersion = row.rowVersion + 1;
      let issues = [...row.issues];

      if (action === "link_existing") {
        const candidateId = input.canonicalEntityId;
        const allowedCandidates = Array.isArray(conflict.candidateEntityIds) ? conflict.candidateEntityIds : [];
        if (!allowedCandidates.includes(candidateId))
          throw new ConflictException("Wybrana encja nie jest kandydatem tego konfliktu");
        const candidate = await this.repository.lockCandidate(candidateId, actor.tenantId, transaction);
        if (!candidate) throw new NotFoundException();
        const candidateBlocker = await this.repository.reviewWriteBlocker(
          row.id,
          candidate.canonicalEntityId,
          actor.tenantId,
          transaction,
        );
        if (candidateBlocker === "canonical_missing") throw new NotFoundException();
        if (candidateBlocker === "run_exists")
          throw new ConflictException("Decyzja jest zablokowana, ponieważ wiersz lub encja ma już przypisane zadanie");
        const decision = assessEntityGrouping({
          nipRaw: row.nipRaw,
          effectiveRegon: row.effectiveRegon,
          companyName: row.companyName,
          candidates: [
            {
              canonicalEntityId: candidate.canonicalEntityId,
              nipNormalized: candidate.nipNormalized,
              regon: candidate.regon,
              businessName: candidate.businessName,
            },
          ],
        });
        if (decision.outcome !== "link_existing" || decision.canonicalEntityId !== candidateId) {
          throw new ConflictException(
            "Identyfikatory firmy nie uzasadniają połączenia; rozpatrz korektę REGON lub ponowną kontrolę",
          );
        }
        const method = link
          ? "manual"
          : await this.grouping.matchMethodForReview(row, decision.nipNormalized, decision.regon, transaction);
        await this.repository.saveSourceLink(
          row.id,
          {
            sourceRowId: row.id,
            tenantId: actor.tenantId,
            canonicalEntityId: candidateId,
            matchMethod: method,
            linkedAt: now,
          },
          Boolean(link),
          transaction,
        );
        issues = issues.filter((issue) => issue !== "ENTITY_LINK_REJECTED");
      } else if (action === "reject_link") {
        if (
          link &&
          (Array.isArray(conflict.candidateEntityIds) ? conflict.candidateEntityIds : []).includes(
            link.canonicalEntityId,
          )
        ) {
          await this.repository.deleteSourceLink(row.id, transaction);
        }
        issues = [...new Set([...issues, "ENTITY_LINK_REJECTED"])];
      }
      await this.repository.updateSourceRow(row.id, { rowVersion, issues }, transaction);

      let grouping: string =
        action === "link_existing" ? "linked" : action === "reject_link" ? "link_rejected" : "rechecked";
      if (action === "recheck") {
        issues = issues.filter((issue) => issue !== "ENTITY_LINK_REJECTED");
        await this.repository.updateSourceRow(row.id, { rowVersion, issues }, transaction);
        const outcome = await this.grouping.resolveSourceRow(batch.id, row.rowNumber, transaction);
        grouping = outcome.status;
        rowVersion = outcome.rowVersion;
      }
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "entity.conflict.reviewed",
          resourceType: "entity_conflict",
          resourceId: conflict.conflictId,
          outcome: "succeeded",
          metadata: { decision: action, reasonCode: input.reasonCode },
        },
        transaction,
      );
      return {
        conflictId: conflict.conflictId,
        decision: action,
        rowNumber: row.rowNumber,
        rowVersion,
        grouping,
      };
    });
  }

  private async updateSoleLinkedEntity(
    row: ReviewSourceRowRecord,
    link: ReviewSourceLinkRecord,
    transaction: Transaction,
  ) {
    const entity = await this.repository.lockCanonicalEntity(link.canonicalEntityId, link.tenantId, transaction);
    if (!entity) throw new NotFoundException();
    const linkedRows = await this.repository.countCanonicalLinks(link.canonicalEntityId, link.tenantId, transaction);
    if (linkedRows !== 1) return;
    const regon = row.effectiveRegon ? normalizeRegon(row.effectiveRegon).normalized : null;
    if (!regon) throw new ConflictException("Encja wymaga poprawnego REGON-u po zatwierdzeniu korekty");
    const nip = normalizeNip(row.nipRaw).normalized;
    const updated = {
      regon,
      nipNormalized: nip ?? entity.nipNormalized,
      businessName: row.companyName,
      updatedAt: new Date(),
    };
    try {
      await this.repository.updateCanonicalEntity(link.canonicalEntityId, link.tenantId, updated, transaction);
    } catch {
      throw new ConflictException(
        "REGON koliduje z inną encją w tym tenancie; wymagane jest rozstrzygnięcie konfliktu",
      );
    }
  }
}
