import { Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Transaction } from "sequelize";
import {
  CanonicalEntity,
  EntityGroupingConflict,
  ImportBatch,
  RegonCorrection,
  SourceEntityLink,
  SourceRow,
  sequelize,
} from "../../infrastructure/database/db";
import { requireCurrentSealedPreparation } from "../preparations/public";

export type RunSubmissionOpenRun = Readonly<{
  sourceRowId: string;
  runId: string;
  status: string;
  referenceDate: string;
}>;

export type RunSubmissionPreviewSignals = Readonly<{
  corrections: RegonCorrection[];
  conflicts: EntityGroupingConflict[];
  links: SourceEntityLink[];
  openRuns: RunSubmissionOpenRun[];
  candidates: CanonicalEntity[];
}>;

export type RunSubmissionPreviewRows = Readonly<{
  rows: SourceRow[];
  preparedBySourceId: Awaited<ReturnType<typeof requireCurrentSealedPreparation>> | null;
}>;

@Injectable()
export class RunSubmissionPreviewRepository {
  findBatch(batchId: string, transaction?: Transaction, lock = false) {
    return ImportBatch.findByPk(batchId, {
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  async loadRows(
    batchId: string,
    rowNumbers: readonly number[],
    expectedPreparationId?: string,
    transaction?: Transaction,
    lock = false,
  ): Promise<RunSubmissionPreviewRows> {
    const rows = await SourceRow.findAll({
      where: { batchId, rowNumber: [...rowNumbers] },
      order: [["rowNumber", "ASC"]],
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (rows.length !== rowNumbers.length) return { rows, preparedBySourceId: null };
    const preparedBySourceId = await requireCurrentSealedPreparation(batchId, rows, transaction, expectedPreparationId);
    return { rows, preparedBySourceId };
  }

  async loadSignals(
    batchId: string,
    tenantId: string,
    rows: readonly SourceRow[],
    nipValues: readonly string[],
    regonValues: readonly string[],
    transaction?: Transaction,
    lock = false,
  ): Promise<RunSubmissionPreviewSignals> {
    const sourceIds = rows.map((row) => row.id);
    const options = lock && transaction ? { lock: transaction.LOCK.UPDATE } : {};
    const correctionsQuery = () =>
      RegonCorrection.findAll({
        where: { sourceRowId: sourceIds, status: "pending" },
        attributes: ["sourceRowId"],
        transaction,
        ...options,
      });
    const conflictsQuery = () =>
      EntityGroupingConflict.findAll({
        where: { sourceRowId: sourceIds, status: "open" },
        attributes: ["sourceRowId"],
        transaction,
        ...options,
      });
    const linksQuery = () =>
      SourceEntityLink.findAll({
        where: { sourceRowId: sourceIds, tenantId },
        attributes: ["sourceRowId", "canonicalEntityId"],
        transaction,
        ...options,
      });
    const activeRunsQuery = () =>
      sourceIds.length
        ? sequelize.query<RunSubmissionOpenRun>(
            `SELECT selected.source_row_id AS "sourceRowId", run.id AS "runId", run.status, run.reference_date AS "referenceDate"
           FROM automation_runs run
           JOIN LATERAL (
             SELECT member.source_row_id FROM run_source_rows member WHERE member.run_id = run.id
             UNION SELECT run.source_row_id
           ) selected ON TRUE
          WHERE run.batch_id = :batchId AND selected.source_row_id IN (:sourceIds)
            AND run.status NOT IN ('completed', 'failed', 'no_matching_policies', 'cancelled')`,
            { replacements: { batchId, sourceIds }, type: QueryTypes.SELECT, transaction },
          )
        : Promise.resolve([]);
    const [corrections, conflicts, links, openRuns] = transaction
      ? [await correctionsQuery(), await conflictsQuery(), await linksQuery(), await activeRunsQuery()]
      : await Promise.all([correctionsQuery(), conflictsQuery(), linksQuery(), activeRunsQuery()]);
    const candidates =
      nipValues.length || regonValues.length
        ? await CanonicalEntity.findAll({
            where: {
              tenantId,
              [Op.or]: [
                ...(nipValues.length ? [{ nipNormalized: [...new Set(nipValues)] }] : []),
                ...(regonValues.length ? [{ regon: [...new Set(regonValues)] }] : []),
              ],
            },
            attributes: ["canonicalEntityId", "nipNormalized", "regon", "businessName"],
            transaction,
            ...options,
          })
        : [];
    return { corrections, conflicts, links, openRuns, candidates };
  }
}
