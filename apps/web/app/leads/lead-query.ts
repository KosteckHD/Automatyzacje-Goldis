export type LeadScope = "mine" | "pool";
export type ContactStatus = "not_contacted" | "offer_accepted" | "not_interested";
export type LeadViewQuery = Readonly<{
  scope: LeadScope;
  search: string;
  contactStatus: ContactStatus | "";
  resultSetId: string | null;
  cursor: string | null;
  direction: "next" | "previous";
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTACT_STATUSES = new Set<ContactStatus>(["not_contacted", "offer_accepted", "not_interested"]);
const RETURN_QUERY_KEYS = new Set(["scope", "search", "contactStatus", "resultSetId", "cursor", "direction"]);

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  if (values.length > 1) throw new Error(`Parametr ${key} występuje więcej niż raz.`);
  return values[0] ?? null;
}

export function parseLeadViewQuery(search: string, defaultScope: LeadScope): LeadViewQuery {
  const params = new URLSearchParams(search);
  const scopeValue = single(params, "scope");
  const scope = scopeValue ?? defaultScope;
  if (scope !== "mine" && scope !== "pool") throw new Error("Nieprawidłowy zakres listy firm.");
  if (scope !== defaultScope) throw new Error("Zakres adresu nie pasuje do otwartej listy.");

  const searchValue = (single(params, "search") ?? "").trim();
  if (searchValue.length > 120) throw new Error("Fraza wyszukiwania może mieć maksymalnie 120 znaków.");
  const statusValue = single(params, "contactStatus") ?? "";
  if (statusValue && !CONTACT_STATUSES.has(statusValue as ContactStatus)) throw new Error("Nieprawidłowy status kontaktu w adresie.");
  const resultSetId = single(params, "resultSetId");
  if (resultSetId && !UUID.test(resultSetId)) throw new Error("Nieprawidłowy identyfikator wyników w adresie.");
  const cursor = single(params, "cursor");
  const directionValue = single(params, "direction") ?? "next";
  if (directionValue !== "next" && directionValue !== "previous") throw new Error("Nieprawidłowy kierunek stronicowania.");
  if (directionValue === "previous" && !cursor) throw new Error("Adres poprzedniej strony nie zawiera kursora.");

  return { scope, search: searchValue, contactStatus: statusValue as ContactStatus | "", resultSetId, cursor, direction: directionValue };
}

export function serializeLeadViewQuery(query: LeadViewQuery, includePagination = true): string {
  const params = new URLSearchParams();
  params.set("scope", query.scope);
  if (query.search) params.set("search", query.search);
  if (query.contactStatus) params.set("contactStatus", query.contactStatus);
  if (query.resultSetId) params.set("resultSetId", query.resultSetId);
  if (includePagination && query.cursor) {
    params.set("cursor", query.cursor);
    if (query.direction !== "next") params.set("direction", query.direction);
  }
  return params.toString();
}

export function buildLeadListHref(pathname: string, query: LeadViewQuery): string {
  const serialized = serializeLeadViewQuery(query);
  return `${pathname}${serialized ? `?${serialized}` : ""}`;
}

export function buildLeadExportHref(query: LeadViewQuery): string {
  return `/api/leads/export?${serializeLeadViewQuery(query, false)}`;
}

export function sanitizeLeadReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 4096 || value.includes("\\") || value.startsWith("//")) return null;
  let url: URL;
  try { url = new URL(value, "https://goldis.invalid"); } catch { return null; }
  if (url.origin !== "https://goldis.invalid" || !["/my-results", "/results/oc-policy-verification"].includes(url.pathname)) return null;
  const safe = new URLSearchParams();
  for (const key of new Set(url.searchParams.keys())) {
    if (!RETURN_QUERY_KEYS.has(key) || url.searchParams.getAll(key).length !== 1) return null;
    const entry = url.searchParams.get(key);
    if (entry !== null) safe.set(key, entry);
  }
  try {
    const parsed = parseLeadViewQuery(safe.toString(), url.pathname === "/my-results" ? "mine" : "pool");
    return buildLeadListHref(url.pathname, parsed);
  } catch { return null; }
}

export function leadApiQuery(query: LeadViewQuery): string {
  const params = new URLSearchParams(serializeLeadViewQuery(query));
  params.set("limit", "25");
  params.set("includeSummary", "1");
  return params.toString();
}
