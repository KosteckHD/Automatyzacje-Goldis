import { Injectable } from "@nestjs/common";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../infrastructure/database/db";
import { listToolAccess } from "../authorization/public";

type OperationRow = {
  id: string;
  resultSetId: string;
  toolId: string;
  toolName: string;
  sourceType: string;
  sourceId: string;
  batchId: string;
  fileName: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  leadCount: number;
  readyCount: number;
  failedCount: number;
};

@Injectable()
export class DashboardService {
  async get(actor: { tenantId: string; userId: string; role: string }) {
    const accesses = await listToolAccess({
      tenantId: actor.tenantId,
      userId: actor.userId,
      role: actor.role as "admin" | "manager" | "operator" | "reviewer" | "auditor",
    });
    const ocAccess = accesses.find((item) => item.toolId === "oc-policy-verification");
    const canReadOc = Boolean(ocAccess?.canViewResults);

    const [operations, ownOperationMetrics, ownLeadMetrics, teamLeadMetrics, unreadNotifications] = await Promise.all([
      canReadOc
        ? sequelize.query<OperationRow>(
            `SELECT result_set.result_set_id AS id, result_set.result_set_id AS "resultSetId",
                result_set.tool_id AS "toolId", COALESCE(tool.display_name, result_set.tool_id) AS "toolName",
                result_set.source_type AS "sourceType", result_set.source_id AS "sourceId",
                result_set.batch_id AS "batchId", batch.file_name AS "fileName", result_set.status,
                result_set.created_at AS "createdAt", result_set.updated_at AS "updatedAt", result_set.finished_at AS "finishedAt",
                COUNT(lead.lead_id)::int AS "leadCount",
                COUNT(lead.lead_id) FILTER (WHERE lead.result_status = 'ready')::int AS "readyCount",
                COUNT(lead.lead_id) FILTER (WHERE lead.result_status = 'failed')::int AS "failedCount"
           FROM result_sets result_set
           LEFT JOIN tools tool ON tool.tool_id = result_set.tool_id
           LEFT JOIN import_batches batch ON batch.id = result_set.batch_id AND batch.tenant_id = result_set.tenant_id
           LEFT JOIN business_leads lead ON lead.result_set_id = result_set.result_set_id
          WHERE result_set.tenant_id = :tenantId AND result_set.actor_user_id = :userId
            AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
              AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
          GROUP BY result_set.result_set_id, tool.display_name, batch.file_name
          ORDER BY result_set.created_at DESC, result_set.result_set_id DESC LIMIT 8`,
            { replacements: { tenantId: actor.tenantId, userId: actor.userId }, type: QueryTypes.SELECT },
          )
        : Promise.resolve([]),
      canReadOc
        ? sequelize
            .query<{ total: number; active: number; attention: number; completed: number }>(
              `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('queued','running'))::int AS active,
                COUNT(*) FILTER (WHERE status = 'waiting_attention')::int AS attention,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM result_sets result_set WHERE result_set.tenant_id = :tenantId AND result_set.actor_user_id = :userId AND result_set.tool_id = 'oc-policy-verification'
             AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
               AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')`,
              { replacements: { tenantId: actor.tenantId, userId: actor.userId }, type: QueryTypes.SELECT },
            )
            .then((rows) => rows[0] ?? { total: 0, active: 0, attention: 0, completed: 0 })
        : Promise.resolve({ total: 0, active: 0, attention: 0, completed: 0 }),
      canReadOc
        ? sequelize
            .query<{ total: number; notContacted: number; accepted: number; notInterested: number }>(
              `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE contact_status = 'not_contacted')::int AS "notContacted",
                COUNT(*) FILTER (WHERE contact_status = 'offer_accepted')::int AS accepted,
                COUNT(*) FILTER (WHERE contact_status = 'not_interested')::int AS "notInterested"
           FROM business_leads lead JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
          WHERE lead.tenant_id = :tenantId AND lead.assigned_to_user_id = :userId
            AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
              AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')`,
              { replacements: { tenantId: actor.tenantId, userId: actor.userId }, type: QueryTypes.SELECT },
            )
            .then((rows) => rows[0] ?? { total: 0, notContacted: 0, accepted: 0, notInterested: 0 })
        : Promise.resolve({ total: 0, notContacted: 0, accepted: 0, notInterested: 0 }),
      canReadOc && (actor.role === "manager" || actor.role === "admin")
        ? sequelize
            .query<{
              unassigned: number;
              assigned: number;
              notContacted: number;
              accepted: number;
              notInterested: number;
            }>(
              `SELECT COUNT(*) FILTER (WHERE assigned_to_user_id IS NULL)::int AS unassigned,
                COUNT(*) FILTER (WHERE assigned_to_user_id IS NOT NULL)::int AS assigned,
                COUNT(*) FILTER (WHERE contact_status = 'not_contacted' AND assigned_to_user_id IS NOT NULL)::int AS "notContacted",
                COUNT(*) FILTER (WHERE contact_status = 'offer_accepted' AND assigned_to_user_id IS NOT NULL)::int AS accepted,
                COUNT(*) FILTER (WHERE contact_status = 'not_interested' AND assigned_to_user_id IS NOT NULL)::int AS "notInterested"
           FROM business_leads lead JOIN result_sets result_set ON result_set.result_set_id = lead.result_set_id AND result_set.tenant_id = lead.tenant_id
          WHERE lead.tenant_id = :tenantId AND lead.tool_id = 'oc-policy-verification' AND lead.result_status = 'ready'
            AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
              AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')`,
              { replacements: { tenantId: actor.tenantId }, type: QueryTypes.SELECT },
            )
            .then((rows) => rows[0] ?? { unassigned: 0, assigned: 0, notContacted: 0, accepted: 0, notInterested: 0 })
        : Promise.resolve(null),
      sequelize
        .query<{ count: number }>(
          `SELECT count(*)::int AS count FROM user_notifications notification
          JOIN result_sets result_set ON result_set.result_set_id = notification.result_set_id AND result_set.tenant_id = notification.tenant_id
         WHERE notification.tenant_id = :tenantId AND notification.recipient_user_id = :userId AND notification.read_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
             AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')`,
          { replacements: { tenantId: actor.tenantId, userId: actor.userId }, type: QueryTypes.SELECT },
        )
        .then((rows) => Number(rows[0]?.count ?? 0)),
    ]);

    return {
      role: actor.role,
      tools: accesses.map((item) => ({
        toolId: item.toolId,
        canExecute: item.canExecute,
        canViewResults: item.canViewResults,
        canDownloadResults: item.canDownloadResults,
      })),
      metrics: { operations: ownOperationMetrics, myLeads: ownLeadMetrics, team: teamLeadMetrics },
      operations: operations.map((item) => ({
        ...item,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        finishedAt: item.finishedAt ? new Date(item.finishedAt).toISOString() : null,
      })),
      actionRequired: operations
        .filter((item) => item.status === "waiting_attention")
        .map((item) => ({
          id: item.resultSetId,
          toolName: item.toolName,
          fileName: item.fileName,
          createdAt: new Date(item.updatedAt).toISOString(),
          href:
            item.sourceType === "run_submission"
              ? `/submissions/${encodeURIComponent(item.sourceId)}`
              : `/imports/${encodeURIComponent(item.batchId)}`,
          status: item.status,
        })),
      unreadNotifications,
    };
  }
}
