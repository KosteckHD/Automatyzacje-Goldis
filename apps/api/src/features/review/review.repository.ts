import { Inject, Injectable } from "@nestjs/common";
import type { Sequelize, Transaction } from "sequelize";
import { QueryTypes } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import { operationalCollectionScope } from "../authorization";

type PersistenceModel<T> = Readonly<{
  findByPk(id: string, options?: unknown): Promise<T | null>;
  findOne(options?: unknown): Promise<T | null>;
  findAll(options?: unknown): Promise<T[]>;
  update(values: Partial<T>, options?: unknown): Promise<[number]>;
  create(values: Partial<T>, options?: unknown): Promise<T>;
  count(options?: unknown): Promise<number>;
  destroy(options?: unknown): Promise<number>;
}>;

export type ReviewBatchRecord = Readonly<{ id: string; tenantId: string | null; toolId: string }>;
export type ReviewSourceRowRecord = Readonly<{
  id: string;
  batchId: string;
  rowNumber: number;
  rowVersion: number;
  companyName: string;
  nipRaw: string;
  effectiveRegon: string | null;
  issues: string[];
}>;
export type ReviewCorrectionRecord = Readonly<{
  correctionId: string;
  sourceRowId: string;
  proposedRegon: string;
  status: "pending" | "approved" | "rejected";
}>;
export type ReviewConflictRecord = Readonly<{
  conflictId: string;
  sourceRowId: string;
  candidateEntityIds: string[];
  status: "open" | "resolved";
}>;
export type ReviewSourceLinkRecord = Readonly<{
  sourceRowId: string;
  tenantId: string;
  canonicalEntityId: string;
  matchMethod: "nip_regon_exact" | "registry_verified" | "identifier_and_name_exact" | "manual";
  linkedAt: Date;
}>;
export type ReviewCanonicalEntityRecord = Readonly<{
  canonicalEntityId: string;
  nipNormalized: string | null;
  regon: string | null;
  businessName: string;
  updatedAt?: Date;
}>;

export type ReviewQueueFilters = Readonly<{
  status?: string;
  batchId?: string;
  toolId?: string;
  from?: string;
  to?: string;
  search?: string;
}>;

export type ReviewQueuePage = Readonly<{
  tenantId: string;
  userId: string;
  role: string;
  filters: ReviewQueueFilters;
  cursor: Readonly<{ createdAt: string; id: string }> | null;
  limit: number;
}>;

export type ReviewImportOption = Readonly<{ batch_id: string; file_name: string; tool_id: string; created_at: Date | string }>;

export type ReviewCorrectionRow = {
  id: string;
  status: string;
  created_at: Date | string;
  reviewed_at: Date | string | null;
  review_reason: string | null;
  previous_regon: string | null;
  proposed_regon: string;
  reason: string;
  row_number: number;
  row_version: number;
  company_name: string;
  batch_id: string;
  tool_id: string;
};

export type ReviewConflictRow = {
  id: string;
  status: string;
  created_at: Date | string;
  reason_code: string;
  candidate_entity_ids: string[];
  row_number: number;
  row_version: number;
  company_name: string;
  effective_regon: string | null;
  batch_id: string;
  tool_id: string;
};

export type ReviewCandidate = Readonly<{
  canonicalEntityId: string;
  businessName: string;
  regon: string | null;
}>;

@Injectable()
export class ReviewRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  private model<T>(name: string): PersistenceModel<T> {
    return this.database.model(name) as unknown as PersistenceModel<T>;
  }

  withTransaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.database.transaction(operation);
  }

  async correctionRoute(correctionId: string): Promise<Readonly<{ sourceRowId: string; batchId: string }> | null> {
    const correction = await this.model<ReviewCorrectionRecord>("RegonCorrection").findByPk(correctionId, {
      attributes: ["sourceRowId"],
    });
    if (!correction) return null;
    const source = await this.model<ReviewSourceRowRecord>("SourceRow").findByPk(correction.sourceRowId, {
      attributes: ["batchId"],
    });
    return source ? { sourceRowId: correction.sourceRowId, batchId: source.batchId } : null;
  }

  async conflictRoute(conflictId: string): Promise<Readonly<{ sourceRowId: string; batchId: string }> | null> {
    const conflict = await this.model<ReviewConflictRecord>("EntityGroupingConflict").findByPk(conflictId, {
      attributes: ["sourceRowId"],
    });
    if (!conflict) return null;
    const source = await this.model<ReviewSourceRowRecord>("SourceRow").findByPk(conflict.sourceRowId, {
      attributes: ["batchId"],
    });
    return source ? { sourceRowId: conflict.sourceRowId, batchId: source.batchId } : null;
  }

  async lockBatch(batchId: string, transaction: Transaction): Promise<ReviewBatchRecord | null> {
    const row = await this.model<ReviewBatchRecord>("ImportBatch").findByPk(batchId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return row ? { id: row.id, tenantId: row.tenantId, toolId: row.toolId } : null;
  }

  async lockSourceRow(sourceRowId: string, transaction: Transaction): Promise<ReviewSourceRowRecord | null> {
    const row = await this.model<ReviewSourceRowRecord>("SourceRow").findByPk(sourceRowId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return row
      ? {
          id: row.id,
          batchId: row.batchId,
          rowNumber: row.rowNumber,
          rowVersion: row.rowVersion,
          companyName: row.companyName,
          nipRaw: row.nipRaw,
          effectiveRegon: row.effectiveRegon,
          issues: [...row.issues],
        }
      : null;
  }

  async lockCorrection(correctionId: string, transaction: Transaction): Promise<ReviewCorrectionRecord | null> {
    const row = await this.model<ReviewCorrectionRecord>("RegonCorrection").findByPk(correctionId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return row
      ? {
          correctionId: row.correctionId,
          sourceRowId: row.sourceRowId,
          proposedRegon: row.proposedRegon,
          status: row.status,
        }
      : null;
  }

  async lockConflict(conflictId: string, transaction: Transaction): Promise<ReviewConflictRecord | null> {
    const row = await this.model<ReviewConflictRecord>("EntityGroupingConflict").findByPk(conflictId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return row
      ? {
          conflictId: row.conflictId,
          sourceRowId: row.sourceRowId,
          candidateEntityIds: [...row.candidateEntityIds],
          status: row.status,
        }
      : null;
  }

  async lockSourceLink(sourceRowId: string, transaction: Transaction): Promise<ReviewSourceLinkRecord | null> {
    const row = await this.model<ReviewSourceLinkRecord>("SourceEntityLink").findByPk(sourceRowId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return row
      ? {
          sourceRowId: row.sourceRowId,
          tenantId: row.tenantId,
          canonicalEntityId: row.canonicalEntityId,
          matchMethod: row.matchMethod,
          linkedAt: row.linkedAt,
        }
      : null;
  }

  async reviewGrantAllowed(
    input: Readonly<{ tenantId: string; userId: string; role: string; toolId: string }>,
    transaction: Transaction,
  ): Promise<boolean> {
    if (input.role === "admin") return true;
    const grants = await this.database.query<{ allowed: boolean }>(
      `SELECT (t.status <> 'disabled' AND g.can_view_results) AS allowed
       FROM tool_grants g JOIN tools t ON t.tool_id = g.tool_id
       WHERE g.tenant_id = :tenantId AND g.tool_id = :toolId AND g.user_id = :userId
       FOR SHARE OF g, t`,
      {
        replacements: { tenantId: input.tenantId, toolId: input.toolId, userId: input.userId },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return grants[0]?.allowed === true;
  }

  async reviewWriteBlocker(
    sourceRowId: string,
    canonicalEntityId: string | null,
    tenantId: string,
    transaction: Transaction,
  ): Promise<"canonical_missing" | "run_exists" | null> {
    if (
      canonicalEntityId &&
      !(await this.model<ReviewCanonicalEntityRecord>("CanonicalEntity").findOne({
        where: { canonicalEntityId, tenantId },
        attributes: ["canonicalEntityId"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      }))
    )
      return "canonical_missing";
    const runs = await this.database.query<{ id: string }>(
      `SELECT run.id
       FROM automation_runs run
       LEFT JOIN run_source_rows member ON member.run_id = run.id
       WHERE (run.source_row_id = :sourceRowId OR member.source_row_id = :sourceRowId
         OR (:canonicalEntityId IS NOT NULL AND run.canonical_entity_id = CAST(:canonicalEntityId AS uuid)))
       FOR UPDATE OF run`,
      { replacements: { sourceRowId, canonicalEntityId }, type: QueryTypes.SELECT, transaction },
    );
    return runs.length ? "run_exists" : null;
  }

  async updateCorrection(
    correctionId: string,
    input: Readonly<{
      status: "approved" | "rejected";
      reviewerRef: string;
      reviewedAt: Date;
      reviewReason: string;
    }>,
    transaction: Transaction,
  ) {
    await this.model<ReviewCorrectionRecord>("RegonCorrection").update(input, { where: { correctionId }, transaction });
  }

  async updateConflict(
    conflictId: string,
    input: Readonly<{
      status: "resolved";
      resolutionNote: string;
      resolvedBy: string;
      resolvedAt: Date;
    }>,
    transaction: Transaction,
  ) {
    await this.model<ReviewConflictRecord>("EntityGroupingConflict").update(input, {
      where: { conflictId },
      transaction,
    });
  }

  async updateSourceRow(
    sourceRowId: string,
    input: Readonly<{
      rowVersion: number;
      issues: string[];
      effectiveRegon?: string | null;
    }>,
    transaction: Transaction,
  ) {
    await this.model<ReviewSourceRowRecord>("SourceRow").update(input, { where: { id: sourceRowId }, transaction });
  }

  async lockCanonicalEntity(
    canonicalEntityId: string,
    tenantId: string,
    transaction: Transaction,
  ): Promise<ReviewCanonicalEntityRecord | null> {
    const row = await this.model<ReviewCanonicalEntityRecord>("CanonicalEntity").findOne({
      where: { canonicalEntityId, tenantId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return row
      ? {
          canonicalEntityId: row.canonicalEntityId,
          nipNormalized: row.nipNormalized,
          regon: row.regon,
          businessName: row.businessName,
        }
      : null;
  }

  countCanonicalLinks(canonicalEntityId: string, tenantId: string, transaction: Transaction): Promise<number> {
    return this.model<ReviewSourceLinkRecord>("SourceEntityLink").count({
      where: { canonicalEntityId, tenantId },
      transaction,
    });
  }

  async updateCanonicalEntity(
    canonicalEntityId: string,
    tenantId: string,
    input: Readonly<{
      regon: string;
      nipNormalized: string | null;
      businessName: string;
      updatedAt: Date;
    }>,
    transaction: Transaction,
  ) {
    await this.model<ReviewCanonicalEntityRecord>("CanonicalEntity").update(input, {
      where: { canonicalEntityId, tenantId },
      transaction,
    });
  }

  async lockCandidate(
    canonicalEntityId: string,
    tenantId: string,
    transaction: Transaction,
  ): Promise<ReviewCanonicalEntityRecord | null> {
    return this.lockCanonicalEntity(canonicalEntityId, tenantId, transaction);
  }

  async saveSourceLink(
    sourceRowId: string,
    input: ReviewSourceLinkRecord,
    existing: boolean,
    transaction: Transaction,
  ) {
    if (existing) {
      await this.model<ReviewSourceLinkRecord>("SourceEntityLink").update(
        {
          tenantId: input.tenantId,
          canonicalEntityId: input.canonicalEntityId,
          matchMethod: input.matchMethod,
          linkedAt: input.linkedAt,
        },
        { where: { sourceRowId }, transaction },
      );
      return;
    }
    await this.model<ReviewSourceLinkRecord>("SourceEntityLink").create(input, { transaction });
  }

  async deleteSourceLink(sourceRowId: string, transaction: Transaction) {
    await this.model<ReviewSourceLinkRecord>("SourceEntityLink").destroy({ where: { sourceRowId }, transaction });
  }

  async listCorrections(input: ReviewQueuePage & Readonly<{ ownOnly: boolean }>): Promise<ReviewCorrectionRow[]> {
    const replacements = this.replacements(input);
    const conditions = [operationalCollectionScope(input.role)];
    this.appendFilters(conditions, input.filters);
    if (input.ownOnly) conditions.push("q.author_ref = :userId");
    if (input.cursor) conditions.push("(q.created_at, q.correction_id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    return this.database.query<ReviewCorrectionRow>(
      `SELECT q.correction_id AS id, q.status, q.created_at, q.reviewed_at, q.review_reason,
          q.previous_regon, q.proposed_regon,
          q.reason, s.row_number, s.row_version, s.company_name, b.id AS batch_id, b.tool_id
        FROM regon_corrections q
        JOIN source_rows s ON s.id = q.source_row_id
        JOIN import_batches b ON b.id = s.batch_id
        JOIN tools t ON t.tool_id = b.tool_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY q.created_at DESC, q.correction_id DESC LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT },
    );
  }

  async listConflicts(input: ReviewQueuePage): Promise<{
    rows: ReviewConflictRow[];
    candidates: ReviewCandidate[];
  }> {
    const replacements = this.replacements(input);
    const conditions = [operationalCollectionScope(input.role)];
    this.appendFilters(conditions, input.filters);
    if (input.cursor) conditions.push("(q.created_at, q.conflict_id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    const rows = await this.database.query<ReviewConflictRow>(
      `SELECT q.conflict_id AS id, q.status, q.created_at, q.reason_code, q.candidate_entity_ids,
          s.row_number, s.row_version, s.company_name, s.effective_regon, b.id AS batch_id, b.tool_id
        FROM entity_grouping_conflicts q
        JOIN source_rows s ON s.id = q.source_row_id
        JOIN import_batches b ON b.id = s.batch_id
        JOIN tools t ON t.tool_id = b.tool_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY q.created_at DESC, q.conflict_id DESC LIMIT :limit`,
      { replacements, type: QueryTypes.SELECT },
    );
    const candidateIds = [
      ...new Set(
        rows
          .flatMap((row) => (Array.isArray(row.candidate_entity_ids) ? row.candidate_entity_ids : []))
          .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)),
      ),
    ];
    const candidates: ReviewCandidate[] = candidateIds.length
      ? await this.model<ReviewCanonicalEntityRecord>("CanonicalEntity").findAll({
          where: { tenantId: input.tenantId, canonicalEntityId: candidateIds },
          attributes: ["canonicalEntityId", "businessName", "regon"],
        })
      : [];
    return { rows, candidates };
  }

  async listImportOptions(input: ReviewQueuePage & Readonly<{ queue: "corrections" | "conflicts"; ownOnly?: boolean }>): Promise<ReviewImportOption[]> {
    const table = input.queue === "conflicts" ? "entity_grouping_conflicts" : "regon_corrections";
    const idColumn = input.queue === "conflicts" ? "conflict_id" : "correction_id";
    const conditions = [operationalCollectionScope(input.role)];
    if (input.filters.status) conditions.push("q.status = :status");
    if (input.filters.toolId) conditions.push("b.tool_id = :toolId");
    if (input.filters.search) conditions.push("position(lower(:search) in lower(b.file_name)) > 0");
    if (input.ownOnly) conditions.push("q.author_ref = :userId");
    const cursorCondition = input.cursor
      ? `HAVING (MAX(q.created_at), b.id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))`
      : "";
    return this.database.query<ReviewImportOption>(
      `SELECT b.id AS batch_id, b.file_name, b.tool_id, MAX(q.created_at) AS created_at
         FROM ${table} q
         JOIN source_rows s ON s.id = q.source_row_id
         JOIN import_batches b ON b.id = s.batch_id
         JOIN tools t ON t.tool_id = b.tool_id
        WHERE ${conditions.join(" AND ")}
        GROUP BY b.id, b.file_name, b.tool_id
        ${cursorCondition}
        ORDER BY MAX(q.created_at) DESC, b.id DESC
        LIMIT :limit`,
      { replacements: { ...this.replacements(input), ...(input.filters.search ? { search: input.filters.search } : {}) }, type: QueryTypes.SELECT },
    );
  }

  private replacements(input: ReviewQueuePage) {
    return {
      limit: input.limit + 1,
      tenantId: input.tenantId,
      userId: input.userId,
      ...(input.filters.status ? { status: input.filters.status } : {}),
      ...(input.filters.batchId ? { batchId: input.filters.batchId } : {}),
      ...(input.filters.toolId ? { toolId: input.filters.toolId } : {}),
      ...(input.filters.from ? { from: input.filters.from } : {}),
      ...(input.filters.to ? { to: input.filters.to } : {}),
      ...(input.cursor ? { cursorCreatedAt: input.cursor.createdAt, cursorId: input.cursor.id } : {}),
    };
  }

  private appendFilters(conditions: string[], filters: ReviewQueueFilters) {
    if (filters.status) conditions.push("q.status = :status");
    if (filters.batchId) conditions.push("b.id = :batchId");
    if (filters.toolId) conditions.push("b.tool_id = :toolId");
    if (filters.from) conditions.push("q.created_at >= :from");
    if (filters.to) conditions.push("q.created_at <= :to");
  }
}
