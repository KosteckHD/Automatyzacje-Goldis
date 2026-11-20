import { BadRequestException } from "@nestjs/common";

export const CONTACT_STATUSES = ["not_contacted", "offer_accepted", "not_interested"] as const;
export type ContactStatusFilter = (typeof CONTACT_STATUSES)[number];
export type LeadScopeName = "mine" | "pool";
export type LeadCursor = Readonly<{ createdAt: string; leadId: string }>;

export type LeadScopeInput = Readonly<{
  scope?: unknown;
  contactStatus?: unknown;
  resultSetId?: unknown;
  search?: unknown;
  query?: unknown;
  limit?: unknown;
  cursor?: unknown;
  direction?: unknown;
  includeSummary?: unknown;
}>;

export type NormalizedLeadQuery = Readonly<{
  scope: LeadScopeName;
  contactStatus: ContactStatusFilter | null;
  resultSetId: string | null;
  search: string;
  limit: number;
  cursor: LeadCursor | null;
  direction: "next" | "previous";
  includeSummary: boolean;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalScalar(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BadRequestException(`Nieprawidłowy parametr ${name}`);
  return value;
}

function parseCursor(value: string | undefined): LeadCursor | null {
  if (value === undefined || value === "") return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof decoded.createdAt !== "string" ||
      !Number.isFinite(Date.parse(decoded.createdAt)) ||
      typeof decoded.leadId !== "string" ||
      !UUID_PATTERN.test(decoded.leadId)
    )
      throw new Error();
    return { createdAt: new Date(decoded.createdAt).toISOString(), leadId: decoded.leadId };
  } catch {
    throw new BadRequestException("Nieprawidłowy kursor listy wyników");
  }
}

export function encodeLeadCursor(createdAt: Date | string, leadId: string): string {
  return Buffer.from(JSON.stringify({ createdAt: new Date(createdAt).toISOString(), leadId }), "utf8").toString(
    "base64url",
  );
}

export function normalizeLeadQuery(input: LeadScopeInput): NormalizedLeadQuery {
  const rawScope = optionalScalar(input.scope, "scope") ?? "pool";
  if (rawScope !== "mine" && rawScope !== "pool") throw new BadRequestException("Nieprawidłowy zakres listy leadów");

  const rawStatus = optionalScalar(input.contactStatus, "contactStatus") ?? "";
  if (rawStatus && !CONTACT_STATUSES.includes(rawStatus as ContactStatusFilter)) {
    throw new BadRequestException("Wybierz jeden z dostępnych statusów kontaktu");
  }

  const rawResultSetId = optionalScalar(input.resultSetId, "resultSetId") ?? "";
  if (rawResultSetId && !UUID_PATTERN.test(rawResultSetId)) {
    throw new BadRequestException("Nieprawidłowy identyfikator wyników");
  }

  const rawSearch = optionalScalar(input.search ?? input.query, "search") ?? "";
  const search = rawSearch.trim();
  if (search.length > 120) throw new BadRequestException("Fraza wyszukiwania może mieć maksymalnie 120 znaków");

  const rawLimit = optionalScalar(input.limit, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new BadRequestException("Limit wyników musi wynosić od 1 do 50");
  }

  const cursor = parseCursor(optionalScalar(input.cursor, "cursor"));
  const rawDirection = optionalScalar(input.direction, "direction") ?? "next";
  if (rawDirection !== "next" && rawDirection !== "previous") {
    throw new BadRequestException("Nieprawidłowy kierunek stronicowania");
  }
  if (rawDirection === "previous" && !cursor) {
    throw new BadRequestException("Poprzednia strona wymaga kursora");
  }

  const rawSummary = optionalScalar(input.includeSummary, "includeSummary");
  if (rawSummary !== undefined && rawSummary !== "1" && rawSummary !== "0") {
    throw new BadRequestException("Nieprawidłowa wartość includeSummary");
  }

  return {
    scope: rawScope,
    contactStatus: rawStatus ? (rawStatus as ContactStatusFilter) : null,
    resultSetId: rawResultSetId || null,
    search,
    limit,
    cursor,
    direction: rawDirection,
    includeSummary: rawSummary === "1",
  };
}

/** Shared ACL and scope predicate used by list, summary, export and queue navigation. */
export function leadScopePredicate(filters: "scope" | "all" = "all"): string {
  const scoped = `lead.tenant_id = :tenantId AND lead.tool_id = :toolId
    AND lead.result_status = 'ready'
    AND (result_set.batch_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM resource_tombstones deletion
      WHERE deletion.tenant_id = result_set.tenant_id AND deletion.resource_type = 'import'
        AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed'
    ) OR (:scopeMine = TRUE AND lead.assigned_to_user_id = :userId AND EXISTS (
      SELECT 1 FROM lead_result_snapshots saved
      WHERE saved.lead_id = lead.lead_id AND saved.tenant_id = lead.tenant_id
        AND saved.source_owner_user_id <> lead.assigned_to_user_id
    )))
    AND (:scopeMine = FALSE OR lead.assigned_to_user_id = :userId)
    AND (:scopeMine = TRUE OR result_set.batch_id IS NOT NULL)
    AND (:resultSetId IS NULL OR lead.result_set_id = CAST(:resultSetId AS uuid))`;

  if (filters === "scope") return scoped;
  return `${scoped}
    AND (:contactStatus IS NULL OR lead.contact_status = :contactStatus)
    AND (:search IS NULL OR lead.company_name ILIKE :search ESCAPE '\\'
      OR COALESCE(lead.nip, '') LIKE :search ESCAPE '\\'
      OR COALESCE(lead.regon, '') LIKE :search ESCAPE '\\')`;
}

export function leadScopeReplacements(
  actor: Readonly<{ tenantId: string; userId: string }>,
  query: Pick<NormalizedLeadQuery, "scope" | "contactStatus" | "resultSetId" | "search">,
): Record<string, unknown> {
  return {
    tenantId: actor.tenantId,
    toolId: "oc-policy-verification",
    userId: actor.userId,
    scopeMine: query.scope === "mine",
    contactStatus: query.contactStatus,
    resultSetId: query.resultSetId,
    search: query.search ? `%${query.search.replace(/[\\%_]/g, "\\$&")}%` : null,
  };
}
