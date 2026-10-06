import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import { normalizeNip, normalizeRegon } from "@goldis/core";
import {
  AutomationRun, CanonicalEntity, EntityGroupingConflict, ImportBatch, RegonCorrection, sequelize,
  SourceEntityLink, SourceRow,
} from "./db";
import { assessEntityGrouping } from "./entity-grouping";
import { EntityGroupingService } from "./entity-grouping-service";
import { operationalCollectionScope } from "./resource-scope";
import {
  createListCursor, filterFingerprint, parseIsoDateTime, parseListCursor, parseListLimit,
  parseToolId, parseUuidFilter, validateDateRange,
} from "./list-query";
import { recordAuditEvent } from "./audit";
import { sanitizePublicText } from "./public-output";
import type { SessionPrincipal } from "./session";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const correctionStatuses = new Set(["pending", "approved", "rejected"]);
const conflictStatuses = new Set(["open", "resolved"]);
const correctionReasonCodes = new Set(["SOURCE_DOCUMENT_VERIFIED", "REGISTRY_MATCH_VERIFIED", "DUPLICATE_IMPORT", "OTHER"]);
const conflictReasonCodes = new Set(["IDENTIFIERS_VERIFIED", "SOURCE_DATA_UPDATED", "CANDIDATE_REJECTED"]);

type QueueInput = Readonly<{
  status?: string; batchId?: string; toolId?: string; from?: string; to?: string; cursor?: string; limit?: string;
}>;
type QueuePrincipal = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;
type QueueConfig = Readonly<{ table: "regon_corrections" | "entity_grouping_conflicts"; idColumn: "correction_id" | "conflict_id"; listName: string }>;

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
  const replacements: Record<string, string | number> = { limit: limit + 1 };
  if (status) replacements.status = status;
  if (batchId) replacements.batchId = batchId;
  if (toolId) replacements.toolId = toolId;
  if (from) replacements.from = from;
  if (to) replacements.to = to;
  if (cursor) {
    replacements.cursorCreatedAt = cursor.createdAt;
    replacements.cursorId = cursor.id;
  }
  return { limit, fingerprint, cursor, replacements, filters: { status, batchId, toolId, from, to } };
}

function appendFilters(conditions: string[], filters: ReturnType<typeof parseQueue>["filters"]) {
  if (filters.status) conditions.push("q.status = :status");
  if (filters.batchId) conditions.push("b.id = :batchId");
  if (filters.toolId) conditions.push("b.tool_id = :toolId");
  if (filters.from) conditions.push("q.created_at >= :from");
  if (filters.to) conditions.push("q.created_at <= :to");
}

function pageResult<T extends { id: string; created_at?: Date | string; createdAt?: Date | string }>(
  rows: T[], limit: number, fingerprint: string,
) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const publicItems = items.map((item) => {
    const { created_at: _cursorTimestamp, ...publicItem } = item;
    return publicItem;
  });
  return {
    items: publicItems,
    nextCursor: hasMore && last ? createListCursor(last.created_at ?? last.createdAt!, last.id, fingerprint) : null,
    hasMore,
    limit,
  };
}

function strictBody(body: unknown, allowed: readonly string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Nieprawidłowe dane decyzji");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in (body as object)))) {
    throw new BadRequestException("Dane decyzji zawierają niedozwolone lub brakujące pola");
  }
}

@Injectable()
export class ReviewService {
  constructor(private readonly grouping: EntityGroupingService) {}

  async listCorrections(actor: QueuePrincipal, input: QueueInput, ownOnly = false) {
    const parsed = parseQueue(input, ownOnly ? "my-corrections" : "review-corrections", correctionStatuses, ownOnly ? undefined : "pending");
    const replacements = { ...parsed.replacements, tenantId: actor.tenantId, userId: actor.userId };
    const conditions = [operationalCollectionScope(actor.role)];
    appendFilters(conditions, parsed.filters);
    if (ownOnly) conditions.push("q.author_ref = :userId");
    if (parsed.cursor) conditions.push("(q.created_at, q.correction_id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    const sql = `SELECT q.correction_id AS id, q.status, q.created_at, q.previous_regon, q.proposed_regon,
        q.reason, s.row_number, s.row_version, s.company_name, b.id AS batch_id, b.tool_id
      FROM regon_corrections q
      JOIN source_rows s ON s.id = q.source_row_id
      JOIN import_batches b ON b.id = s.batch_id
      JOIN tools t ON t.tool_id = b.tool_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY q.created_at DESC, q.correction_id DESC LIMIT :limit`;
    try {
      const rows = await sequelize.query<{
        id: string; status: string; created_at: Date | string; previous_regon: string | null; proposed_regon: string;
        reason: string; row_number: number; row_version: number; company_name: string; batch_id: string; tool_id: string;
      }>(sql, { replacements, type: QueryTypes.SELECT });
      return pageResult(rows.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        status: row.status,
        createdAt: row.created_at,
        previousRegon: row.previous_regon,
        proposedRegon: row.proposed_regon,
        reason: sanitizePublicText(row.reason),
        rowNumber: Number(row.row_number),
        rowVersion: Number(row.row_version),
        companyName: sanitizePublicText(row.company_name),
        batchId: row.batch_id,
        toolId: row.tool_id,
      })), parsed.limit, parsed.fingerprint);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("Kolejka korekt jest chwilowo niedostępna");
    }
  }

  async listConflicts(actor: QueuePrincipal, input: QueueInput) {
    const parsed = parseQueue(input, "review-conflicts", conflictStatuses, "open");
    const replacements = { ...parsed.replacements, tenantId: actor.tenantId, userId: actor.userId };
    const conditions = [operationalCollectionScope(actor.role)];
    appendFilters(conditions, parsed.filters);
    if (parsed.cursor) conditions.push("(q.created_at, q.conflict_id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    try {
      const rows = await sequelize.query<{
        id: string; status: string; created_at: Date | string; reason_code: string; candidate_entity_ids: string[];
        row_number: number; row_version: number; company_name: string; effective_regon: string | null;
        batch_id: string; tool_id: string;
      }>(`SELECT q.conflict_id AS id, q.status, q.created_at, q.reason_code, q.candidate_entity_ids,
          s.row_number, s.row_version, s.company_name, s.effective_regon, b.id AS batch_id, b.tool_id
        FROM entity_grouping_conflicts q
        JOIN source_rows s ON s.id = q.source_row_id
        JOIN import_batches b ON b.id = s.batch_id
        JOIN tools t ON t.tool_id = b.tool_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY q.created_at DESC, q.conflict_id DESC LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT });
      const candidateIds = [...new Set(rows.flatMap((row) => Array.isArray(row.candidate_entity_ids) ? row.candidate_entity_ids : [])
        .filter((id) => uuidPattern.test(id)))];
      const candidates = candidateIds.length ? await CanonicalEntity.findAll({
        where: { tenantId: actor.tenantId, canonicalEntityId: candidateIds },
        attributes: ["canonicalEntityId", "businessName", "regon"],
      }) : [];
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
          return candidate ? [{ id, businessName: sanitizePublicText(candidate.businessName), regon: candidate.regon }] : [];
        }),
      }));
      return pageResult(items, parsed.limit, parsed.fingerprint);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("Kolejka konfliktów jest chwilowo niedostępna");
    }
  }

  async decideCorrection(correctionId: string, actor: QueuePrincipal, body: unknown) {
    strictBody(body, ["decision", "expectedRowVersion", "reasonCode"]);
    const input = body as Record<string, unknown>;
    if (!uuidPattern.test(correctionId) || (input.decision !== "approved" && input.decision !== "rejected")
      || !Number.isSafeInteger(input.expectedRowVersion) || Number(input.expectedRowVersion) < 1
      || typeof input.reasonCode !== "string" || !correctionReasonCodes.has(input.reasonCode)) {
      throw new BadRequestException("Nieprawidłowa decyzja korekty");
    }
    const stub = await RegonCorrection.findByPk(correctionId, { attributes: ["sourceRowId"] });
    if (!stub) throw new NotFoundException();
    const sourceStub = await SourceRow.findByPk(stub.sourceRowId, { attributes: ["batchId"] });
    if (!sourceStub) throw new NotFoundException();

    return sequelize.transaction(async (transaction) => {
      const batch = await ImportBatch.findByPk(sourceStub.batchId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException();
      await this.assertGrant(actor, batch, transaction);
      const row = await SourceRow.findOne({ where: { id: stub.sourceRowId, batchId: batch.id }, transaction, lock: transaction.LOCK.UPDATE });
      const correction = await RegonCorrection.findByPk(correctionId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row || !correction || correction.sourceRowId !== row.id) throw new NotFoundException();
      if (correction.status !== "pending") throw new ConflictException("Korekta została już rozpatrzona");
      if (row.rowVersion !== input.expectedRowVersion) throw new ConflictException("Wiersz zmienił się; odśwież kolejkę przed decyzją");
      const link = await SourceEntityLink.findByPk(row.id, { transaction, lock: transaction.LOCK.UPDATE });
      await this.assertNoRuns(row.id, link?.canonicalEntityId ?? null, actor.tenantId, transaction);

      const now = new Date();
      correction.status = input.decision as "approved" | "rejected";
      correction.reviewerRef = actor.userId;
      correction.reviewedAt = now;
      correction.reviewReason = input.reasonCode as string;
      await correction.save({ transaction });
      row.rowVersion += 1;

      if (input.decision === "approved") {
        const normalized = normalizeRegon(correction.proposedRegon);
        if (!normalized.normalized || normalized.issues.length) throw new ConflictException("Proponowany REGON wymaga ponownej weryfikacji");
        row.effectiveRegon = normalized.normalized;
        row.issues = row.issues.filter((issue) => !issue.startsWith("REGON_"));
        await row.save({ transaction });
        if (link) await this.updateSoleLinkedEntity(row, link, transaction);
        const grouping = await this.grouping.resolveSourceRow(batch.id, row.rowNumber, transaction);
        row.rowVersion = grouping.rowVersion;
      } else {
        await row.save({ transaction });
      }

      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId,
        action: "regon.correction.reviewed", resourceType: "correction", resourceId: correction.correctionId,
        outcome: "succeeded", metadata: { decision: input.decision as string, reasonCode: input.reasonCode as string },
      }, transaction);
      return {
        correctionId: correction.correctionId, decision: correction.status, rowNumber: row.rowNumber,
        rowVersion: row.rowVersion, effectiveRegon: row.effectiveRegon,
        grouping: input.decision === "approved" ? "rechecked" : "unchanged",
      };
    });
  }

  async resolveConflict(conflictId: string, actor: QueuePrincipal, body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Nieprawidłowe rozstrzygnięcie konfliktu");
    const input = body as Record<string, unknown>;
    const action = input.action;
    const allowed = action === "link_existing"
      ? ["action", "expectedRowVersion", "reasonCode", "canonicalEntityId"]
      : ["action", "expectedRowVersion", "reasonCode"];
    strictBody(body, allowed);
    if (!uuidPattern.test(conflictId) || !["link_existing", "recheck", "reject_link"].includes(String(action))
      || !Number.isSafeInteger(input.expectedRowVersion) || Number(input.expectedRowVersion) < 1
      || typeof input.reasonCode !== "string" || !conflictReasonCodes.has(input.reasonCode)
      || (action === "link_existing" && (typeof input.canonicalEntityId !== "string" || !uuidPattern.test(input.canonicalEntityId)))) {
      throw new BadRequestException("Nieprawidłowe rozstrzygnięcie konfliktu");
    }
    if ((action === "link_existing" && input.reasonCode !== "IDENTIFIERS_VERIFIED")
      || (action === "recheck" && input.reasonCode !== "SOURCE_DATA_UPDATED")
      || (action === "reject_link" && input.reasonCode !== "CANDIDATE_REJECTED")) {
      throw new BadRequestException("Kod przyczyny nie pasuje do rodzaju decyzji");
    }
    const stub = await EntityGroupingConflict.findByPk(conflictId, { attributes: ["sourceRowId"] });
    if (!stub) throw new NotFoundException();
    const sourceStub = await SourceRow.findByPk(stub.sourceRowId, { attributes: ["batchId"] });
    if (!sourceStub) throw new NotFoundException();

    return sequelize.transaction(async (transaction) => {
      const batch = await ImportBatch.findByPk(sourceStub.batchId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundException();
      await this.assertGrant(actor, batch, transaction);
      const row = await SourceRow.findOne({ where: { id: stub.sourceRowId, batchId: batch.id }, transaction, lock: transaction.LOCK.UPDATE });
      const conflict = await EntityGroupingConflict.findByPk(conflictId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row || !conflict || conflict.sourceRowId !== row.id) throw new NotFoundException();
      if (conflict.status !== "open") throw new ConflictException("Konflikt został już rozstrzygnięty");
      if (row.rowVersion !== input.expectedRowVersion) throw new ConflictException("Wiersz zmienił się; odśwież kolejkę przed decyzją");
      const link = await SourceEntityLink.findByPk(row.id, { transaction, lock: transaction.LOCK.UPDATE });
      await this.assertNoRuns(row.id, link?.canonicalEntityId ?? null, actor.tenantId, transaction);
      const now = new Date();
      conflict.status = "resolved";
      conflict.resolutionNote = input.reasonCode as string;
      conflict.resolvedBy = actor.userId;
      conflict.resolvedAt = now;
      await conflict.save({ transaction });
      row.rowVersion += 1;

      if (action === "link_existing") {
        const candidateId = input.canonicalEntityId as string;
        const allowedCandidates = Array.isArray(conflict.candidateEntityIds) ? conflict.candidateEntityIds : [];
        if (!allowedCandidates.includes(candidateId)) throw new ConflictException("Wybrana encja nie jest kandydatem tego konfliktu");
        const candidate = await CanonicalEntity.findOne({
          where: { canonicalEntityId: candidateId, tenantId: actor.tenantId }, transaction, lock: transaction.LOCK.UPDATE,
        });
        if (!candidate) throw new NotFoundException();
        await this.assertNoRuns(row.id, candidate.canonicalEntityId, actor.tenantId, transaction);
        const decision = assessEntityGrouping({
          nipRaw: row.nipRaw, effectiveRegon: row.effectiveRegon, companyName: row.companyName,
          candidates: [{ canonicalEntityId: candidate.canonicalEntityId, nipNormalized: candidate.nipNormalized,
            regon: candidate.regon, businessName: candidate.businessName }],
        });
        if (decision.outcome !== "link_existing" || decision.canonicalEntityId !== candidateId) {
          throw new ConflictException("Identyfikatory firmy nie uzasadniają połączenia; rozpatrz korektę REGON lub ponowną kontrolę");
        }
        const method = await this.grouping.matchMethodForReview(row, decision.nipNormalized, decision.regon, transaction);
        if (link) {
          link.tenantId = actor.tenantId;
          link.canonicalEntityId = candidateId;
          link.matchMethod = "manual";
          link.linkedAt = now;
          await link.save({ transaction });
        } else {
          await SourceEntityLink.create({ sourceRowId: row.id, tenantId: actor.tenantId,
            canonicalEntityId: candidateId, matchMethod: method, linkedAt: now }, { transaction });
        }
        row.issues = row.issues.filter((issue) => issue !== "ENTITY_LINK_REJECTED");
      } else if (action === "reject_link") {
        if (link && (Array.isArray(conflict.candidateEntityIds) ? conflict.candidateEntityIds : []).includes(link.canonicalEntityId)) {
          await link.destroy({ transaction });
        }
        row.issues = [...new Set([...row.issues, "ENTITY_LINK_REJECTED"])];
      }
      await row.save({ transaction });

      let grouping: string = action === "link_existing" ? "linked" : action === "reject_link" ? "link_rejected" : "rechecked";
      if (action === "recheck") {
        row.issues = row.issues.filter((issue) => issue !== "ENTITY_LINK_REJECTED");
        await row.save({ transaction });
        const outcome = await this.grouping.resolveSourceRow(batch.id, row.rowNumber, transaction);
        grouping = outcome.status;
        row.rowVersion = outcome.rowVersion;
      }
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId,
        action: "entity.conflict.reviewed", resourceType: "entity_conflict", resourceId: conflict.conflictId,
        outcome: "succeeded", metadata: { decision: action as string, reasonCode: input.reasonCode as string },
      }, transaction);
      return { conflictId: conflict.conflictId, decision: action, rowNumber: row.rowNumber, rowVersion: row.rowVersion, grouping };
    });
  }

  private async assertGrant(actor: QueuePrincipal, batch: ImportBatch, transaction: Transaction) {
    if (batch.tenantId !== actor.tenantId) throw new NotFoundException();
    if (actor.role === "admin") return;
    const grants = await sequelize.query<{ allowed: boolean }>(
      `SELECT (t.status <> 'disabled' AND (g.can_view_results OR g.can_download_results)) AS allowed
       FROM tool_grants g JOIN tools t ON t.tool_id = g.tool_id
       WHERE g.tenant_id = :tenantId AND g.tool_id = :toolId AND g.user_id = :userId
       FOR SHARE OF g, t`,
      { replacements: { tenantId: actor.tenantId, toolId: batch.toolId, userId: actor.userId }, type: QueryTypes.SELECT, transaction },
    );
    if (!grants[0]?.allowed) throw new NotFoundException();
  }

  private async assertNoRuns(sourceRowId: string, canonicalEntityId: string | null, tenantId: string, transaction: Transaction) {
    if (canonicalEntityId && !await CanonicalEntity.findOne({
      where: { canonicalEntityId, tenantId }, attributes: ["canonicalEntityId"], transaction, lock: transaction.LOCK.UPDATE,
    })) throw new NotFoundException();
    const runs = await sequelize.query<{ id: string }>(
      `SELECT run.id
       FROM automation_runs run
       LEFT JOIN run_source_rows member ON member.run_id = run.id
       WHERE (run.source_row_id = :sourceRowId OR member.source_row_id = :sourceRowId
         OR (:canonicalEntityId IS NOT NULL AND run.canonical_entity_id = CAST(:canonicalEntityId AS uuid)))
       FOR UPDATE OF run`,
      { replacements: { sourceRowId, canonicalEntityId }, type: QueryTypes.SELECT, transaction },
    );
    if (runs.length) throw new ConflictException("Decyzja jest zablokowana, ponieważ wiersz lub encja ma już przypisane zadanie");
  }

  private async updateSoleLinkedEntity(row: SourceRow, link: SourceEntityLink, transaction: Transaction) {
    const entity = await CanonicalEntity.findOne({
      where: { canonicalEntityId: link.canonicalEntityId, tenantId: link.tenantId }, transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!entity) throw new NotFoundException();
    const linkedRows = await SourceEntityLink.count({
      where: { canonicalEntityId: link.canonicalEntityId, tenantId: link.tenantId }, transaction,
    });
    if (linkedRows !== 1) return;
    const regon = row.effectiveRegon ? normalizeRegon(row.effectiveRegon).normalized : null;
    if (!regon) throw new ConflictException("Encja wymaga poprawnego REGON-u po zatwierdzeniu korekty");
    const nip = normalizeNip(row.nipRaw).normalized;
    entity.regon = regon;
    if (nip) entity.nipNormalized = nip;
    entity.businessName = row.companyName;
    entity.updatedAt = new Date();
    try {
      await entity.save({ transaction });
    } catch {
      throw new ConflictException("REGON koliduje z inną encją w tym tenancie; wymagane jest rozstrzygnięcie konfliktu");
    }
  }
}
