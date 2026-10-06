import {
  BadRequestException, Body, Controller, Get, HttpCode, Injectable, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { QueryTypes } from "sequelize";
import { InterventionUserRead, sequelize } from "./db";
import { RequirePermission } from "./authorization-guard";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "./session";
import { PermissionGuard } from "./authorization-guard";
import { canResumeManualIntervention } from "./manual-data";
import { canRetrySms } from "./sms-retry-policy";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(["open", "resolved", "cancelled", "expired", "all"]);
const portals = new Set(["pzu", "compensa"]);
const kinds = new Set(["sms", "identity_review", "portal_error"]);
const cursorTime = (value: string): boolean => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

type InterventionRow = {
  interventionId: string; runId: string; batchId: string; rowNumber: number; runStatus: string;
  kind: string; portal: string | null; reasonCode: string | null; status: string; revision: number;
  createdAt: Date; updatedAt: Date; challengeId: string | null; challengeStatus: string | null;
  expiresAt: Date | null; attemptCount: number | null; attemptLimit: number | null; seenRevision: number | null;
  fieldCode: string | null; manualDataVersion: number; lastSafeStep: string | null; externalCaseRef: string | null;
  assigneeUserId: string | null; assigneeUsername: string | null; priority: "normal" | "high"; dueAt: Date | null;
  canViewResults: boolean; canExecute: boolean;
  overrideVersion: number | null; overrideFields: Record<string, unknown> | null;
  errorCode: string | null; retryCount: number; ownerUserId: string;
};

@Injectable()
export class InterventionService {
  async list(input: { tenantId: string; userId: string; role: string }, query: {
    status?: string; portal?: string; kind?: string; limit?: string; cursor?: string;
  }) {
    const status = query.status ?? "open";
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!statuses.has(status) || !Number.isInteger(limit) || limit < 1 || limit > 100
      || (query.portal !== undefined && !portals.has(query.portal))
      || (query.kind !== undefined && !kinds.has(query.kind))) {
      throw new BadRequestException("Nieprawidłowy filtr zgłoszeń");
    }
    let cursor: { createdAt: string; interventionId: string } | null = null;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof decoded.createdAt !== "string" || !cursorTime(decoded.createdAt)
          || typeof decoded.interventionId !== "string" || !uuidPattern.test(decoded.interventionId)) throw new Error();
        cursor = { createdAt: decoded.createdAt, interventionId: decoded.interventionId };
      } catch { throw new BadRequestException("Nieprawidłowy kursor zgłoszeń"); }
    }
    const ownerFilter = input.role === "operator" ? "AND (b.owner_user_id = :userId OR mi.assignee_user_id = :userId)" : "";
    const toolFilter = input.role === "admin" ? "" : "AND EXISTS (SELECT 1 FROM tool_grants tg " +
      "WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id AND tg.user_id = :userId " +
      "AND (tg.can_view_results OR tg.can_download_results OR (mi.kind = 'sms' AND (mi.assignee_user_id = :userId OR b.owner_user_id = :userId) AND tg.can_execute)))";
    const rows = await sequelize.query<InterventionRow>(
      `SELECT mi.intervention_id AS "interventionId", r.id AS "runId", r.batch_id AS "batchId",
              r.row_number AS "rowNumber", r.status AS "runStatus", mi.kind, mi.portal,
              r.error_code AS "errorCode", r.pzu_sms_retry_count AS "retryCount", b.owner_user_id AS "ownerUserId",
              mi.reason_code AS "reasonCode", mi.status, mi.revision,
              mi.assignee_user_id AS "assigneeUserId", assignee.username AS "assigneeUsername",
              mi.priority, mi.due_at AS "dueAt",
              (:isAdmin OR EXISTS (SELECT 1 FROM tool_grants view_grant WHERE view_grant.tenant_id = b.tenant_id
                AND view_grant.tool_id = b.tool_id AND view_grant.user_id = :userId
                AND (view_grant.can_view_results OR view_grant.can_download_results))) AS "canViewResults",
              (:isAdmin OR EXISTS (SELECT 1 FROM tool_grants execute_grant WHERE execute_grant.tenant_id = b.tenant_id
                AND execute_grant.tool_id = b.tool_id AND execute_grant.user_id = :userId AND execute_grant.can_execute)) AS "canExecute",
              mi.field_code AS "fieldCode", r.manual_data_version AS "manualDataVersion",
              r.last_safe_step AS "lastSafeStep", r.external_case_ref AS "externalCaseRef",
              mi.created_at AS "createdAt", mi.updated_at AS "updatedAt",
              ch.challenge_id AS "challengeId", ch.status AS "challengeStatus", ch.expires_at AS "expiresAt",
              ch.attempt_count AS "attemptCount", ch.attempt_limit AS "attemptLimit", ur.seen_revision AS "seenRevision"
              , ov.version AS "overrideVersion", ov.fields AS "overrideFields"
       FROM manual_interventions mi
       JOIN automation_runs r ON r.id = mi.run_id
       JOIN import_batches b ON b.id = r.batch_id
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
      { replacements: {
        tenantId: input.tenantId, userId: input.userId, status,
        isAdmin: input.role === "admin",
        portal: query.portal ?? null, kind: query.kind ?? null,
        cursorCreated: cursor?.createdAt ?? null, cursorId: cursor?.interventionId ?? null, fetchLimit: limit + 1,
      }, type: QueryTypes.SELECT },
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((row) => {
      const activeSms = row.kind === "sms" && row.status === "open" && row.runStatus === "waiting_for_sms"
        && row.challengeStatus === "active" && row.expiresAt !== null && new Date(row.expiresAt).getTime() > Date.now();
      const canReadSms = input.role === "admin" || (input.role === "operator" && row.canExecute);
      return {
        interventionId: row.interventionId, runId: row.runId, batchId: row.batchId, rowNumber: row.rowNumber,
        kind: row.kind, portal: row.portal, reasonCode: row.reasonCode, fieldCode: row.canViewResults ? row.fieldCode : null, status: row.status,
        assigneeUserId: row.assigneeUserId, assigneeUsername: row.assigneeUsername, priority: row.priority,
        dueAt: row.dueAt ? new Date(row.dueAt).toISOString() : null,
        isAssignedToMe: row.assigneeUserId === input.userId,
        runStatus: row.runStatus,
        revision: Number(row.revision), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
        challenge: activeSms && canReadSms ? {
          challengeId: row.challengeId, expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
          status: row.challengeStatus, attemptCount: row.attemptCount, attemptLimit: row.attemptLimit,
        } : null,
        isUnread: (row.seenRevision ?? 0) < Number(row.revision),
        canSubmitSms: activeSms && canReadSms,
        canResumeAuth: row.kind === "sms" && row.status === "open"
          && (input.role === "admin" || (input.role === "operator" && row.canExecute && row.ownerUserId === input.userId))
          && canRetrySms({ status: row.runStatus, errorCode: row.errorCode, reasonCode: row.reasonCode,
            portal: row.portal, retryCount: Number(row.retryCount) }),
        canResumeReview: row.canViewResults && canResumeManualIntervention({
          role: input.role, runStatus: row.runStatus, fieldCode: row.fieldCode, lastSafeStep: row.lastSafeStep,
          externalCaseRef: row.externalCaseRef, manualDataVersion: Number(row.manualDataVersion),
          overrideVersion: row.overrideVersion === null ? null : Number(row.overrideVersion), fields: row.overrideFields,
        }),
      };
    });
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), interventionId: last.interventionId })).toString("base64url")
      : null;
    return { items, nextCursor };
  }

  async summary(input: { tenantId: string; userId: string; role: string }) {
    const ownerFilter = input.role === "operator" ? "AND (b.owner_user_id = :userId OR mi.assignee_user_id = :userId)" : "";
    const toolFilter = input.role === "admin" ? "" : "AND EXISTS (SELECT 1 FROM tool_grants tg " +
      "WHERE tg.tenant_id = b.tenant_id AND tg.tool_id = b.tool_id AND tg.user_id = :userId " +
      "AND (tg.can_view_results OR tg.can_download_results OR (mi.kind = 'sms' AND (mi.assignee_user_id = :userId OR b.owner_user_id = :userId) AND tg.can_execute)))";
    const rows = await sequelize.query<{ openCount: string; unreadCount: string; smsCount: string }>(
      `SELECT COUNT(*) FILTER (WHERE mi.status = 'open')::int AS "openCount",
              COUNT(*) FILTER (WHERE mi.status = 'open' AND COALESCE(ur.seen_revision, 0) < mi.revision)::int AS "unreadCount",
              COUNT(*) FILTER (WHERE mi.status = 'open' AND mi.kind = 'sms'
                AND ch.status = 'active' AND ch.expires_at > now()
                AND (:isAdmin OR (:isOperator AND EXISTS (SELECT 1 FROM tool_grants sms_grant
                  WHERE sms_grant.tenant_id = b.tenant_id AND sms_grant.tool_id = b.tool_id
                    AND sms_grant.user_id = :userId AND sms_grant.can_execute))))::int AS "smsCount"
       FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
       JOIN import_batches b ON b.id = r.batch_id
       LEFT JOIN auth_challenges ch ON ch.challenge_id = r.current_auth_challenge_id AND ch.run_id = r.id
       LEFT JOIN intervention_user_reads ur ON ur.intervention_id = mi.intervention_id AND ur.user_id = :userId
       WHERE b.tenant_id = :tenantId ${ownerFilter} ${toolFilter}`,
      { replacements: { tenantId: input.tenantId, userId: input.userId, isAdmin: input.role === "admin", isOperator: input.role === "operator" }, type: QueryTypes.SELECT },
    );
    const row = rows[0] ?? { openCount: 0, unreadCount: 0, smsCount: 0 };
    return { openCount: Number(row.openCount), unreadCount: Number(row.unreadCount), smsCount: Number(row.smsCount) };
  }

  async markRead(interventionId: string, userId: string) {
    if (!uuidPattern.test(interventionId)) throw new BadRequestException("Nieprawidłowy identyfikator zgłoszenia");
    return sequelize.transaction(async (transaction) => {
      const intervention = await import("./db").then(({ ManualIntervention }) => ManualIntervention.findByPk(interventionId, {
        attributes: ["interventionId", "revision"], transaction, lock: transaction.LOCK.UPDATE,
      }));
      if (!intervention) throw new BadRequestException("Nie znaleziono zgłoszenia");
      const read = await InterventionUserRead.findOne({ where: { interventionId, userId }, transaction, lock: transaction.LOCK.UPDATE });
      if (read) {
        read.seenRevision = intervention.revision;
        read.updatedAt = new Date();
        await read.save({ transaction });
      } else {
        await InterventionUserRead.create({ interventionId, userId, seenRevision: intervention.revision, updatedAt: new Date() }, { transaction });
      }
      return { interventionId, seenRevision: intervention.revision, isUnread: false };
    });
  }
}

@Controller("interventions")
@UseGuards(SessionGuard, PermissionGuard)
export class InterventionController {
  constructor(private readonly interventions: InterventionService) {}

  @Get()
  @RequirePermission("intervention:read", "session-list")
  list(@Req() req: Request, @Query() query: Record<string, string | undefined>) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new BadRequestException("Brak sesji");
    return this.interventions.list(principal, query);
  }

  @Get("summary")
  @RequirePermission("intervention:read", "session-list")
  summary(@Req() req: Request) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new BadRequestException("Brak sesji");
    return this.interventions.summary(principal);
  }

  @Post(":id/read")
  @HttpCode(200)
  @RequirePermission("intervention:mark_read", "route-intervention")
  markRead(@Param("id") id: string, @Req() req: Request, @Body() body: unknown) {
    if (!verifyCsrfRequest(req)) throw new BadRequestException("Wymagany jest poprawny token CSRF");
    if (body && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)) {
      throw new BadRequestException("Nieprawidłowe dane odczytu zgłoszenia");
    }
    const principal = readSessionPrincipal(req);
    if (!principal) throw new BadRequestException("Brak sesji");
    return this.interventions.markRead(id, principal.userId);
  }
}
