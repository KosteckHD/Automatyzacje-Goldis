import { BadRequestException, Controller, ForbiddenException, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { QueryTypes } from "sequelize";
import { sequelize } from "./db";
import { readSessionPrincipal, SessionGuard, type SessionPrincipal } from "./session";
import { AdminOnlyGuard } from "./admin";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { createListCursor, filterFingerprint, parseIsoDateTime, parseListCursor, parseListLimit } from "./list-query";

const toolIdPattern = /^[a-z0-9][a-z0-9-]{1,79}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reviewerAuditActions = new Set([
  "import.created", "run.created", "run.cancelled", "run.auth_resumed", "run.review_resumed",
  "run.manual_data_corrected", "sms.submitted", "regon.correction.proposed", "artifact.downloaded",
  "intervention.assigned", "intervention.unassigned", "intervention.priority_changed", "intervention.resolved",
]);
const reviewerAuditResourceTypes = new Set(["import", "run", "artifact", "intervention", "correction"]);

function actor(request: Request): SessionPrincipal {
  const current = readSessionPrincipal(request);
  if (!current) throw new ForbiddenException();
  return current;
}

function range(from?: string, to?: string, maxDays = 90) {
  if (!from || !to) throw new BadRequestException("Podaj from i to jako czasy ISO ze strefą");
  const start = new Date(parseIsoDateTime(from, "from")!);
  const end = new Date(parseIsoDateTime(to, "to")!);
  if (start >= end || end.getTime() - start.getTime() > maxDays * 24 * 60 * 60 * 1000) {
    throw new BadRequestException(`Zakres musi być rosnący i nie może przekraczać ${maxDays} dni`);
  }
  return { start, end };
}

function validateTool(toolId?: string) {
  if (toolId !== undefined && !toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowe narzędzie");
}

export async function auditQuery(input: {
  principal: SessionPrincipal; from?: string; to?: string; actorId?: string; action?: string;
  resourceType?: string; resourceId?: string; outcome?: string; toolId?: string; limit?: string; cursor?: string;
}) {
  const { start, end } = range(input.from, input.to, 90);
  validateTool(input.toolId);
  const limit = parseListLimit(input.limit);
  if ((input.actorId && !uuidPattern.test(input.actorId))
    || (input.action && !/^[a-z][a-z0-9_.]{1,59}$/.test(input.action))
    || (input.resourceType && !/^[a-z][a-z0-9_]{1,39}$/.test(input.resourceType))
    || (input.resourceId && input.resourceId.length > 80)
    || (input.outcome && !new Set(["succeeded", "denied", "failed"]).has(input.outcome))) {
    throw new BadRequestException("Nieprawidłowy filtr audytu");
  }
  if (input.principal.role === "reviewer") {
    if (input.action && !reviewerAuditActions.has(input.action)) throw new BadRequestException("Ta kategoria nie jest dostępna w dzienniku operacyjnym recenzenta");
    if (input.resourceType && !reviewerAuditResourceTypes.has(input.resourceType)) throw new BadRequestException("Ten typ zasobu nie jest dostępny w dzienniku operacyjnym recenzenta");
  }
  const fingerprint = filterFingerprint("audit", {
    tenantId: input.principal.tenantId, userId: input.principal.role === "reviewer" ? input.principal.userId : undefined,
    role: input.principal.role, from: start.toISOString(), to: end.toISOString(), actorId: input.actorId,
    action: input.action, resourceType: input.resourceType, resourceId: input.resourceId,
    outcome: input.outcome, toolId: input.toolId, limit,
  });
  const cursor = parseListCursor(input.cursor, fingerprint);
  const reviewerToolGrantScope = `(
         (a.resource_type = 'import' AND EXISTS (
           SELECT 1 FROM import_batches b WHERE b.id::text = a.resource_id AND b.tenant_id = :tenantId
             AND EXISTS (SELECT 1 FROM tool_grants tg WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id
               AND tg.user_id = :viewerUserId AND (tg.can_view_results = TRUE OR tg.can_download_results = TRUE))
         ))
         OR (a.resource_type = 'run' AND EXISTS (
           SELECT 1 FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
           WHERE r.id::text = a.resource_id AND b.tenant_id = :tenantId
             AND EXISTS (SELECT 1 FROM tool_grants tg WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id
               AND tg.user_id = :viewerUserId AND (tg.can_view_results = TRUE OR tg.can_download_results = TRUE))
         ))
         OR (a.resource_type = 'artifact' AND EXISTS (
           SELECT 1 FROM export_artifacts e JOIN automation_runs r ON r.id = e.run_id
           JOIN import_batches b ON b.id = r.batch_id
           WHERE (e.artifact_id::text = a.resource_id OR e.run_id::text = a.resource_id) AND b.tenant_id = :tenantId
             AND EXISTS (SELECT 1 FROM tool_grants tg WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id
               AND tg.user_id = :viewerUserId AND (tg.can_view_results = TRUE OR tg.can_download_results = TRUE))
         ))
         OR (a.resource_type = 'intervention' AND EXISTS (
           SELECT 1 FROM manual_interventions i JOIN automation_runs r ON r.id = i.run_id
           JOIN import_batches b ON b.id = r.batch_id
           WHERE i.intervention_id::text = a.resource_id AND b.tenant_id = :tenantId
             AND EXISTS (SELECT 1 FROM tool_grants tg WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id
               AND tg.user_id = :viewerUserId AND (tg.can_view_results = TRUE OR tg.can_download_results = TRUE))
         ))
         OR (a.resource_type = 'correction' AND EXISTS (
           SELECT 1 FROM regon_corrections rc JOIN source_rows sr ON sr.id = rc.source_row_id
           JOIN import_batches b ON b.id = sr.batch_id
           WHERE rc.correction_id::text = a.resource_id AND b.tenant_id = :tenantId
             AND EXISTS (SELECT 1 FROM tool_grants tg WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id
               AND tg.user_id = :viewerUserId AND (tg.can_view_results = TRUE OR tg.can_download_results = TRUE))
         ))
       )`;
  const reviewerPolicy = input.principal.role === "reviewer"
    ? `AND a.action IN ('import.created', 'run.created', 'run.cancelled', 'run.auth_resumed', 'run.review_resumed',
        'run.manual_data_corrected', 'sms.submitted', 'regon.correction.proposed', 'artifact.downloaded',
        'intervention.assigned', 'intervention.unassigned', 'intervention.priority_changed', 'intervention.resolved')
       AND ${reviewerToolGrantScope}`
    : "";
  const rows = await sequelize.query<{
    eventId: string; actorUserId: string | null; actorUsername: string | null; action: string;
    resourceType: string; resourceId: string | null; outcome: string; requestRef: string | null; createdAt: Date;
  }>(
    `SELECT a.event_id AS "eventId", a.actor_user_id AS "actorUserId", u.username AS "actorUsername",
            a.action, a.resource_type AS "resourceType", a.resource_id AS "resourceId",
            a.outcome, a.request_ref AS "requestRef", a.created_at AS "createdAt"
     FROM audit_events a LEFT JOIN users u ON u.user_id = a.actor_user_id
     WHERE a.tenant_id = :tenantId AND a.created_at >= :from AND a.created_at < :to
       AND (:actorId IS NULL OR a.actor_user_id = :actorId)
       AND (:action IS NULL OR a.action = :action)
       AND (:resourceType IS NULL OR a.resource_type = :resourceType)
       AND (:resourceId IS NULL OR a.resource_id = :resourceId)
       AND (:outcome IS NULL OR a.outcome = :outcome)
       AND (:toolId IS NULL OR (
         (a.resource_type = 'tool' AND a.resource_id = :toolId)
         OR (a.resource_type = 'settings' AND a.resource_id = :toolId)
         OR (a.resource_type = 'import' AND EXISTS (
           SELECT 1 FROM import_batches b WHERE b.id::text = a.resource_id AND b.tool_id = :toolId
         ))
         OR (a.resource_type = 'run' AND EXISTS (
           SELECT 1 FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
           WHERE r.id::text = a.resource_id AND b.tool_id = :toolId
         ))
         OR (a.resource_type = 'artifact' AND EXISTS (
           SELECT 1 FROM export_artifacts e JOIN automation_runs r ON r.id = e.run_id
           JOIN import_batches b ON b.id = r.batch_id
           WHERE (e.artifact_id::text = a.resource_id OR e.run_id::text = a.resource_id) AND b.tool_id = :toolId
         ))
         OR (a.resource_type = 'intervention' AND EXISTS (
           SELECT 1 FROM manual_interventions i JOIN automation_runs r ON r.id = i.run_id
           JOIN import_batches b ON b.id = r.batch_id
           WHERE i.intervention_id::text = a.resource_id AND b.tool_id = :toolId
         ))
         OR (a.resource_type = 'correction' AND EXISTS (
           SELECT 1 FROM regon_corrections rc JOIN source_rows sr ON sr.id = rc.source_row_id
           JOIN import_batches b ON b.id = sr.batch_id
           WHERE rc.correction_id::text = a.resource_id AND b.tool_id = :toolId
         ))
       ))
       ${reviewerPolicy}
       AND (:cursorTime IS NULL OR (a.created_at, a.event_id) < (:cursorTime, CAST(:cursorId AS uuid)))
     ORDER BY a.created_at DESC, a.event_id DESC LIMIT :fetchLimit`,
    { replacements: {
      tenantId: input.principal.tenantId, from: start, to: end, actorId: input.actorId ?? null,
      action: input.action ?? null, resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null,
      outcome: input.outcome ?? null, toolId: input.toolId ?? null,
      viewerUserId: input.principal.userId, cursorTime: cursor?.createdAt ?? null, cursorId: cursor?.id ?? null, fetchLimit: limit + 1,
    }, type: QueryTypes.SELECT },
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? createListCursor(last.createdAt, last.eventId, fingerprint) : null,
  };
}

@Controller("audit")
@UseGuards(SessionGuard, PermissionGuard)
export class AuditSearchController {
  @Get("events")
  @RequirePermission("audit:read", "collection")
  async search(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const current = actor(request);
    return auditQuery({
      principal: current, from: query.from, to: query.to, actorId: query.actorId,
      action: query.action, resourceType: query.resourceType, resourceId: query.resourceId,
      outcome: query.outcome, toolId: query.toolId, limit: query.limit, cursor: query.cursor,
    });
  }
}

@Controller("admin/reports")
@UseGuards(SessionGuard, AdminOnlyGuard)
export class AdminReportsController {
  @Get("overview")
  async overview(@Req() request: Request, @Query("from") from?: string, @Query("to") to?: string, @Query("toolId") toolId?: string) {
    const current = actor(request);
    const { start, end } = range(from, to, 366);
    validateTool(toolId);
    const rows = await sequelize.query<{
      createdCount: number; completedCount: number; noPoliciesCount: number; failedCount: number; inProgressCount: number;
      medianRunSeconds: number | null; p90RunSeconds: number | null; medianResolvedSeconds: number | null; openInterventionCount: number;
    }>(
      `SELECT count(*) FILTER (WHERE r.created_at >= :from AND r.created_at < :to)::int AS "createdCount",
              count(*) FILTER (WHERE r.status = 'completed' AND r.finished_at >= :from AND r.finished_at < :to)::int AS "completedCount",
              count(*) FILTER (WHERE r.status = 'no_matching_policies' AND r.finished_at >= :from AND r.finished_at < :to)::int AS "noPoliciesCount",
              count(*) FILTER (WHERE r.status = 'failed' AND r.finished_at >= :from AND r.finished_at < :to)::int AS "failedCount",
              count(*) FILTER (WHERE r.created_at >= :from AND r.created_at < :to
                AND r.status NOT IN ('completed','no_matching_policies','failed','cancelled'))::int AS "inProgressCount",
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.finished_at - r.started_at)))
                FILTER (WHERE r.status = 'completed' AND r.started_at IS NOT NULL AND r.finished_at >= :from AND r.finished_at < :to) AS "medianRunSeconds",
              percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (r.finished_at - r.started_at)))
                FILTER (WHERE r.status = 'completed' AND r.started_at IS NOT NULL AND r.finished_at >= :from AND r.finished_at < :to) AS "p90RunSeconds",
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (mi.resolved_at - mi.created_at)))
               FROM manual_interventions mi
               JOIN automation_runs ir ON ir.id = mi.run_id JOIN import_batches ib ON ib.id = ir.batch_id
               WHERE ib.tenant_id = :tenantId AND (:toolId IS NULL OR ib.tool_id = :toolId)
                 AND mi.status = 'resolved' AND mi.resolved_at >= :from AND mi.resolved_at < :to) AS "medianResolvedSeconds",
              (SELECT count(*)::int FROM manual_interventions mi
               JOIN automation_runs ir ON ir.id = mi.run_id JOIN import_batches ib ON ib.id = ir.batch_id
               WHERE ib.tenant_id = :tenantId AND (:toolId IS NULL OR ib.tool_id = :toolId)
                 AND mi.status = 'open' AND mi.created_at >= :from AND mi.created_at < :to) AS "openInterventionCount"
       FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND (:toolId IS NULL OR b.tool_id = :toolId)`,
      { replacements: { tenantId: current.tenantId, from: start, to: end, toolId: toolId ?? null }, type: QueryTypes.SELECT },
    );
    const item = rows[0] ?? { createdCount: 0, completedCount: 0, noPoliciesCount: 0, failedCount: 0, inProgressCount: 0, medianRunSeconds: null, p90RunSeconds: null, medianResolvedSeconds: null, openInterventionCount: 0 };
    const denominator = Number(item.completedCount) + Number(item.noPoliciesCount) + Number(item.failedCount);
    const [downloads, generated] = await Promise.all([sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events a
       WHERE a.tenant_id = :tenantId AND a.action = 'artifact.downloaded'
         AND a.created_at >= :from AND a.created_at < :to
         AND (:toolId IS NULL OR EXISTS (
           SELECT 1 FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
           WHERE r.id::text = a.resource_id AND b.tool_id = :toolId
         ))`,
      { replacements: { tenantId: current.tenantId, from: start, to: end, toolId: toolId ?? null }, type: QueryTypes.SELECT },
    ), sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM export_artifacts e
       JOIN automation_runs r ON r.id = e.run_id JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND e.state = 'ready' AND e.ready_at >= :from AND e.ready_at < :to
         AND (:toolId IS NULL OR b.tool_id = :toolId)`,
      { replacements: { tenantId: current.tenantId, from: start, to: end, toolId: toolId ?? null }, type: QueryTypes.SELECT },
    )]);
    const daily = await sequelize.query(
      `SELECT (r.created_at AT TIME ZONE 'Europe/Warsaw')::date AS day,
              count(*)::int AS created,
              count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE r.status = 'no_matching_policies')::int AS noPolicies,
              count(*) FILTER (WHERE r.status = 'failed')::int AS failed
       FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND r.created_at >= :from AND r.created_at < :to
         AND (:toolId IS NULL OR b.tool_id = :toolId)
       GROUP BY day ORDER BY day`,
      { replacements: { tenantId: current.tenantId, from: start, to: end, toolId: toolId ?? null }, type: QueryTypes.SELECT },
    );
    return {
      from: start.toISOString(), to: end.toISOString(), toolId: toolId ?? null,
      counts: {
        created: Number(item.createdCount), completed: Number(item.completedCount),
        noPolicies: Number(item.noPoliciesCount), failed: Number(item.failedCount),
        inProgress: Number(item.inProgressCount), downloads: Number(downloads[0]?.count ?? 0),
        generated: Number(generated[0]?.count ?? 0), openInterventions: Number(item.openInterventionCount),
      },
      completionRate: denominator ? Number(item.completedCount) / denominator : null,
      durationSeconds: { median: item.medianRunSeconds, p90: item.p90RunSeconds },
      medianResolvedInterventionSeconds: item.medianResolvedSeconds,
      daily,
      definitions: {
        created: "run.created_at w zakresie",
        completed: "status completed i finished_at w zakresie",
        noPolicies: "status no_matching_policies i finished_at w zakresie; osobna kategoria wyniku",
        failed: "status failed i finished_at w zakresie",
        completionRate: "completed / (completed + noPolicies + failed), według finished_at",
        duration: "started_at do finished_at, tylko zakończone completed",
        downloads: "zdarzenia artifact.downloaded w zakresie",
        generated: "gotowe rekordy export_artifacts według ready_at w zakresie",
        inProgress: "bieżący stan runów utworzonych w tym zakresie",
        openInterventions: "zgłoszenia utworzone w zakresie, które nadal są otwarte",
        interventionDuration: "mediana resolved_at minus created_at, tylko zamknięte w zakresie",
      },
    };
  }

  @Get("failures")
  async failures(@Req() request: Request, @Query("from") from?: string, @Query("to") to?: string, @Query("toolId") toolId?: string) {
    const current = actor(request);
    const { start, end } = range(from, to, 366);
    validateTool(toolId);
    const rows = await sequelize.query(
      `SELECT r.error_code AS "errorCode", r.status, count(*)::int AS count,
              min(r.created_at) AS "firstSeenAt", max(r.created_at) AS "lastSeenAt"
       FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND r.status = 'failed' AND r.finished_at >= :from AND r.finished_at < :to
         AND (:toolId IS NULL OR b.tool_id = :toolId)
       GROUP BY r.error_code, r.status ORDER BY count DESC, r.error_code LIMIT 100`,
      { replacements: { tenantId: current.tenantId, from: start, to: end, toolId: toolId ?? null }, type: QueryTypes.SELECT },
    );
    return { items: rows };
  }

  @Get("interventions")
  async interventions(@Req() request: Request, @Query("from") from?: string, @Query("to") to?: string, @Query("toolId") toolId?: string) {
    const current = actor(request);
    const { start, end } = range(from, to, 366);
    validateTool(toolId);
    const rows = await sequelize.query(
      `SELECT mi.kind, mi.status, mi.reason_code AS "reasonCode", count(*)::int AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (mi.resolved_at - mi.created_at)))
                FILTER (WHERE mi.status = 'resolved') AS "medianResolutionSeconds",
              count(*) FILTER (WHERE mi.status = 'open')::int AS "openCount"
       FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
       JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND mi.created_at >= :from AND mi.created_at < :to
         AND (:toolId IS NULL OR b.tool_id = :toolId)
       GROUP BY mi.kind, mi.status, mi.reason_code ORDER BY count DESC LIMIT 100`,
      { replacements: { tenantId: current.tenantId, from: start, to: end, toolId: toolId ?? null }, type: QueryTypes.SELECT },
    );
    return { items: rows };
  }

  @Get("throughput")
  async throughput(@Req() request: Request, @Query("from") from?: string, @Query("to") to?: string, @Query("toolId") toolId?: string) {
    const current = actor(request);
    const { start, end } = range(from, to, 366);
    validateTool(toolId);
    const rows = await sequelize.query(
      `SELECT date_trunc('day', r.created_at AT TIME ZONE 'Europe/Warsaw') AS day,
              count(*)::int AS created,
              count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE r.status = 'no_matching_policies')::int AS noPolicies,
              count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.finished_at - r.started_at)))
                FILTER (WHERE r.status = 'completed' AND r.started_at IS NOT NULL) AS "medianRunSeconds"
       FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
       WHERE b.tenant_id = :tenantId AND r.created_at >= :from AND r.created_at < :to
         AND (:toolId IS NULL OR b.tool_id = :toolId)
       GROUP BY day ORDER BY day`,
      { replacements: { tenantId: current.tenantId, from: start, to: end, toolId: toolId ?? null }, type: QueryTypes.SELECT },
    );
    return { items: rows };
  }
}
