import { Inject, Injectable } from "@nestjs/common";
import { QueryTypes, type Sequelize } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import type { ListCursor } from "../../shared/list-query";
import { operationalCollectionScope } from "../authorization/public";

type Actor = Readonly<{ tenantId: string; userId: string; role: string }>;
type Filters = Readonly<{
  toolId?: string;
  batchId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit: number;
}>;
type CommonQuery = Readonly<{
  actor: Actor;
  filters: Filters;
  cursor: ListCursor | null;
}>;
type HistoryRow = Readonly<{ id: string; created_at: Date | string }>;

export type ImportHistoryRow = HistoryRow &
  Readonly<{
    tool_id: string;
    file_name: string;
    total_rows: number;
    review_count: number;
    owner_label: string | null;
  }>;

export type RunHistoryRow = HistoryRow &
  Readonly<{
    batch_id: string;
    source_file_name: string;
    row_number: number;
    tool_id: string;
    status: string;
    reference_date: string;
    error_code: string | null;
    total_oc_count: number | null;
    current_oc_count: number | null;
    artifact_available: boolean;
    artifact_id: string | null;
  }>;

function appendCommonFilters(conditions: string[], filters: Filters, alias: "b" | "r") {
  if (filters.toolId) conditions.push(`${alias}.tool_id = :toolId`);
  if (filters.batchId) conditions.push(`${alias === "r" ? "r.batch_id" : "b.id"} = :batchId`);
  if (filters.status) conditions.push(`${alias}.status = :status`);
  if (filters.from) conditions.push(`${alias}.created_at >= :from`);
  if (filters.to) conditions.push(`${alias}.created_at <= :to`);
}

function replacements(query: CommonQuery) {
  const { actor, filters, cursor } = query;
  return {
    tenantId: actor.tenantId,
    userId: actor.userId,
    limit: filters.limit + 1,
    ...(filters.toolId ? { toolId: filters.toolId } : {}),
    ...(filters.batchId ? { batchId: filters.batchId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(cursor ? { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id } : {}),
  };
}

@Injectable()
export class HistoryRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  imports(query: CommonQuery & Readonly<{ dataState: "all" | "ready" | "needs_review" }>): Promise<ImportHistoryRow[]> {
    const { filters, cursor, actor } = query;
    const conditions = [
      operationalCollectionScope(actor.role),
      "NOT EXISTS (SELECT 1 FROM resource_tombstones rt WHERE rt.resource_type = 'import' AND rt.tenant_id = b.tenant_id AND rt.resource_id = b.id)",
    ];
    appendCommonFilters(conditions, filters, "b");
    if (cursor) conditions.push("(b.created_at, b.id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    const dataStateCondition =
      query.dataState === "ready"
        ? "review_count = 0"
        : query.dataState === "needs_review"
          ? "review_count > 0"
          : "TRUE";
    return this.database.query<ImportHistoryRow>(
      `WITH scoped_batches AS (
          SELECT b.id, b.tool_id, b.file_name, b.total_rows, b.created_at, u.username AS owner_label,
            (SELECT count(*)::int FROM source_rows sr WHERE sr.batch_id = b.id AND (
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
        LIMIT :limit`,
      { replacements: replacements(query), type: QueryTypes.SELECT },
    );
  }

  runs(query: CommonQuery & Readonly<{ resultsOnly: boolean }>): Promise<RunHistoryRow[]> {
    const { filters, cursor, actor, resultsOnly } = query;
    const conditions = [
      operationalCollectionScope(actor.role),
      "r.tool_id = b.tool_id",
      "NOT EXISTS (SELECT 1 FROM resource_tombstones rt WHERE rt.resource_type = 'import' AND rt.tenant_id = b.tenant_id AND rt.resource_id = b.id)",
      "NOT EXISTS (SELECT 1 FROM resource_tombstones rt WHERE rt.resource_type = 'run' AND rt.tenant_id = b.tenant_id AND rt.resource_id = r.id)",
    ];
    appendCommonFilters(conditions, filters, "r");
    if (resultsOnly && !filters.status) conditions.push("r.status IN ('completed', 'no_matching_policies')");
    if (cursor) conditions.push("(r.created_at, r.id) < (:cursorCreatedAt, CAST(:cursorId AS uuid))");
    const projection = resultsOnly
      ? `s.total_count AS total_oc_count, policy_counts.current_count AS current_oc_count,
         (r.status = 'completed' AND available_artifact.artifact_id IS NOT NULL) AS artifact_available,
         available_artifact.artifact_id`
      : `NULL::integer AS total_oc_count, NULL::bigint AS current_oc_count, FALSE AS artifact_available, NULL::uuid AS artifact_id`;
    const countsJoin = resultsOnly
      ? `LEFT JOIN oc_snapshots s ON s.run_id = r.id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS current_count FROM oc_policies op
           WHERE op.run_id = r.id AND op.coverage_to >= r.reference_date
         ) policy_counts ON TRUE
         LEFT JOIN LATERAL (
           SELECT ea.artifact_id FROM export_artifacts ea
            WHERE ea.run_id = r.id AND ea.state = 'ready' AND ea.policy_count > 0
              AND NOT EXISTS (SELECT 1 FROM resource_tombstones rt WHERE rt.resource_type = 'artifact' AND rt.tenant_id = b.tenant_id AND rt.resource_id = ea.artifact_id)
            ORDER BY ea.ready_at DESC, ea.created_at DESC, ea.artifact_id DESC LIMIT 1
         ) available_artifact ON TRUE`
      : "";
    return this.database.query<RunHistoryRow>(
      `SELECT r.id, r.batch_id, b.file_name AS source_file_name, r.row_number, r.tool_id, r.status, r.reference_date, r.error_code,
          r.created_at, ${projection}
       FROM automation_runs r
       JOIN import_batches b ON b.id = r.batch_id
       JOIN tools t ON t.tool_id = b.tool_id
       ${countsJoin}
       WHERE ${conditions.join(" AND ")}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT :limit`,
      { replacements: replacements(query), type: QueryTypes.SELECT },
    );
  }
}
