import { Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Transaction } from "sequelize";
import {
  AutomationRun,
  CanonicalEntity,
  EntityGroupingConflict,
  ImportBatch,
  RegonCorrection,
  RunSubmission,
  RunSubmissionGroup,
  RunSubmissionItem,
  SourceEntityLink,
  SourceRow,
  sequelize,
  TenantMembership,
  Tool,
  ToolGrant,
  ToolSettings,
  User,
} from "../../infrastructure/database/db";
import { type AuditActorContext, recordAuditEvent } from "../audit/public";

export type RunSubmissionAdmissionTarget = Readonly<{
  groupId: string;
  group: RunSubmissionGroup;
  submission: RunSubmission;
}>;

export type RunSubmissionAdmissionBase = Readonly<{
  settings: ToolSettings | null;
  actorUser: User | null;
  membership: TenantMembership | null;
  tool: Tool | null;
  grant: ToolGrant | null;
  batch: ImportBatch | null;
}>;

export type RunSubmissionAdmissionGroupContext = Readonly<{
  group: RunSubmissionGroup | null;
  groupItems: RunSubmissionItem[];
  linkedRows: SourceEntityLink[];
  rows: SourceRow[];
  canonical: CanonicalEntity | null;
}>;

export type RunSubmissionAdmissionBlockers = Readonly<{
  pendingCorrection: RegonCorrection | null;
  openConflict: EntityGroupingConflict | null;
}>;

@Injectable()
export class RunSubmissionAdmissionRepository {
  async findTarget(groupId: string, dispatcherId: string): Promise<RunSubmissionAdmissionTarget | null> {
    const group = await RunSubmissionGroup.findByPk(groupId, {
      attributes: ["submissionId", "canonicalEntityId", "tenantId", "leaseOwner", "runId"],
    });
    if (!group || group.leaseOwner !== dispatcherId || group.runId) return null;
    const submission = await RunSubmission.findByPk(group.submissionId, {
      attributes: ["importBatchId", "actorUserId", "tenantId", "toolId", "referenceDate"],
    });
    return submission ? { groupId, group, submission } : null;
  }

  withAdmissionTransaction<T>(
    target: RunSubmissionAdmissionTarget,
    work: (base: RunSubmissionAdmissionBase, transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return sequelize.transaction(async (transaction) => {
      const { submission } = target;
      const settings = await ToolSettings.findOne({
        where: { tenantId: submission.tenantId, toolId: submission.toolId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const actorUser = await User.findByPk(submission.actorUserId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const membership = await TenantMembership.findOne({
        where: { tenantId: submission.tenantId, userId: submission.actorUserId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const tool = await Tool.findByPk(submission.toolId, { transaction, lock: transaction.LOCK.UPDATE });
      const grant = await ToolGrant.findOne({
        where: { tenantId: submission.tenantId, toolId: submission.toolId, userId: submission.actorUserId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const batch = await ImportBatch.findByPk(submission.importBatchId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      return work({ settings, actorUser, membership, tool, grant, batch }, transaction);
    });
  }

  lockGroup(groupId: string, transaction: Transaction) {
    return RunSubmissionGroup.findByPk(groupId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  async findGroupContext(
    target: RunSubmissionAdmissionTarget,
    transaction: Transaction,
  ): Promise<RunSubmissionAdmissionGroupContext> {
    const { groupId, group: observed, submission } = target;
    const groupItems = await RunSubmissionItem.findAll({
      where: { submissionId: observed.submissionId, groupId },
      order: [["sourceRowId", "ASC"]],
      transaction,
    });
    const linkedRows = await SourceEntityLink.findAll({
      where: { tenantId: submission.tenantId, canonicalEntityId: observed.canonicalEntityId },
      attributes: ["sourceRowId", "canonicalEntityId"],
      transaction,
    });
    const rowIds = [
      ...new Set([...groupItems.map((item) => item.sourceRowId), ...linkedRows.map((link) => link.sourceRowId)]),
    ];
    const rows = await SourceRow.findAll({
      where: { id: rowIds, batchId: submission.importBatchId },
      order: [["rowNumber", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const canonical = await CanonicalEntity.findOne({
      where: { canonicalEntityId: observed.canonicalEntityId, tenantId: submission.tenantId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const group = await RunSubmissionGroup.findByPk(groupId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return { group, groupItems, linkedRows, rows, canonical };
  }

  async findBlockers(
    sourceRowIds: readonly string[],
    transaction: Transaction,
  ): Promise<RunSubmissionAdmissionBlockers> {
    const pendingCorrection = sourceRowIds.length
      ? await RegonCorrection.findOne({
          where: { sourceRowId: [...sourceRowIds], status: "pending" },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    const openConflict = sourceRowIds.length
      ? await EntityGroupingConflict.findOne({
          where: { sourceRowId: [...sourceRowIds], status: "open" },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    return { pendingCorrection, openConflict };
  }

  findExistingRun(batchId: string, canonicalEntityId: string, leadIdentityKey: string, transaction: Transaction) {
    return AutomationRun.findOne({
      where: {
        batchId,
        canonicalEntityId,
        leadIdentityKey,
        status: { [Op.notIn]: ["completed", "failed", "no_matching_policies", "cancelled"] },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  async countRecentRuns(tenantId: string, toolId: string, since: Date, transaction: Transaction): Promise<number> {
    const rows = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
        WHERE b.tenant_id = :tenantId AND b.tool_id = :toolId AND r.created_at >= :since`,
      { replacements: { tenantId, toolId, since }, type: QueryTypes.SELECT, transaction },
    );
    return Number(rows[0]?.count ?? 0);
  }

  claim(dispatcherId: string): Promise<string | null> {
    const now = new Date();
    return sequelize.transaction(async (transaction) => {
      const group = await RunSubmissionGroup.findOne({
        where: {
          runId: null,
          admissionState: { [Op.in]: ["pending", "waiting_capacity", "waiting_window", "waiting_paused", "leased"] },
          [Op.and]: [
            { [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: now } }] },
            { [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: now } }] },
          ],
        },
        order: [
          ["createdAt", "ASC"],
          ["groupId", "ASC"],
        ],
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!group) return null;
      group.admissionState = "leased";
      group.leaseOwner = dispatcherId;
      group.leaseExpiresAt = new Date(now.getTime() + 30_000);
      group.version += 1;
      group.updatedAt = now;
      await group.save({ transaction });
      return group.groupId;
    });
  }

  async defer(
    group: RunSubmissionGroup,
    transaction: Transaction,
    state: RunSubmissionGroup["admissionState"],
    reasonCode: string,
    delayMs: number,
  ) {
    group.admissionState = state;
    group.reasonCode = reasonCode;
    group.nextAttemptAt = new Date(Date.now() + delayMs);
    group.leaseOwner = null;
    group.leaseExpiresAt = null;
    group.version += 1;
    group.updatedAt = new Date();
    await group.save({ transaction });
  }

  async accept(
    group: RunSubmissionGroup,
    runId: string,
    actor: AuditActorContext,
    referenceDate: string,
    transaction: Transaction,
  ) {
    group.runId = runId;
    group.admissionState = "accepted";
    group.reasonCode = null;
    group.nextAttemptAt = null;
    group.leaseOwner = null;
    group.leaseExpiresAt = null;
    group.version += 1;
    group.updatedAt = new Date();
    await group.save({ transaction });
    await recordAuditEvent(
      {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: "run.submission.group_admitted",
        resourceType: "run_submission",
        resourceId: group.submissionId,
        outcome: "succeeded",
        metadata: { groupId: group.groupId, runId, referenceDate },
      },
      transaction,
    );
  }
}
