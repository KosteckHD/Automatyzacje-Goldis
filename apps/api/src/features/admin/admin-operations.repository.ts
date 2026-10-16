import { Inject, Injectable } from "@nestjs/common";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import {
  AutomationRun,
  ImportBatch,
  InterventionActivity,
  ManualIntervention,
  TenantMembership,
  ToolGrant,
  User,
} from "../../infrastructure/database/db";

export type AdminOperationsSummaryRows = Readonly<{
  runCounts: readonly { status: string; count: number }[];
  dispatch: { pendingCount: number; oldestCreatedAt: Date | null } | undefined;
  submissionGroups: readonly {
    status: string;
    reasonCode: string | null;
    count: number;
    oldestCreatedAt: Date | null;
  }[];
  submissionCounts: readonly { status: string; count: number }[];
  openInterventionCount: number;
  workerRuntime: { mode: "off" | "live"; portalConfigValid: boolean; observedAt: Date } | null;
}>;

@Injectable()
export class AdminOperationsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return this.database.transaction(work);
  }

  async operationsSummary(tenantId: string): Promise<AdminOperationsSummaryRows> {
    const [runCounts, dispatchRows, submissionGroups, submissionCounts] = await Promise.all([
      this.database.query<{ status: string; count: number }>(
        `SELECT r.status, count(*)::int AS count FROM automation_runs r
         JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId
         GROUP BY r.status ORDER BY r.status`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ),
      this.database.query<{ pendingCount: number; oldestCreatedAt: Date | null }>(
        `SELECT count(*) FILTER (WHERE d.status IN ('pending', 'publishing', 'published'))::int AS "pendingCount",
                min(d.created_at) FILTER (WHERE d.status IN ('pending', 'publishing', 'published')) AS "oldestCreatedAt"
         FROM run_dispatch_outbox d JOIN automation_runs r ON r.id = d.run_id
         JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ),
      this.database.query<{
        status: string;
        reasonCode: string | null;
        count: number;
        oldestCreatedAt: Date | null;
      }>(
        `SELECT admission_state AS status, reason_code AS "reasonCode", count(*)::int AS count,
                min(created_at) AS "oldestCreatedAt"
         FROM run_submission_groups WHERE tenant_id = :tenantId
         GROUP BY admission_state, reason_code ORDER BY admission_state, reason_code NULLS FIRST`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ),
      this.database.query<{ status: string; count: number }>(
        `SELECT status, count(*)::int AS count FROM run_submissions
         WHERE tenant_id = :tenantId GROUP BY status ORDER BY status`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ),
    ]);
    const openInterventions = await this.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM manual_interventions mi
         JOIN automation_runs r ON r.id = mi.run_id JOIN import_batches b ON b.id = r.batch_id
         WHERE b.tenant_id = :tenantId AND mi.status = 'open'`,
      { replacements: { tenantId }, type: QueryTypes.SELECT },
    );
    const runtime = await this.database.query<{
      mode: "off" | "live";
      portalConfigValid: boolean;
      observedAt: Date;
    }>(
      `SELECT mode, portal_config_valid AS "portalConfigValid", observed_at AS "observedAt"
         FROM worker_runtime_status WHERE worker_id = 'portal-worker' LIMIT 1`,
      { type: QueryTypes.SELECT },
    );
    return {
      runCounts,
      dispatch: dispatchRows[0],
      submissionGroups,
      submissionCounts,
      openInterventionCount: Number(openInterventions[0]?.count ?? 0),
      workerRuntime: runtime[0] ?? null,
    };
  }

  operationsRuns(input: { tenantId: string; toolId: string | null; status: string | null; offset: number }) {
    return this.database.query(
      `SELECT r.id, r.tool_id AS "toolId", r.status, r.current_step AS "currentStep", r.row_number AS "rowNumber",
                r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.started_at AS "startedAt", r.finished_at AS "finishedAt",
                r.error_code AS "errorCode", b.id AS "batchId"
         FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
         WHERE b.tenant_id = :tenantId AND (:toolId IS NULL OR b.tool_id = :toolId)
           AND (:status IS NULL OR r.status = :status)
         ORDER BY r.created_at DESC, r.id DESC LIMIT :limit OFFSET :offset`,
      {
        replacements: {
          tenantId: input.tenantId,
          toolId: input.toolId,
          status: input.status,
          limit: 51,
          offset: input.offset,
        },
        type: QueryTypes.SELECT,
      },
    );
  }

  adminInterventions(input: {
    tenantId: string;
    status: string;
    assigneeUserId: string | null;
    toolId: string | null;
    priority: string | null;
    offset: number;
  }) {
    return this.database.query(
      `SELECT mi.intervention_id AS "interventionId", mi.run_id AS "runId", b.tool_id AS "toolId",
                mi.kind, mi.portal, mi.reason_code AS "reasonCode", mi.status, mi.priority, mi.due_at AS "dueAt",
                mi.assignee_user_id AS "assigneeUserId", assignee.username AS "assigneeUsername",
                mi.revision, mi.created_at AS "createdAt", mi.updated_at AS "updatedAt",
                r.row_number AS "rowNumber", r.current_step AS "currentStep", r.error_code AS "runErrorCode"
         FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
         JOIN import_batches b ON b.id = r.batch_id
         LEFT JOIN users assignee ON assignee.user_id = mi.assignee_user_id
         WHERE b.tenant_id = :tenantId AND (:status = 'all' OR mi.status = :status)
           AND (:assignee IS NULL OR mi.assignee_user_id = :assignee)
           AND (:toolId IS NULL OR b.tool_id = :toolId)
           AND (:priority IS NULL OR mi.priority = :priority)
         ORDER BY CASE WHEN mi.priority = 'high' THEN 0 ELSE 1 END, mi.created_at ASC, mi.intervention_id ASC
          LIMIT 51 OFFSET :offset`,
      {
        replacements: {
          tenantId: input.tenantId,
          status: input.status,
          assignee: input.assigneeUserId,
          toolId: input.toolId,
          priority: input.priority,
          offset: input.offset,
        },
        type: QueryTypes.SELECT,
      },
    );
  }

  async interventionActivity(tenantId: string, interventionId: string) {
    const scoped = await this.database.query<{ visible: boolean }>(
      `SELECT EXISTS (
           SELECT 1 FROM manual_interventions mi
           JOIN automation_runs r ON r.id = mi.run_id
           JOIN import_batches b ON b.id = r.batch_id
           WHERE mi.intervention_id = :interventionId AND b.tenant_id = :tenantId
         ) AS visible`,
      { replacements: { interventionId, tenantId }, type: QueryTypes.SELECT },
    );
    if (!scoped[0]?.visible) return null;
    const rows = await this.database.query(
      `SELECT ia.activity_id AS "activityId", ia.event_type AS "eventType",
                ia.previous_assignee_user_id AS "previousAssigneeUserId",
                previous.username AS "previousAssigneeUsername",
                ia.next_assignee_user_id AS "nextAssigneeUserId", next_user.username AS "nextAssigneeUsername",
                ia.priority, ia.created_at AS "createdAt", actor.username AS "actorUsername"
         FROM intervention_activity ia JOIN users actor ON actor.user_id = ia.actor_user_id
         LEFT JOIN users previous ON previous.user_id = ia.previous_assignee_user_id
         LEFT JOIN users next_user ON next_user.user_id = ia.next_assignee_user_id
         JOIN manual_interventions mi ON mi.intervention_id = ia.intervention_id
         JOIN automation_runs r ON r.id = mi.run_id JOIN import_batches b ON b.id = r.batch_id
         WHERE ia.intervention_id = :interventionId AND b.tenant_id = :tenantId
         ORDER BY ia.created_at DESC, ia.activity_id DESC LIMIT 100`,
      { replacements: { interventionId, tenantId }, type: QueryTypes.SELECT },
    );
    return rows;
  }

  findInterventionForUpdate(interventionId: string, transaction: Transaction) {
    return ManualIntervention.findByPk(interventionId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  findRun(runId: string, transaction: Transaction) {
    return AutomationRun.findByPk(runId, { transaction });
  }

  findBatch(batchId: string, transaction: Transaction) {
    return ImportBatch.findByPk(batchId, { transaction });
  }

  findAssigneeMembership(tenantId: string, userId: string, transaction: Transaction) {
    return TenantMembership.findOne({
      where: { tenantId, userId, status: "active" },
      include: [{ model: User, required: true, where: { status: "active" }, attributes: ["userId"] }],
      transaction,
    });
  }

  findToolGrant(tenantId: string, toolId: string, userId: string, transaction: Transaction) {
    return ToolGrant.findOne({ where: { tenantId, toolId, userId }, transaction });
  }

  saveIntervention(intervention: ManualIntervention, transaction: Transaction) {
    return intervention.save({ transaction });
  }

  createInterventionActivity(input: Parameters<typeof InterventionActivity.create>[0], transaction: Transaction) {
    return InterventionActivity.create(input, { transaction });
  }
}
