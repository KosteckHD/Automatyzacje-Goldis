"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GoldisLogo } from "../../../components/brand/GoldisLogo";

type Session = { role: string; csrfToken: string };
type Submission = {
  submissionId: string; importBatchId: string; referenceDate: string; status: string; version: number;
  counts: { items: Record<string, number>; groups: Record<string, number>; selectedRows: number; uniqueGroups: number };
  createdAt: string; updatedAt: string;
};
type Item = {
  itemId: string; rowNumber: number; expectedRowVersion: number; preparationState: "ready" | "review" | "excluded";
  reasonCode: string | null; admissionState: string | null; groupReason: string | null; runId: string | null; runStatus: string | null; runErrorCode: string | null;
};
type ItemPage = { items: Item[]; nextCursor: string | null };

const statusLabels: Record<string, string> = {
  queued: "Oczekuje na przyjęcie", running: "Zadania są wykonywane", waiting_attention: "Wymaga uwagi",
  completed: "Zakończono", cancelled: "Anulowano",
};
const itemLabels: Record<string, string> = {
  review: "Do kontroli", excluded: "Pominięty", waiting: "Oczekuje na przyjęcie", running: "W toku",
  waiting_attention: "Wymaga uwagi", completed: "Zakończono", no_matching_policies: "Brak aktualnych polis",
  failed: "Błąd", cancelled: "Anulowano", blocked: "Zablokowany",
};
const reasonLabels: Record<string, string> = {
  PENDING_REGON_CORRECTION: "Oczekuje korekta REGON", OPEN_ENTITY_CONFLICT: "Otwarty konflikt grupowania",
  REGON_REQUIRED: "Brak REGON-u", SOURCE_ROW_HAS_ISSUES: "Błąd walidacji danych", INVALID_NIP: "Nieprawidłowy NIP",
  INVALID_REGON: "Nieprawidłowy REGON", HOURLY_RUN_LIMIT: "Osiągnięto limit zadań na godzinę",
  OUTSIDE_RUN_WINDOW: "Poza dozwolonymi godzinami", NEW_RUNS_PAUSED: "Nowe zadania są wstrzymane",
  SOURCE_VERSION_CHANGED: "Dane zmieniły się po przygotowaniu podglądu", PENDING_CORRECTION: "Oczekuje korekta REGON",
  OPEN_CONFLICT: "Konflikt grupowania wymaga rozstrzygnięcia", EXECUTE_ACCESS_REVOKED: "Prawo uruchomienia zostało cofnięte",
  ACTIVE_RUN_REFERENCE_DATE_MISMATCH: "Aktywne zadanie ma inną datę odniesienia", GROUP_REVIEW_REQUIRED: "Grupowanie wymaga kontroli",
};

async function payload<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(value.message ?? `Żądanie nie powiodło się (${response.status}).`);
  return value;
}

function shouldPoll(submission: Submission): boolean {
  if (["completed", "cancelled", "waiting_attention"].includes(submission.status)) return false;
  const items = submission.counts.items;
  return (items.waiting ?? 0) > 0 || (items.running ?? 0) > 0;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function SubmissionDetail({ submissionId }: { submissionId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [auth, setAuth] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const inflight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/me", { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { setAuth("signed-out"); return; }
      const me = await payload<Session>(response);
      setSession(me); setAuth("ready");
    }).catch(() => { if (!controller.signal.aborted) setAuth("error"); });
    return () => controller.abort();
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (inflight.current) return;
    inflight.current = true;
    setRefreshing(true);
    try {
      const cursor = cursorStack[pageIndex];
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const [summaryResponse, itemsResponse] = await Promise.all([
        fetch(`/api/run-submissions/${submissionId}`, { credentials: "same-origin", signal }),
        fetch(`/api/run-submissions/${submissionId}/items${suffix}`, { credentials: "same-origin", signal }),
      ]);
      const [summary, page] = await Promise.all([payload<Submission>(summaryResponse), payload<ItemPage>(itemsResponse)]);
      setSubmission(summary); setItems(page.items); setNextCursor(page.nextCursor); setError("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać stanu zgłoszenia.");
    } finally {
      inflight.current = false;
      if (!signal?.aborted) setRefreshing(false);
    }
  }, [cursorStack, pageIndex, submissionId]);

  useEffect(() => {
    if (auth !== "ready") return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [auth, refresh]);

  useEffect(() => {
    if (!submission || !shouldPoll(submission)) return;
    const timer = window.setTimeout(() => { void refresh(); }, 4_000);
    return () => window.clearTimeout(timer);
  }, [submission, refresh]);

  async function cancelPending() {
    if (!submission || !session || cancelBusy || !window.confirm("Anulować oczekujące zadania tej partii? Zadania już przyjęte będą kontynuowane.")) return;
    setCancelBusy(true); setError("");
    try {
      const response = await fetch(`/api/run-submissions/${submissionId}/cancel`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ expectedVersion: submission.version }),
      });
      const result = await payload<{ status: string; version: number }>(response);
      setSubmission((current) => current ? { ...current, status: result.status, version: result.version } : current);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się anulować oczekujących zadań."); }
    finally { setCancelBusy(false); }
  }

  function previousPage() {
    if (pageIndex === 0) return;
    setPageIndex((index) => index - 1);
  }
  function followingPage() {
    if (!nextCursor) return;
    const next = [...cursorStack.slice(0, pageIndex + 1), nextCursor];
    setCursorStack(next); setPageIndex(next.length - 1);
  }

  return <main className="history-page submission-page">
    <header className="history-topbar"><a className="history-brand" href="/" aria-label="Goldis — katalog"><GoldisLogo variant="header" /><span>Goldis · Platforma automatyzacji</span></a><nav aria-label="Nawigacja"><a href="/">Katalog</a><a href="/imports">Importy</a><a href="/runs">Zadania</a><a href="/account">Moje konto</a></nav></header>
    <section className="history-content">
      <p className="eyebrow">PLATFORMA / ZADANIA</p><h1>Stan zgłoszenia</h1>
      {auth === "loading" && <p className="history-notice" role="status">Sprawdzanie sesji…</p>}
      {auth === "signed-out" && <p className="history-notice" role="status">Sesja wygasła. <a href={`/?returnTo=${encodeURIComponent(`/submissions/${submissionId}`)}`}>Zaloguj się, aby wrócić do zgłoszenia</a>.</p>}
      {auth === "error" && <p className="history-error" role="alert">Nie udało się sprawdzić sesji. Odśwież stronę.</p>}
      {error && <p className="history-error" role="alert">{error}</p>}
      {submission && <>
        {(() => {
          const cancellableGroups = (submission.counts.groups.pending ?? 0) + (submission.counts.groups.waiting ?? 0);
          return <section className="submission-status-card" aria-live="polite">
          <div><p className="eyebrow">{submission.status === "waiting_attention" ? "WYMAGA UWAGI" : "STATUS"}</p><h2>{statusLabels[submission.status] ?? submission.status}</h2><p>Data odniesienia: {submission.referenceDate} · Utworzono {formatDate(submission.createdAt)}</p></div>
          <div className="submission-actions"><button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "Odświeżam…" : "Odśwież stan"}</button>{cancellableGroups > 0 && (session?.role === "admin" || session?.role === "operator") && <button type="button" onClick={() => void cancelPending()} disabled={cancelBusy}>{cancelBusy ? "Anuluję…" : "Anuluj oczekujące"}</button>}</div>
        </section>;
        })()}
        <dl className="submission-counts submission-detail-counts"><div><dt>Wybrane wiersze</dt><dd>{submission.counts.selectedRows}</dd></div><div><dt>Unikalne grupy</dt><dd>{submission.counts.uniqueGroups}</dd></div><div><dt>Przyjęte runy</dt><dd>{submission.counts.groups.accepted ?? 0}</dd></div><div><dt>Oczekujące grupy</dt><dd>{(submission.counts.groups.pending ?? 0) + (submission.counts.groups.waiting ?? 0)}</dd></div>{Object.entries(submission.counts.items).map(([key, value]) => <div key={key}><dt>{itemLabels[key] ?? key}</dt><dd>{value}</dd></div>)}</dl>
        {submission.status === "waiting_attention" && <p className="submission-notice">Część wierszy wymaga kontroli lub konfiguracji. Możesz odświeżyć stan po rozwiązaniu problemu.</p>}
        <section className="submission-items-section"><div className="section-head"><div><p className="eyebrow">SZCZEGÓŁY</p><h2>Wiersze zgłoszenia</h2></div><span className="history-timezone">Strona {pageIndex + 1}</span></div>
          {items.length === 0 ? <p className="history-notice">Brak wierszy do wyświetlenia.</p> : <div className="submission-items" role="list">{items.map((item) => {
            const state = item.preparationState !== "ready" ? item.preparationState : item.runStatus === "completed" ? "completed" : item.runStatus === "no_matching_policies" ? "no_matching_policies" : item.runStatus === "failed" ? "failed" : item.runStatus === "cancelled" || item.admissionState === "cancelled" ? "cancelled" : item.runStatus && ["waiting_for_sms", "waiting_for_manual_data", "identity_review"].includes(item.runStatus) ? "waiting_attention" : item.runStatus ? "running" : item.admissionState === "blocked" ? "blocked" : item.admissionState === "waiting_capacity" || item.admissionState === "waiting_window" || item.admissionState === "waiting_paused" ? "waiting" : "waiting";
            const reason = item.reasonCode ?? item.groupReason ?? item.runErrorCode;
            return <article className="submission-item" role="listitem" key={item.itemId}><strong>Wiersz {item.rowNumber}</strong><span>{itemLabels[state] ?? state}</span>{reason && <small>{reasonLabels[reason] ?? reason.replaceAll("_", " ")}</small>}{item.runId && <a className="submission-item-link" href={`/runs/${item.runId}`}>Otwórz powiązane zadanie</a>}</article>;
          })}</div>}
          <div className="history-pagination"><button type="button" onClick={previousPage} disabled={pageIndex === 0 || refreshing}>Poprzednia strona</button><span>Strona {pageIndex + 1}</span><button type="button" onClick={followingPage} disabled={!nextCursor || refreshing}>Następna strona</button></div>
        </section>
      </>}
      {!submission && auth === "ready" && !error && <p className="history-notice" role="status">Ładowanie zgłoszenia…</p>}
      <p className="submission-back"><a href="/tools/oc-policy-verification">Wróć do narzędzia OC</a> · <a href="/runs">Historia zadań</a></p>
    </section>
  </main>;
}
