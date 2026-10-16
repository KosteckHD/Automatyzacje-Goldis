import { Injectable } from "@nestjs/common";
import { QueryTypes } from "sequelize";
import { InterventionUserRead, ManualIntervention, sequelize } from "../../infrastructure/database/db";

export type InterventionListRow = {
  interventionId: string;
  runId: string;
  batchId: string;
  rowNumber: number;
  runStatus: string;
  kind: string;
  portal: string | null;
  reasonCode: string | null;
  status: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  challengeId: string | null;
  challengeStatus: string | null;
  expiresAt: Date | null;
  attemptCount: number | null;
  attemptLimit: number | null;
  seenRevision: number | null;
  fieldCode: string | null;
  manualDataVersion: number;
  lastSafeStep: string | null;
  externalCaseRef: string | null;
  assigneeUserId: string | null;
  assigneeUsername: string | null;
  priority: "normal" | "high";
  dueAt: Date | null;
  canViewResults: boolean;
  canExecute: boolean;
  overrideVersion: number | null;
  overrideFields: Record<string, unknown> | null;
  errorCode: string | null;
  retryCount: number;
  ownerUserId: string;
  startedByUserId: string | null;
};

export type InterventionListQuery = {
  tenantId: string;
  userId: string;
  role: string;
  status: string;
  portal: string | null;
  kind: string | null;
  cursorCreated: string | null;
  cursorId: string | null;
  fetchLimit: number;
};

export type InterventionSummaryRow = { openCount: string; unreadCount: string; smsCount: string };

@Injectable()
export class InterventionRepository {
  list(query: InterventionListQuery) {
    const ownerFilter =
      query.role === "operator"
        ? "AND (b.owner_user_id = :userId OR mi.assignee_user_id = :userId OR r.started_by_user_id = :userId)"
        : "";
    const toolFilter =
      query.role === "admin"
        ? ""
        : "AND t.status <> 'disabled' AND EXISTS (SELECT 1 FROM tool_grants tg " +
          "WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id AND tg.user_id = :userId " +
          "AND (tg.can_view_results OR (mi.kind = 'sms' AND (mi.assignee_user_id = :userId OR b.owner_user_id = :userId OR r.started_by_user_id = :userId) AND tg.can_execute)))";
    return sequelize.query<InterventionListRow>(
      `SELECT mi.intervention_id AS "interventionId", r.id AS "runId", r.batch_id AS "batchId",
              r.row_number AS "rowNumber", r.status AS "runStatus", mi.kind, mi.portal,
              r.error_code AS "errorCode",
              CASE WHEN mi.portal = 'compensa' THEN r.compensa_sms_retry_count ELSE r.pzu_sms_retry_count END AS "retryCount",
              b.owner_user_id AS "ownerUserId", r.started_by_user_id AS "startedByUserId",
              mi.reason_code AS "reasonCode", mi.status, mi.revision,
              mi.assignee_user_id AS "assigneeUserId", assignee.username AS "assigneeUsername",
              mi.priority, mi.due_at AS "dueAt",
              (:isAdmin OR EXISTS (SELECT 1 FROM tool_grants view_grant WHERE view_grant.tenant_id = b.tenant_id
                AND view_grant.tool_id = b.tool_id AND view_grant.user_id = :userId
                AND view_grant.can_view_results)) AS "canViewResults",
              (:isAdmin OR EXISTS (SELECT 1 FROM tool_grants execute_grant WHERE execute_grant.tenant_id = b.tenant_id
                AND execute_grant.tool_id = b.tool_id AND execute_grant.user_id = :userId AND execute_grant.can_execute)) AS "canExecute",
              mi.field_code AS "fieldCode", r.manual_data_version AS "manualDataVersion",
              r.last_safe_step AS "lastSafeStep", r.external_case_ref AS "externalCaseRef",
              mi.created_at AS "createdAt", mi.updated_at AS "updatedAt",
              ch.challenge_id AS "challengeId", ch.status AS "challengeStatus", ch.expires_at AS "expiresAt",
              ch.attempt_count AS "attemptCount", ch.attempt_limit AS "attemptLimit", ur.seen_revision AS "seenRevision",
              ov.version AS "overrideVersion", ov.fields AS "overrideFields"
       FROM manual_interventions mi
       JOIN automation_runs r ON r.id = mi.run_id
       JOIN import_batches b ON b.id = r.batch_id
       JOIN tools t ON t.tool_id = b.tool_id AND t.tool_id = r.tool_id
       LEFT JOIN users assignee ON assignee.user_id = mi.assignee_user_id
       LEFT JOIN auth_challenges ch ON ch.challenge_id = r.current_auth_challenge_id AND ch.run_id = r.id
       LEFT JOIN intervention_user_reads ur ON ur.intervention_id = mi.intervention_id AND ur.user_id = :userId
       LEFT JOIN LATERAL (
         SELECT MAX(version) AS version, jsonb_object_agg(field_name, field_value) AS fields
         FROM (
           SELECT DISTINCT ON (entry.key) override.version, entry.key AS field_name, entry.value AS field_value
           FROM run_manual_data_overrides override
           CROSS JOIN LATERAL jsonb_each(override.fields) entry
           WHERE override.run_id = r.id
           ORDER BY entry.key, override.version DESC
         ) latest_fields
       ) ov ON true
       WHERE b.tenant_id = :tenantId ${ownerFilter} ${toolFilter}
         AND (:status = 'all' OR mi.status = :status)
         AND (:portal IS NULL OR mi.portal = :portal)
         AND (:kind IS NULL OR mi.kind = :kind)
         AND (:cursorCreated IS NULL OR (mi.created_at, mi.intervention_id) < (:cursorCreated, :cursorId))
       ORDER BY mi.created_at DESC, mi.intervention_id DESC LIMIT :fetchLimit`,
      {
        replacements: {
          tenantId: query.tenantId,
          userId: query.userId,
          status: query.status,
          isAdmin: query.role === "admin",
          portal: query.portal,
          kind: query.kind,
          cursorCreated: query.cursorCreated,
          cursorId: query.cursorId,
          fetchLimit: query.fetchLimit,
        },
        type: QueryTypes.SELECT,
      },
    );
  }

  async summary(input: { tenantId: string; userId: string; role: string }): Promise<InterventionSummaryRow | null> {
    const ownerFilter =
      input.role === "operator"
        ? "AND (b.owner_user_id = :userId OR mi.assignee_user_id = :userId OR r.started_by_user_id = :userId)"
        : "";
    const toolFilter =
      input.role === "admin"
        ? ""
        : "AND t.status <> 'disabled' AND EXISTS (SELECT 1 FROM tool_grants tg " +
          "WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id AND tg.user_id = :userId " +
          "AND (tg.can_view_results OR (mi.kind = 'sms' AND (mi.assignee_user_id = :userId OR b.owner_user_id = :userId OR r.started_by_user_id = :userId) AND tg.can_execute)))";
    const rows = await sequelize.query<InterventionSummaryRow>(
      `SELECT COUNT(*) FILTER (WHERE mi.status = 'open')::int AS "openCount",
              COUNT(*) FILTER (WHERE mi.status = 'open' AND COALESCE(ur.seen_revision, 0) < mi.revision)::int AS "unreadCount",
              COUNT(*) FILTER (WHERE mi.status = 'open' AND mi.kind = 'sms'
                AND ch.status = 'active' AND ch.expires_at > now()
                AND r.started_by_user_id = :userId
                AND EXISTS (SELECT 1 FROM tool_grants sms_grant
                  WHERE sms_grant.tenant_id = b.tenant_id AND sms_grant.tool_id = b.tool_id
                    AND sms_grant.user_id = :userId AND sms_grant.can_execute))::int AS "smsCount"
       FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
       JOIN import_batches b ON b.id = r.batch_id
       JOIN tools t ON t.tool_id = b.tool_id AND t.tool_id = r.tool_id
       LEFT JOIN auth_challenges ch ON ch.challenge_id = r.current_auth_challenge_id AND ch.run_id = r.id
       LEFT JOIN intervention_user_reads ur ON ur.intervention_id = mi.intervention_id AND ur.user_id = :userId
       WHERE b.tenant_id = :tenantId ${ownerFilter} ${toolFilter}`,
      { replacements: { tenantId: input.tenantId, userId: input.userId }, type: QueryTypes.SELECT },
    );
    return rows[0] ?? null;
  }

  async markRead(interventionId: string, userId: string) {
    return sequelize.transaction(async (transaction) => {
      const intervention = await ManualIntervention.findByPk(interventionId, {
        attributes: ["interventionId", "revision"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!intervention) return null;
      const read = await InterventionUserRead.findOne({
        where: { interventionId, userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (read) {
        read.seenRevision = intervention.revision;
        read.updatedAt = new Date();
        await read.save({ transaction });
      } else {
        await InterventionUserRead.create(
          { interventionId, userId, seenRevision: intervention.revision, updatedAt: new Date() },
          { transaction },
        );
      }
      return { interventionId, seenRevision: intervention.revision, isUnread: false };
    });
  }
}
