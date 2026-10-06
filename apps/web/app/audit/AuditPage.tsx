"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { GoldisLogo } from "../../components/brand/GoldisLogo";

type Role = "admin" | "operator" | "reviewer" | "auditor";
type Session = { role?: Role };
type AuditEvent = {
  eventId: string; actorUserId: string | null; actorUsername: string | null; action: string;
  resourceType: string; resourceId: string | null; outcome: string; createdAt: string;
};
type AuditPageResult = { items: AuditEvent[]; nextCursor: string | null };
type Filters = { fromDay: string; toDay: string; actorId: string; action: string; resourceType: string; resourceId: string; outcome: string; toolId: string };

const reviewerActions = [
  "import.created", "run.created", "run.cancelled", "run.auth_resumed", "run.review_resumed",
  "run.manual_data_corrected", "sms.submitted", "regon.correction.proposed", "regon.correction.reviewed",
  "entity.conflict.reviewed", "enrichment.job.created", "enrichment.job.cancelled", "enrichment.job.completed", "artifact.downloaded",
  "intervention.assigned", "intervention.unassigned", "intervention.priority_changed", "intervention.resolved",
];
const allActions = [
  "login.succeeded", "login.failed", "logout.succeeded", "session.revoked", "password.changed",
  ...reviewerActions, "user.created", "user.updated", "tool.grant.created", "tool.grant.updated",
  "tool.grant.revoked", "settings.updated",
];
const reviewerResources = ["import", "run", "artifact", "intervention", "correction", "entity_conflict", "enrichment_job"];
const allResources = ["import", "run", "artifact", "intervention", "correction", "entity_conflict", "enrichment_job", "user", "session", "tool", "settings", "challenge"];

function warsawDay(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDay(day: string, amount: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + amount));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function dayBoundary(day: string, exclusiveEnd: boolean): string | undefined {
  if (!day) return undefined;
  const targetDay = exclusiveEnd ? shiftDay(day, 1) : day;
  const [year, month, date] = targetDay.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    const adjustment = target - represented;
    guess += adjustment;
    if (!adjustment) break;
  }
  return new Date(guess).toISOString();
}

function defaultFilters(): Filters {
  const today = warsawDay();
  return { fromDay: shiftDay(today, -6), toDay: today, actorId: "", action: "", resourceType: "", resourceId: "", outcome: "", toolId: "" };
}

function readFiltersFromUrl(): Filters & { cursor: string | null } {
  const defaults = defaultFilters();
  const params = new URLSearchParams(window.location.search);
  return {
    fromDay: params.get("fromDay") ?? defaults.fromDay, toDay: params.get("toDay") ?? defaults.toDay,
    actorId: params.get("actorId") ?? "", action: params.get("action") ?? "", resourceType: params.get("resourceType") ?? "",
    resourceId: params.get("resourceId") ?? "", outcome: params.get("outcome") ?? "", toolId: params.get("toolId") ?? "",
    cursor: params.get("cursor"),
  };
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function AuditPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [draftFilters, setDraftFilters] = useState<Filters>(defaultFilters);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursorStackRef = useRef<Array<string | null>>([null]);
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams();
    const current = readFiltersFromUrl();
    const { cursor: initialCursor, ...initialFilters } = current;
    setFilters(initialFilters); setDraftFilters(initialFilters); setCursor(initialCursor);
    const initialStack = initialCursor ? [null, initialCursor] : [null];
    cursorStackRef.current = initialStack; setCursorStack(initialStack); setPageIndex(initialCursor ? 1 : 0);
    Object.entries(current).forEach(([key, value]) => { if (value) params.set(key, value); });
    window.history.replaceState({ goldisAudit: true, cursorStack: initialStack, pageIndex: initialCursor ? 1 : 0 }, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    const abort = new AbortController();
    fetch("/api/auth/me", { credentials: "same-origin", signal: abort.signal }).then(async (response) => {
      if (response.status === 401) { setSessionState("signed-out"); return; }
      if (!response.ok) throw new Error("Nie można odczytać uprawnień konta.");
      setSession(await response.json() as Session);
      setSessionState("ready");
    }).catch(() => { if (!abort.signal.aborted) setSessionState("error"); });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const current = readFiltersFromUrl();
      const { cursor: restoredCursor, ...restoredFilters } = current;
      setFilters(restoredFilters); setDraftFilters(restoredFilters); setCursor(restoredCursor);
      const state = window.history.state as { cursorStack?: unknown; pageIndex?: unknown } | null;
      if (Array.isArray(state?.cursorStack) && state.cursorStack.every((item) => item === null || typeof item === "string")
        && Number.isInteger(state?.pageIndex) && (state?.pageIndex as number) >= 0) {
        const restored = state.cursorStack as Array<string | null>;
        cursorStackRef.current = restored; setCursorStack(restored); setPageIndex(state.pageIndex as number);
      } else {
        const found = cursorStackRef.current.indexOf(restoredCursor);
        if (found >= 0) setPageIndex(found);
        else { setPageIndex(0); setCursorStack([null]); cursorStackRef.current = [null]; }
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const permittedRole = session?.role === "admin" || session?.role === "reviewer" || session?.role === "auditor";

  useEffect(() => {
    if (sessionState !== "ready" || !permittedRole) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    const from = dayBoundary(filters.fromDay, false);
    const to = dayBoundary(filters.toDay, true);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    for (const [key, value] of Object.entries(filters)) {
      if (["fromDay", "toDay"].includes(key) || !value.trim()) continue;
      params.set(key, value.trim());
    }
    if (cursor) params.set("cursor", cursor);
    params.set("limit", "50");
    setLoading(true); setError("");
    fetch(`/api/audit/events?${params}`, { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { setSessionState("signed-out"); return; }
      const payload = await response.json().catch(() => ({})) as AuditPageResult & { message?: string };
      if (response.status === 403) throw new Error("Twoje konto nie ma dostępu do dziennika audytu.");
      if (!response.ok) throw new Error(payload.message ?? `Dziennik audytu jest niedostępny (${response.status}).`);
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setNextCursor(payload.nextCursor ?? null);
    }).catch((cause) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać zdarzeń audytu."); setItems([]); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionState, permittedRole, filters, cursor]);

  function writeUrl(nextFilters: Filters, nextCursor: string | null, stack: Array<string | null>, index: number, replace = false) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(nextFilters)) if (value.trim()) params.set(key, value.trim());
    if (nextCursor) params.set("cursor", nextCursor);
    const url = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history[replace ? "replaceState" : "pushState"]({ goldisAudit: true, cursorStack: stack, pageIndex: index }, "", url);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters(draftFilters);
    setCursor(null); setCursorStack([null]); cursorStackRef.current = [null]; setPageIndex(0);
    writeUrl(draftFilters, null, [null], 0);
  }

  function nextPage() {
    if (!nextCursor) return;
    const next = [...cursorStack.slice(0, pageIndex + 1), nextCursor];
    cursorStackRef.current = next; setCursorStack(next); setPageIndex(pageIndex + 1); setCursor(nextCursor);
    writeUrl(filters, nextCursor, next, pageIndex + 1);
  }

  function previousPage() {
    if (pageIndex < 1) return;
    const previous = cursorStack[pageIndex - 1] ?? null;
    setPageIndex(pageIndex - 1); setCursor(previous);
    writeUrl(filters, previous, cursorStack, pageIndex - 1);
  }

  const returnTo = typeof window === "undefined" ? "/audit" : `${window.location.pathname}${window.location.search}`;
  const reviewer = session?.role === "reviewer";

  return <main className="history-page">
    <header className="history-topbar"><a className="history-brand" href="/" aria-label="Goldis — katalog"><GoldisLogo variant="header" /><span>Goldis · Platforma automatyzacji</span></a><nav aria-label="Platforma"><a href="/">Katalog</a>{(session?.role === "admin" || session?.role === "reviewer") && <><a href="/imports">Importy</a><a href="/runs">Zadania</a><a href="/results">Wyniki</a></>}{permittedRole && <a href="/audit" aria-current="page">Audyt</a>}<a href="/account">Moje konto</a></nav></header>
    <section className="history-content audit-content">
      <p className="eyebrow">PLATFORMA / BEZPIECZEŃSTWO</p><h1>Dziennik audytu</h1>
      <p className="history-lede">Przeszukuj zdarzenia organizacji. Wpisy nie zawierają treści plików ani danych formularzy.</p>
      {sessionState === "loading" && <p className="history-notice" role="status">Sprawdzanie sesji…</p>}
      {sessionState === "signed-out" && <p className="history-notice" role="status">Sesja wygasła. <a href={`/?returnTo=${encodeURIComponent(returnTo)}`}>Zaloguj się, aby wrócić do audytu</a>.</p>}
      {sessionState === "error" && <p className="history-error" role="alert">Nie udało się sprawdzić sesji. Odśwież stronę.</p>}
      {sessionState === "ready" && !permittedRole && <p className="history-error" role="alert">Twoja rola nie ma dostępu do dziennika audytu.</p>}
      {sessionState === "ready" && permittedRole && <>
        <form className="history-filters audit-filters" onSubmit={applyFilters}>
          <label>Od dnia (Warszawa)<input aria-label="Od dnia (Warszawa)" type="date" value={draftFilters.fromDay} required onChange={(event) => setDraftFilters({ ...draftFilters, fromDay: event.target.value })} /></label>
          <label>Do dnia (Warszawa)<input aria-label="Do dnia (Warszawa)" type="date" value={draftFilters.toDay} required onChange={(event) => setDraftFilters({ ...draftFilters, toDay: event.target.value })} /></label>
          {!reviewer && <label>Aktor ID<input value={draftFilters.actorId} onChange={(event) => setDraftFilters({ ...draftFilters, actorId: event.target.value })} maxLength={36} /></label>}
          <label>Czynność<select value={draftFilters.action} onChange={(event) => setDraftFilters({ ...draftFilters, action: event.target.value })}><option value="">Wszystkie</option>{(reviewer ? reviewerActions : allActions).map((action) => <option key={action} value={action}>{action}</option>)}</select></label>
          <label>Rodzaj zasobu<select value={draftFilters.resourceType} onChange={(event) => setDraftFilters({ ...draftFilters, resourceType: event.target.value })}><option value="">Wszystkie</option>{(reviewer ? reviewerResources : allResources).map((resource) => <option key={resource} value={resource}>{resource}</option>)}</select></label>
          {!reviewer && <label>ID zasobu<input value={draftFilters.resourceId} onChange={(event) => setDraftFilters({ ...draftFilters, resourceId: event.target.value })} maxLength={80} /></label>}
          <label>Wynik<select value={draftFilters.outcome} onChange={(event) => setDraftFilters({ ...draftFilters, outcome: event.target.value })}><option value="">Dowolny</option><option value="succeeded">Powodzenie</option><option value="failed">Błąd</option><option value="denied">Odmowa</option></select></label>
          <label>Narzędzie ID<input value={draftFilters.toolId} onChange={(event) => setDraftFilters({ ...draftFilters, toolId: event.target.value })} maxLength={80} placeholder="np. oc-policy-verification" /></label>
          <button type="submit">Szukaj zdarzeń</button>
        </form>
        <p className="history-timezone">Zakres dni jest interpretowany w strefie Europe/Warsaw; koniec zakresu obejmuje cały wybrany dzień.</p>
        {reviewer && <p className="audit-scope-note">Widoczne są wyłącznie dozwolone zdarzenia operacyjne dotyczące narzędzi, do których masz aktualny grant podglądu lub pobierania.</p>}
        {error && <p className="history-error" role="alert">{error}</p>}
        {loading && <p className="history-notice" role="status">Ładowanie zdarzeń…</p>}
        {!loading && !error && items.length === 0 && <section className="history-empty"><h2>Brak zdarzeń dla tych filtrów</h2><p>Zmień zakres dat lub usuń część filtrów.</p></section>}
        {!loading && !error && items.length > 0 && <div className="audit-event-list" aria-live="polite">{items.map((event) => <article className="audit-event" key={event.eventId}>
          <div className="audit-event-time"><time dateTime={event.createdAt}>{displayDate(event.createdAt)}</time><span>{event.outcome === "succeeded" ? "Powodzenie" : event.outcome === "denied" ? "Odmowa" : "Błąd"}</span></div>
          <div className="audit-event-main"><h2><code>{event.action}</code></h2><p>{event.actorUsername ?? "System"} · {event.resourceType}{event.resourceId ? ` · ${event.resourceId}` : ""}</p></div>
        </article>)}</div>}
        <div className="history-pagination"><button type="button" onClick={previousPage} disabled={pageIndex === 0 || loading}>Nowsze</button><span>Strona {pageIndex + 1}</span><button type="button" onClick={nextPage} disabled={!nextCursor || loading}>Starsze</button></div>
      </>}
    </section>
  </main>;
}
