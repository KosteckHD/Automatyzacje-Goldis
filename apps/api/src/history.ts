import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { QueryTypes } from "sequelize";
import { sanitizePublicFileName, sanitizePublicText } from "./public-output";
import { sequelize } from "./db";
import { operationalCollectionScope } from "./resource-scope";
import {
  createListCursor, filterFingerprint, parseIsoDateTime, parseListCursor, parseListLimit,
  parseToolId, parseUuidFilter, validateDateRange,
} from "./list-query";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { readSessionPrincipal, SessionGuard, type SessionPrincipal } from "./session";

const runStatuses = new Set([
  "queued", "validating", "awaiting_portal_adapter", "pzu_login", "waiting_for_sms", "everest_search",
  "identity_review", "compensa_login", "compensa_form", "waiting_for_manual_data", "ufg_verification",
  "reading_oc", "no_matching_policies", "export_ready", "completed", "cancelled", "failed",
]);
const resultStatuses = new Set(["completed", "no_matching_policies"]);
const dataStates = new Set(["all", "ready", "needs_review"]);

type HistoryQuery = Readonly<{
  toolId?: string;
  batchId?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}>;

type ImportHistoryQuery = HistoryQuery & Readonly<{ dataState?: string }>;
type Principal = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;
type HistoryRow = { id: string; created_at: Date | string };

function principal(request: Request): Principal {
  const actor = readSessionPrincipal(request);
  if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
  return actor;
}

function listFilters(input: HistoryQuery, listName: string, resultList = false, additionalFilters: Readonly<Record<string, string>> = {}) {
  const toolId = parseToolId(input.toolId);
  const batchId = parseUuidFilter(input.batchId, "batchId");
  const from = parseIsoDateTime(input.from, "from");
  const to = parseIsoDateTime(input.to, "to");
  validateDateRange(from, to);
  const limit = parseListLimit(input.limit);
  let status: string | undefined;
  if (input.status !== undefined && input.status !== "") {
    const allowed = resultList ? resultStatuses : runStatuses;
    if (!allowed.has(input.status)) throw new BadRequestException("Nieprawidłowy status historii");
    status = input.status;
  }
  const filters = { toolId, batchId, status, from, to, ...additionalFilters, limit };
  const fingerprint = filterFingerprint(listName, filters);
  const cursor = parseListCursor(input.cursor, fingerprint);
  const replacements: Record<string, string | number> = { limit: limit + 1 };
  if (toolId) replacements.toolId = toolId;
  if (batchId) replacements.batchId = batchId;
  if (status) replacements.status = status;
  if (from) replacements.from = from;
  if (to) replacements.to = to;
  if (cursor) {
    replacements.cursorCreatedAt = cursor.createdAt;
    replacements.cursorId = cursor.id;
  }
  return { filters, fingerprint, cursor, replacements };
}

function appendCommonFilters(conditions: string[], filters: ReturnType<typeof listFilters>["filters"], alias: "b" | "r") {
  if (filters.toolId) conditions.push(`${alias}.tool_id = :toolId`);
  if (filters.batchId) conditions.push(`${alias === "r" ? "r.batch_id" : "b.id"} = :batchId`);
  if (filters.status) conditions.push(`${alias}.status = :status`);
  if (filters.from) conditions.push(`${alias}.created_at >= :from`);
  if (filters.to) conditions.push(`${alias}.created_at <= :to`);
}

@Injectable()
export class HistoryService {
  async imports(actor: Principal, input: ImportHistoryQuery) {
    const dataState = input.dataState ?? "all";
    if (!dataStates.has(dataState)) throw new BadRequestException("Nieprawidłowy stan importu");
    if (input.status) throw new BadRequestException("Status dotyczy historii zadań, nie importów; użyj dataState");
    const parsed = listFilters(input, "imports", false, { dataState });
    const { filters, fingerprint, cursor, replacements } = parsed;
    replacements.tenantId = actor.tenantId;
    replacements.userId = actor.userId;
    const conditions = [operationalCollectionScope(actor.role)];
    appendCommonFilters(conditions, filters, "b");
    if (cursor) conditions.push("(b.created_at, b.id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    const dataStateCondition = dataState === "ready" ? "review_count = 0"
      : dataState === "needs_review" ? "review_count > 0" : "TRUE";
    const sql = `WITH scoped_batches AS (
        SELECT b.id, b.tool_id, b.file_name, b.total_rows, b.created_at, u.username AS owner_label,
          (SELECT count(*)::int
           FROM source_rows sr
           WHERE sr.batch_id = b.id AND (
             jsonb_array_length(sr.issues) > 0
             OR sr.effective_regon IS NULL OR length(trim(sr.effective_regon)) = 0
             OR EXISTS (SELECT 1 FROM regon_corrections rc WHERE rc.source_row_id = sr.id AND rc.status = 'pending')
             OR EXISTS (SELECT 1 FROM entity_grouping_conflicts ec WHERE ec.source_row_id = sr.id AND ec.status = 'open')
           )) AS review_count
        FROM import_batches b
        JOIN tools t ON t.tool_id = b.tool_id
        LEFT JOIN users u ON u.user_id = b.owner_user_id
        WHERE ${conditions.join(" AND ")}
      )
      SELECT id, tool_id, file_name, total_rows, review_count, created_at, owner_label
      FROM scoped_batches
      WHERE ${dataStateCondition}
      ORDER BY created_at DESC, id DESC
      LIMIT :limit`;
    let rows: Array<HistoryRow & {
      tool_id: string; file_name: string; total_rows: number; review_count: number; owner_label: string | null;
    }>;
    try {
      rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT }) as typeof rows;
    } catch {
      throw new ServiceUnavailableException("Historia importów jest chwilowo niedostępna");
    }
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        toolId: row.tool_id,
        fileName: sanitizePublicFileName(row.file_name),
        totalRows: Number(row.total_rows),
        reviewCount: Number(row.review_count),
        createdAt: new Date(row.created_at).toISOString(),
        ownerLabel: row.owner_label ? sanitizePublicText(row.owner_label) : null,
      })),
      nextCursor: hasMore && last ? createListCursor(last.created_at, last.id, fingerprint) : null,
    };
  }

  async runs(actor: Principal, input: HistoryQuery) {
    return this.runList(actor, input, false);
  }

  async results(actor: Principal, input: HistoryQuery) {
    return this.runList(actor, input, true);
  }

  private async runList(actor: Principal, input: HistoryQuery, resultsOnly: boolean) {
    const listName = resultsOnly ? "results" : "runs";
    const parsed = listFilters(input, listName, resultsOnly);
    const { filters, fingerprint, cursor, replacements } = parsed;
    replacements.tenantId = actor.tenantId;
    replacements.userId = actor.userId;
    const conditions = [operationalCollectionScope(actor.role), "r.tool_id = b.tool_id"];
    appendCommonFilters(conditions, filters, "r");
    if (resultsOnly && !filters.status) conditions.push("r.status IN ('completed', 'no_matching_policies')");
    if (cursor) conditions.push("(r.created_at, r.id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    const projection = resultsOnly
      ? `s.total_count AS total_oc_count, policy_counts.current_count AS current_oc_count,
         (r.status = 'completed' AND EXISTS (
           SELECT 1 FROM export_artifacts ea WHERE ea.run_id = r.id AND ea.state = 'ready' AND ea.policy_count > 0
         )) AS artifact_available`
      : `NULL::integer AS total_oc_count, NULL::bigint AS current_oc_count, FALSE AS artifact_available`;
    const countsJoin = resultsOnly ? `
      LEFT JOIN oc_snapshots s ON s.run_id = r.id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS current_count FROM oc_policies op
        WHERE op.run_id = r.id AND op.coverage_to >= r.reference_date
      ) policy_counts ON TRUE` : "";
    const sql = `SELECT r.id, r.batch_id, r.row_number, r.tool_id, r.status, r.reference_date, r.error_code,
        r.created_at, ${projection}
      FROM automation_runs r
      JOIN import_batches b ON b.id = r.batch_id
      JOIN tools t ON t.tool_id = b.tool_id
      ${countsJoin}
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT :limit`;
    let rows: Array<HistoryRow & {
      batch_id: string; row_number: number; tool_id: string; status: string; reference_date: string;
      error_code: string | null; total_oc_count: number | null; current_oc_count: number | null; artifact_available: boolean;
    }>;
    try {
      rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT }) as typeof rows;
    } catch {
      throw new ServiceUnavailableException("Historia zadań jest chwilowo niedostępna");
    }
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        rowNumber: Number(row.row_number),
        toolId: row.tool_id,
        status: row.status,
        referenceDate: row.reference_date,
        errorCode: row.error_code,
        createdAt: new Date(row.created_at).toISOString(),
        ...(resultsOnly ? {
          policyCounts: row.total_oc_count === null ? null : {
            totalOcCount: Number(row.total_oc_count), currentOcCount: Number(row.current_oc_count ?? 0),
          },
          artifactAvailable: Boolean(row.artifact_available),
        } : {}),
      })),
      nextCursor: hasMore && last ? createListCursor(last.created_at, last.id, fingerprint) : null,
    };
  }
}

@Controller("history")
@UseGuards(SessionGuard, PermissionGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get("runs")
  @RequirePermission("run:read", "collection")
  runs(@Req() request: Request, @Query() query: HistoryQuery) {
    return this.history.runs(principal(request), query);
  }

  @Get("results")
  @RequirePermission("batch:read", "collection")
  results(@Req() request: Request, @Query() query: HistoryQuery) {
    return this.history.results(principal(request), query);
  }
}

