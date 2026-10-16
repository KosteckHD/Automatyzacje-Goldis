import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Op, QueryTypes, Sequelize, type Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import { ImportBatchModel, SourceRowModel } from "./imports.model";

export type ImportSourceRowInput = Readonly<{
  rowNumber: number;
  companyName: string;
  decisionMakerName: string | null;
  mobile: string;
  phone: string;
  email: string;
  nipRaw: string;
  address: string;
  postalCode: string;
  city: string;
  regonRaw: string;
  regon: string | null;
  effectiveRegon: string | null;
  issues: string[];
}>;

export type CreateImportBatchInput = Readonly<{
  tenantId: string;
  ownerUserId: string;
  toolId: string;
  fileName: string;
  sha256: string;
  totalRows: number;
  invalidRows: number;
  createdAt: Date;
}>;

@Injectable()
export class ImportsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  async isToolAvailable(toolId: string): Promise<boolean> {
    const [tool] = await this.database.query<{ status: string }>(
      "SELECT status FROM tools WHERE tool_id = $1 LIMIT 1",
      {
        bind: [toolId],
        type: QueryTypes.SELECT,
      },
    );
    return tool?.status === "available";
  }

  createBatch(input: CreateImportBatchInput, transaction: Transaction): Promise<ImportBatchModel> {
    return ImportBatchModel.create(input, { transaction });
  }

  async createRows(batchId: string, rows: readonly ImportSourceRowInput[], transaction: Transaction): Promise<void> {
    for (let start = 0; start < rows.length; start += 500) {
      await SourceRowModel.bulkCreate(
        rows.slice(start, start + 500).map((row) => ({ ...row, batchId })),
        { transaction },
      );
    }
  }

  findBatch(id: string): Promise<ImportBatchModel | null> {
    return ImportBatchModel.findByPk(id);
  }

  findRows(batchId: string, page: number, state: "all" | "ready" | "review"): Promise<SourceRowModel[]> {
    const condition =
      state === "all"
        ? undefined
        : Sequelize.where(Sequelize.fn("jsonb_array_length", Sequelize.col("issues")), {
            [state === "ready" ? Op.eq : Op.gt]: 0,
          });
    return SourceRowModel.findAll({
      where: condition ? { [Op.and]: [{ batchId }, condition] } : { batchId },
      order: [["rowNumber", "ASC"]],
      limit: 50,
      offset: (page - 1) * 50,
    });
  }

  async findEnrichmentReview(id: string, page: number) {
    const [rows, missingRows, pendingRows, conflictRows, lookupRows] = await Promise.all([
      SourceRowModel.findAll({
        where: { batchId: id },
        order: [["rowNumber", "ASC"]],
        limit: 50,
        offset: (page - 1) * 50,
      }),
      this.database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM source_rows WHERE batch_id = $1 AND (effective_regon IS NULL OR effective_regon = '')",
        { bind: [id], type: QueryTypes.SELECT },
      ),
      this.database.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM regon_corrections correction
         JOIN source_rows source ON source.id = correction.source_row_id
         WHERE source.batch_id = $1 AND correction.status = 'pending'`,
        { bind: [id], type: QueryTypes.SELECT },
      ),
      this.database.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM entity_grouping_conflicts conflict
         JOIN source_rows source ON source.id = conflict.source_row_id
         WHERE source.batch_id = $1 AND conflict.status = 'open'`,
        { bind: [id], type: QueryTypes.SELECT },
      ),
      this.database.query<{ status: string; count: number }>(
        `SELECT latest.decision_status AS status, count(*)::int AS count
         FROM (
           SELECT DISTINCT ON (audit.source_row_id) audit.source_row_id, audit.decision_status
           FROM regon_enrichment_audits audit
           JOIN source_rows source ON source.id = audit.source_row_id
           WHERE source.batch_id = $1
           ORDER BY audit.source_row_id, audit.created_at DESC, audit.audit_id DESC
         ) latest
         GROUP BY latest.decision_status`,
        { bind: [id], type: QueryTypes.SELECT },
      ),
    ]);
    const sourceRowIds = rows.map((row) => row.id);
    const [corrections, audits, conflicts] =
      sourceRowIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.database.query<{
              sourceRowId: string;
              correctionId: string;
              proposedRegon: string;
              status: string;
              reason: string;
              createdAt: Date;
            }>(
              `SELECT source_row_id AS "sourceRowId", correction_id AS "correctionId", proposed_regon AS "proposedRegon", status, reason, created_at AS "createdAt"
               FROM regon_corrections WHERE source_row_id = ANY($1::uuid[])
               ORDER BY created_at DESC, correction_id DESC`,
              { bind: [sourceRowIds], type: QueryTypes.SELECT },
            ),
            this.database.query<{
              sourceRowId: string;
              decisionStatus: string;
              reasonCode: string | null;
              providerName: string;
              providerVersion: string;
              effectiveRegonAfter: string | null;
              applied: boolean;
              createdAt: Date;
            }>(
              `SELECT source_row_id AS "sourceRowId", decision_status AS "decisionStatus", reason_code AS "reasonCode",
                      provider_name AS "providerName", provider_version AS "providerVersion",
                      effective_regon_after AS "effectiveRegonAfter", applied, created_at AS "createdAt"
               FROM regon_enrichment_audits WHERE source_row_id = ANY($1::uuid[])
               ORDER BY created_at DESC, audit_id DESC`,
              { bind: [sourceRowIds], type: QueryTypes.SELECT },
            ),
            this.database.query<{
              sourceRowId: string;
              reasonCode: string;
              candidateEntityIds: string[];
              createdAt: Date;
            }>(
              `SELECT source_row_id AS "sourceRowId", reason_code AS "reasonCode",
                      candidate_entity_ids AS "candidateEntityIds", created_at AS "createdAt"
               FROM entity_grouping_conflicts WHERE source_row_id = ANY($1::uuid[]) AND status = 'open'
               ORDER BY created_at DESC, conflict_id DESC`,
              { bind: [sourceRowIds], type: QueryTypes.SELECT },
            ),
          ]);
    return {
      rows,
      missingRegonRows: missingRows[0]?.count ?? 0,
      pendingCorrectionRows: pendingRows[0]?.count ?? 0,
      openConflictRows: conflictRows[0]?.count ?? 0,
      lookupRows,
      corrections,
      audits,
      conflicts,
    };
  }

  async proposeRegonCorrection(input: {
    batchId: string;
    rowNumber: number;
    authorRef: string;
    reason: string;
    proposedRegon: string;
    expectedVersion: number;
    transaction: Transaction;
  }) {
    const { batchId, rowNumber, authorRef, reason, proposedRegon, expectedVersion, transaction } = input;
    const [row] = await this.database.query<{
      id: string;
      rowNumber: number;
      effectiveRegon: string | null;
      rowVersion: number;
    }>(
      `SELECT id, row_number AS "rowNumber", effective_regon AS "effectiveRegon", row_version AS "rowVersion"
       FROM source_rows WHERE batch_id = $1 AND row_number = $2 FOR UPDATE`,
      { bind: [batchId, rowNumber], transaction, type: QueryTypes.SELECT },
    );
    if (!row) return { kind: "not_found" as const };
    if (row.rowVersion !== expectedVersion) return { kind: "stale" as const };
    if (row.effectiveRegon === proposedRegon) return { kind: "same_regon" as const };
    const [pending] = await this.database.query<{ correctionId: string }>(
      `SELECT correction_id AS "correctionId" FROM regon_corrections
       WHERE source_row_id = $1 AND status = 'pending' FOR UPDATE`,
      { bind: [row.id], transaction, type: QueryTypes.SELECT },
    );
    if (pending) return { kind: "pending" as const };

    const correctionId = randomUUID();
    const createdAt = new Date();
    await this.database.query(
      `INSERT INTO regon_corrections
         (correction_id, source_row_id, author_ref, reason, previous_regon, proposed_regon, status,
          reviewer_ref, reviewed_at, review_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NULL, NULL, NULL, $7)`,
      { bind: [correctionId, row.id, authorRef, reason, row.effectiveRegon, proposedRegon, createdAt], transaction },
    );
    const [updatedRow] = await this.database.query<{ rowVersion: number }>(
      `UPDATE source_rows SET row_version = row_version + 1 WHERE id = $1 RETURNING row_version AS "rowVersion"`,
      { bind: [row.id], transaction, type: QueryTypes.SELECT },
    );
    return {
      kind: "created" as const,
      correction: {
        correctionId,
        previousRegon: row.effectiveRegon,
        proposedRegon,
        status: "pending" as const,
        createdAt,
      },
      row: { rowNumber: row.rowNumber, rowVersion: updatedRow?.rowVersion ?? row.rowVersion + 1 },
    };
  }
}
