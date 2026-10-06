"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { GoldisLogo } from "../../components/brand/GoldisLogo";

type HistoryKind = "imports" | "runs" | "results";
type HistoryItem = {
  id: string; batchId?: string; toolId: string; fileName?: string; totalRows?: number; reviewCount?: number;
  ownerLabel?: string | null; rowNumber?: number; status?: string; referenceDate?: string; errorCode?: string | null;
  createdAt: string; policyCounts?: { totalOcCount: number; currentOcCount: number } | null; artifactAvailable?: boolean;
};
type Session = { role?: string; tools?: { toolId: string; canViewResults: boolean; canDownloadResults: boolean }[] };
type Page = { items: HistoryItem[]; nextCursor: string | null };

const runLabels: Record<string, string> = {
  queued: "W kolejce", validating: "Sprawdzanie danych", awaiting_portal_adapter: "Oczekuje na adapter portali",
  pzu_login: "Logowanie w Everest", waiting_for_sms: "Oczekuje na SMS", everest_search: "Wyszukiwanie w Everest",
  identity_review: "Weryfikacja tożsamości", compensa_login: "Logowanie do Compensy", compensa_form: "Formularz Compensy",
  waiting_for_manual_data: "Wymaga uzupełnienia", ufg_verification: "Weryfikacja UFG", reading_oc: "Odczyt polis OC",
  export_ready: "Przygotowanie wyniku", no_matching_policies: "Brak aktualnych polis OC", completed: "Zakończono",
  cancelled: "Anulowano", failed: "Błąd",
};

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function dayBoundary(value: string, end: boolean): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + (end ? 1 : 0)));
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const adjustment = target - represented;
    guess += adjustment;
    if (!adjustment) break;
  }
  return new Date(end ? guess - 1 : guess).toISOString();
}

function queryFromUrl(): { toolId: string; dataState: string; status: string; fromDay: string; toDay: string; cursor: string | null } {
  const params = new URLSearchParams(window.location.search);
  return {
    toolId: params.get("toolId") ?? "",
    dataState: params.get("dataState") ?? "all",
    status: params.get("status") ?? "",
    fromDay: params.get("fromDay") ?? "",
    toDay: params.get("toDay") ?? "",
    cursor: params.get("cursor"),
  };
}

export default function HistoryList({ kind }: { kind: HistoryKind }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [toolId, setToolId] = useState("");
  const [dataState, setDataState] = useState("all");
  const [status, setStatus] = useState("");
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  const cursorStackRef = useRef<Array<string | null>>([null]);

  useEffect(() => {
    const params = queryFromUrl();
    setToolId(params.toolId);
    setDataState(params.dataState);
    setStatus(params.status);
    setFromDay(params.fromDay);
    setToDay(params.toDay);
    setCursor(params.cursor);
    setCursorStack(params.cursor ? [null, params.cursor] : [null]);
    cursorStackRef.current = params.cursor ? [null, params.cursor] : [null];
    setPageIndex(params.cursor ? 1 : 0);
    window.history.replaceState({ goldisHistory: true, cursorStack: params.cursor ? [null, params.cursor] : [null], pageIndex: params.cursor ? 1 : 0 }, "", window.location.href);
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
      const params = queryFromUrl();
      setToolId(params.toolId); setDataState(params.dataState); setStatus(params.status);
      setFromDay(params.fromDay); setToDay(params.toDay); setCursor(params.cursor);
      const state = window.history.state as { cursorStack?: unknown; pageIndex?: unknown } | null;
      if (Array.isArray(state?.cursorStack) && state.cursorStack.every((item) => item === null || typeof item === "string")
        && Number.isInteger(state?.pageIndex) && (state?.pageIndex as number) >= 0) {
        const restored = state.cursorStack as Array<string | null>;
        cursorStackRef.current = restored;
        setCursorStack(restored);
        setPageIndex(state.pageIndex as number);
        return;
      }
      const found = cursorStackRef.current.indexOf(params.cursor);
      if (found >= 0) setPageIndex(found);
      else { setPageIndex(0); setCursorStack([null]); cursorStackRef.current = [null]; }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (sessionState !== "ready") return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (toolId) params.set("toolId", toolId);
    const from = dayBoundary(fromDay, false);
    const to = dayBoundary(toDay, true);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (kind === "imports") params.set("dataState", dataState);
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    params.set("limit", "50");
    const endpoint = kind === "imports" ? "/api/imports" : kind === "runs" ? "/api/history/runs" : "/api/history/results";
    setLoading(true); setError("");
    fetch(`${endpoint}?${params}`, { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { setSessionState("signed-out"); return; }
      const payload = await response.json().catch(() => ({})) as Page & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? `Historia jest niedostępna (${response.status}).`);
      const page = payload as Page;
      setItems(Array.isArray(page.items) ? page.items : []);
      setNextCursor(page.nextCursor ?? null);
      setEmpty(Array.isArray(page.items) && page.items.length === 0);
    }).catch((cause) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać historii."); setItems([]); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionState, kind, toolId, dataState, status, fromDay, toDay, cursor]);

  function writeUrl(next: { toolId: string; dataState: string; status: string; fromDay: string; toDay: string; cursor: string | null }, stack: Array<string | null>, index: number, replace = false) {
    const params = new URLSearchParams();
    if (next.toolId) params.set("toolId", next.toolId);
    if (kind === "imports" && next.dataState !== "all") params.set("dataState", next.dataState);
    if (next.status) params.set("status", next.status);
    if (next.fromDay) params.set("fromDay", next.fromDay);
    if (next.toDay) params.set("toDay", next.toDay);
    if (next.cursor) params.set("cursor", next.cursor);
    const url = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history[replace ? "replaceState" : "pushState"]({ goldisHistory: true, cursorStack: stack, pageIndex: index }, "", url);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCursor(null); setCursorStack([null]); cursorStackRef.current = [null]; setPageIndex(0);
    writeUrl({ toolId, dataState, status, fromDay, toDay, cursor: null }, [null], 0);
  }

  function nextPage() {
    if (!nextCursor) return;
    const next = [...cursorStack.slice(0, pageIndex + 1), nextCursor];
    cursorStackRef.current = next; setCursorStack(next); setPageIndex(pageIndex + 1); setCursor(nextCursor);
    writeUrl({ toolId, dataState, status, fromDay, toDay, cursor: nextCursor }, next, pageIndex + 1);
  }

  function previousPage() {
    if (pageIndex < 1) return;
    const previous = cursorStack[pageIndex - 1] ?? null;
    setPageIndex(pageIndex - 1); setCursor(previous);
    writeUrl({ toolId, dataState, status, fromDay, toDay, cursor: previous }, cursorStack, pageIndex - 1);
  }

  const title = kind === "imports" ? "Historia importów" : kind === "runs" ? "Historia zadań" : "Wyniki weryfikacji";
  const description = kind === "imports" ? "Wróć do wcześniejszego importu i zobacz, ile wierszy wymaga przeglądu."
    : kind === "runs" ? "Śledź wykonanie zadań dla dozwolonych importów."
      : "Zobacz wyniki zakończone, także zadania bez aktualnych polis OC.";
  const returnTo = `${windowSafePath()}${typeof window === "undefined" ? "" : window.location.search}`;
  const canDownload = session?.tools?.some((tool) => tool.toolId === "oc-policy-verification" && tool.canDownloadResults) ?? false;

  return <main className="history-page">
    <header className="history-topbar"><a className="history-brand" href="/" aria-label="Goldis — katalog"><GoldisLogo variant="header" /><span>Goldis · Platforma automatyzacji</span></a><nav aria-label="Historia"><a href="/">Katalog</a>{sessionState === "ready" && session?.role !== "auditor" && <><a href="/imports">Importy</a><a href="/runs">Zadania</a><a href="/results">Wyniki</a></>}{sessionState === "ready" && session?.role && ["admin", "reviewer", "auditor"].includes(session.role) && <a href="/audit">Audyt</a>}<a href="/account">Moje konto</a></nav></header>
    <section className="history-content">
      <p className="eyebrow">PLATFORMA / OC</p><h1>{title}</h1><p className="history-lede">{description}</p>
      {sessionState === "loading" && <p className="history-notice" role="status">Sprawdzanie sesji…</p>}
      {sessionState === "signed-out" && <p className="history-notice" role="status">Sesja wygasła. <a href={`/?returnTo=${encodeURIComponent(returnTo)}`}>Zaloguj się, aby wrócić do tej historii</a>.</p>}
      {sessionState === "error" && <p className="history-error" role="alert">Nie udało się sprawdzić sesji. Odśwież stronę.</p>}
      {sessionState === "ready" && <>
        <form className="history-filters" onSubmit={applyFilters}>
          <label>Narzędzie<select value={toolId} onChange={(event) => setToolId(event.target.value)}><option value="">Wszystkie z dostępem</option><option value="oc-policy-verification">Weryfikacja polis OC</option></select></label>
          {kind === "imports" && <label>Stan danych<select value={dataState} onChange={(event) => setDataState(event.target.value)}><option value="all">Wszystkie</option><option value="ready">Gotowe</option><option value="needs_review">Do przeglądu</option></select></label>}
          {kind !== "imports" && <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Wszystkie</option>{(kind === "results" ? ["completed", "no_matching_policies"] : ["queued", "validating", "awaiting_portal_adapter", "pzu_login", "waiting_for_sms", "everest_search", "identity_review", "compensa_login", "compensa_form", "waiting_for_manual_data", "ufg_verification", "reading_oc", "export_ready", "no_matching_policies", "completed", "cancelled", "failed"]).map((item) => <option key={item} value={item}>{runLabels[item] ?? item}</option>)}</select></label>}
          <label>Od dnia (Warszawa)<input type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} /></label>
          <label>Do dnia (Warszawa)<input type="date" value={toDay} onChange={(event) => setToDay(event.target.value)} /></label>
          <button type="submit">Zastosuj filtry</button>
        </form>
        <p className="history-timezone">Daty filtrowane według strefy Europe/Warsaw. Czasy zdarzeń wyświetlamy w tej samej strefie.</p>
        {error && <p className="history-error" role="alert">{error}</p>}
        {loading && <p className="history-notice" role="status">Ładowanie historii…</p>}
        {!loading && !error && empty && <section className="history-empty"><h2>Brak pozycji dla tych filtrów</h2><p>Wyczyść filtr lub wykonaj nowy import w narzędziu OC.</p><a href="/tools/oc-policy-verification">Otwórz narzędzie OC</a></section>}
        {!loading && !error && items.length > 0 && <div className="history-list" aria-live="polite">{items.map((item) => {
          const moduleAvailable = item.toolId === "oc-policy-verification";
          const workspace = `/tools/oc-policy-verification?${new URLSearchParams({ ...(item.batchId ? { import: item.batchId } : { import: item.id }), ...(kind !== "imports" ? { run: item.id } : {}) })}`;
          return <article className="history-row" key={item.id}>
            <div className="history-row-main">
              <span className="history-row-kicker">{kind === "imports" ? item.toolId : `Wiersz ${item.rowNumber}`}</span>
              <h2>{kind === "imports" ? item.fileName : runLabels[item.status ?? ""] ?? item.status}</h2>
              <p>{kind === "imports" ? `${item.totalRows ?? 0} wierszy · ${item.reviewCount ?? 0} do przeglądu${item.ownerLabel ? ` · ${item.ownerLabel}` : ""}`
                : kind === "results" ? item.status === "no_matching_policies" ? "Brak polis OC aktualnych na dzień sprawdzenia" : `${item.policyCounts?.currentOcCount ?? 0} aktualnych polis OC · ${item.policyCounts?.totalOcCount ?? 0} w danych źródłowych`
                  : `Import ${item.batchId} · data sprawdzenia ${item.referenceDate ?? "—"}${item.errorCode ? ` · ${item.errorCode}` : ""}`}</p>
              <time dateTime={item.createdAt}>{displayDate(item.createdAt)}</time>
            </div>
            <div className="history-row-actions">
              {moduleAvailable
                ? <a className="history-open" href={kind === "imports" ? `/imports/${item.id}` : kind === "results" ? `/runs/${item.id}` : workspace}>{kind === "imports" ? "Otwórz import" : kind === "results" ? "Otwórz wynik" : "Otwórz zadanie"}</a>
                : <span className="history-muted">Moduł narzędzia nie jest jeszcze dostępny</span>}
              {kind === "results" && item.status === "completed" && item.artifactAvailable && (canDownload
                ? <a className="history-download" href={`/api/runs/${item.id}/artifact`}>Pobierz Excel</a>
                : <span className="history-muted">Plik gotowy · brak uprawnienia do pobrania</span>)}
            </div>
          </article>;
        })}</div>}
        <div className="history-pagination"><button type="button" onClick={previousPage} disabled={pageIndex === 0 || loading}>Poprzednia strona</button><span>Strona {pageIndex + 1}</span><button type="button" onClick={nextPage} disabled={!nextCursor || loading}>Następna strona</button></div>
      </>}
    </section>
  </main>;
}

function windowSafePath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
}
