import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { sanitizePublicFileName, sanitizePublicText } from "../../infrastructure/http";
import {
  createListCursor,
  filterFingerprint,
  parseIsoDateTime,
  parseListCursor,
  parseListLimit,
  parseToolId,
  parseUuidFilter,
  validateDateRange,
} from "../../shared/list-query";
import type { SessionPrincipal } from "../auth/public";
import { HistoryRepository, type ImportHistoryRow, type RunHistoryRow } from "./history.repository";

const runStatuses = new Set([
  "queued",
  "validating",
  "awaiting_portal_adapter",
  "pzu_login",
  "waiting_for_sms",
  "everest_search",
  "identity_review",
  "compensa_login",
  "compensa_form",
  "waiting_for_manual_data",
  "ufg_verification",
  "reading_oc",
  "no_matching_policies",
  "export_ready",
  "completed",
  "cancelled",
  "failed",
]);
const resultStatuses = new Set(["completed", "no_matching_policies"]);
const dataStates = new Set(["all", "ready", "needs_review"]);

export type HistoryQuery = Readonly<{
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
function listFilters(
  input: HistoryQuery,
  listName: string,
  resultList = false,
  additionalFilters: Readonly<Record<string, string>> = {},
) {
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
  return { filters, fingerprint, cursor };
}

@Injectable()
export class HistoryService {
  constructor(@Inject(HistoryRepository) private readonly repository: HistoryRepository) {}

  async imports(actor: Principal, input: ImportHistoryQuery) {
    const dataState = input.dataState ?? "all";
    if (!dataStates.has(dataState)) throw new BadRequestException("Nieprawidłowy stan importu");
    if (input.status) throw new BadRequestException("Status dotyczy historii zadań, nie importów; użyj dataState");
    const parsed = listFilters(input, "imports", false, { dataState });
    const { filters, fingerprint, cursor } = parsed;
    let rows: ImportHistoryRow[];
    try {
      rows = await this.repository.imports({
        actor,
        filters,
        cursor,
        dataState: dataState as "all" | "ready" | "needs_review",
      });
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
    const { filters, fingerprint, cursor } = parsed;
    let rows: RunHistoryRow[];
    try {
      rows = await this.repository.runs({ actor, filters, cursor, resultsOnly });
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
        sourceFileName: sanitizePublicFileName(row.source_file_name),
        rowNumber: Number(row.row_number),
        toolId: row.tool_id,
        status: row.status,
        referenceDate: row.reference_date,
        errorCode: row.error_code,
        createdAt: new Date(row.created_at).toISOString(),
        ...(resultsOnly
          ? {
              policyCounts:
                row.total_oc_count === null
                  ? null
                  : {
                      totalOcCount: Number(row.total_oc_count),
                      currentOcCount: Number(row.current_oc_count ?? 0),
                    },
              artifactAvailable: Boolean(row.artifact_available),
              artifactId: row.artifact_id ?? null,
            }
          : {}),
      })),
      nextCursor: hasMore && last ? createListCursor(last.created_at, last.id, fingerprint) : null,
    };
  }
}
