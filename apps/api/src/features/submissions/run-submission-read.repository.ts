import { Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Transaction } from "sequelize";
import {
  AutomationRun,
  ImportBatch,
  ResultSet,
  RunSubmission,
  RunSubmissionGroup,
  RunSubmissionItem,
  sequelize,
} from "../../infrastructure/database/db";

export type RunSubmissionItemCursor = Readonly<{ rowNumber: number; sourceRowId: string }>;

export type RunSubmissionItemRow = Readonly<{
  itemId: string;
  sourceRowId: string;
  rowNumber: number;
  expectedRowVersion: number;
  preparationState: string;
  reasonCode: string | null;
  groupId: string | null;
  admissionState: string | null;
  groupReason: string | null;
  runId: string | null;
  runStatus: string | null;
  runErrorCode: string | null;
}>;

export type RunSubmissionState = Readonly<{
  status: string;
  itemCounts: Record<string, number>;
  groupCounts: Record<string, number>;
}>;

@Injectable()
export class RunSubmissionReadRepository {
  findSubmission(id: string, tenantId: string) {
    return RunSubmission.findOne({ where: { submissionId: id, tenantId } });
  }

  findSubmissionVersion(id: string) {
    return RunSubmission.findByPk(id, { attributes: ["version"] });
  }

  findBatch(batchId: string) {
    return ImportBatch.findByPk(batchId);
  }

  async countState(submission: RunSubmission): Promise<RunSubmissionState> {
    const [items, groups] = await Promise.all([
      RunSubmissionItem.findAll({ where: { submissionId: submission.submissionId }, order: [["sourceRowId", "ASC"]] }),
      RunSubmissionGroup.findAll({ where: { submissionId: submission.submissionId } }),
    ]);
    const groupById = new Map(groups.map((group) => [group.groupId, group]));
    const runIds = groups.map((group) => group.runId).filter((id): id is string => Boolean(id));
    const runs = runIds.length
      ? await AutomationRun.findAll({
          where: { id: runIds },
          attributes: ["id", "status", "errorCode", "referenceDate"],
        })
      : [];
    const runById = new Map(runs.map((run) => [run.id, run]));
    const itemCounts: Record<string, number> = {
      review: 0,
      excluded: 0,
      waiting: 0,
      running: 0,
      waiting_attention: 0,
      completed: 0,
      no_matching_policies: 0,
      failed: 0,
      cancelled: 0,
      blocked: 0,
    };
    for (const item of items) {
      if (item.preparationState !== "ready") {
        itemCounts[item.preparationState] = (itemCounts[item.preparationState] ?? 0) + 1;
        continue;
      }
      const group = item.groupId ? groupById.get(item.groupId) : null;
      if (!group) {
        itemCounts.blocked += 1;
        continue;
      }
      if (group.admissionState === "cancelled") {
        itemCounts.cancelled += 1;
        continue;
      }
      if (group.admissionState === "blocked") {
        itemCounts.blocked += 1;
        continue;
      }
      if (group.admissionState !== "accepted" || !group.runId) {
        itemCounts.waiting += 1;
        continue;
      }
      const run = runById.get(group.runId);
      if (!run) {
        itemCounts.blocked += 1;
        continue;
      }
      if (run.status === "completed") itemCounts.completed += 1;
      else if (run.status === "no_matching_policies") itemCounts.no_matching_policies += 1;
      else if (run.status === "failed") itemCounts.failed += 1;
      else if (run.status === "cancelled") itemCounts.cancelled += 1;
      else if (["identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(run.status))
        itemCounts.waiting_attention += 1;
      else itemCounts.running += 1;
    }
    const groupCounts: Record<string, number> = {
      pending: 0,
      waiting: 0,
      accepted: 0,
      blocked: 0,
      cancelled: 0,
      completed: 0,
      no_matching_policies: 0,
      failed: 0,
      waiting_attention: 0,
      running: 0,
    };
    for (const group of groups) {
      if (group.admissionState === "blocked") {
        groupCounts.blocked += 1;
        continue;
      }
      if (group.admissionState === "cancelled") {
        groupCounts.cancelled += 1;
        continue;
      }
      if (
        group.admissionState === "waiting_capacity" ||
        group.admissionState === "waiting_window" ||
        group.admissionState === "waiting_paused"
      ) {
        groupCounts.waiting += 1;
        continue;
      }
      if (group.admissionState === "pending" || group.admissionState === "leased") {
        groupCounts.pending += 1;
        continue;
      }
      groupCounts.accepted += 1;
      const run = group.runId ? runById.get(group.runId) : null;
      if (run?.status === "completed") groupCounts.completed += 1;
      else if (run?.status === "no_matching_policies") groupCounts.no_matching_policies += 1;
      else if (run?.status === "failed" || run?.status === "cancelled") groupCounts.failed += 1;
      else if (run && ["identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(run.status))
        groupCounts.waiting_attention += 1;
      else if (run) groupCounts.running += 1;
    }
    const allItemsSettled = items.length > 0 && itemCounts.waiting === 0 && itemCounts.running === 0;
    const status =
      submission.status === "cancelled"
        ? "cancelled"
        : itemCounts.waiting
          ? "queued"
          : itemCounts.running
            ? "running"
            : itemCounts.waiting_attention || itemCounts.blocked || itemCounts.review
              ? "waiting_attention"
              : allItemsSettled
                ? "completed"
                : "queued";
    return { status, itemCounts, groupCounts };
  }

  listItems(submissionId: string, cursor: RunSubmissionItemCursor | null): Promise<RunSubmissionItemRow[]> {
    return sequelize.query<RunSubmissionItemRow>(
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
      {
        replacements: {
          submissionId,
          cursorRowNumber: cursor?.rowNumber ?? null,
          cursorSourceRowId: cursor?.sourceRowId ?? null,
        },
        type: QueryTypes.SELECT,
      },
    );
  }

  countTotals(submissionId: string) {
    return Promise.all([
      RunSubmissionGroup.count({ where: { submissionId } }),
      RunSubmissionItem.count({ where: { submissionId } }),
    ]);
  }

  findResultSet(resultSetId: string) {
    return ResultSet.findByPk(resultSetId);
  }

  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return sequelize.transaction(work);
  }

  lockResultSet(resultSetId: string, transaction: Transaction) {
    return ResultSet.findByPk(resultSetId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  saveResultSet(resultSet: ResultSet, transaction: Transaction) {
    return resultSet.save({ transaction });
  }

  updateActiveResultSet(resultSetId: string, status: string) {
    return ResultSet.update(
      { status, updatedAt: new Date() },
      {
        where: {
          resultSetId,
          status: { [Op.notIn]: ["completed", "cancelled", "failed"] },
        },
      },
    );
  }
}
