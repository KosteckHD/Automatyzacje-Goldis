"use client";

import { useEffect, useRef, useState } from "react";

type ResultSetSummary = {
  resultSetId: string;
  sourceType: string;
  sourceId: string;
  batchId: string;
  referenceDate: string;
  status: string;
  counts: { rows: number; uniqueGroups: number; policyCount: number; byStatus: Record<string, number> };
};
type ResultRow = {
  sourceRowId: string;
  rowNumber: number;
  companyName: string;
  status: string;
  reasonCode: string | null;
  runId: string | null;
  runStatus: string | null;
  policyCount: number;
};
type ResultRowsPage = { items: ResultRow[]; nextCursor: string | null };

const statusLabels: Record<string, string> = {
  queued: "Oczekuje na uruchomienie",
  running: "W toku",
  waiting_attention: "Wymaga uwagi",
  completed: "Zakończono",
  no_matching_policies: "Brak aktualnych polis",
  failed: "Błąd",
  cancelled: "Anulowano",
  needs_review: "Do kontroli",
  review: "Do kontroli",
  excluded: "Pominięto",
};

async function payload<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw Object.assign(new Error(value.message || `Nie udało się pobrać wyników (${response.status}).`), { status: response.status });
  return value;
}

export default function ResultSetWorkspace({
  resultSetId: directResultSetId,
  expectedBatchId,
  submissionId,
  executionId,
  canDownload,
  onOpenRun,
  onStatus,
  onUnauthorized,
}: {
  resultSetId?: string | null;
  expectedBatchId?: string | null;
  submissionId?: string | null;
  executionId?: string | null;
  canDownload: boolean;
  onOpenRun?: (runId: string) => void;
  onStatus?: (status: string) => void;
  onUnauthorized?: () => void;
}) {
  const [resultSetId, setResultSetId] = useState<string | null>(directResultSetId ?? executionId ?? null);
  const [summary, setSummary] = useState<ResultSetSummary | null>(null);
  const loadedPages = useRef(1);
  const rowQuery = useRef("");
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [rowsLoading, setRowsLoading] = useState(false);
  const [contextState, setContextState] = useState<"loading" | "missing" | "ready">(
    directResultSetId || executionId ? "ready" : submissionId ? "loading" : "missing",
  );
  const [summaryLoading, setSummaryLoading] = useState(Boolean(directResultSetId || executionId));
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    setResultSetId(directResultSetId ?? executionId ?? null);
    setSummary(null);
    setRows([]);
    setCursor(null);
    setError("");
    setContextState(directResultSetId || executionId ? "ready" : submissionId ? "loading" : "missing");
    setSummaryLoading(Boolean(directResultSetId || executionId));
    if (directResultSetId || executionId || !submissionId) return;
    let stopped = false;
    fetch(`/api/run-submissions/${submissionId}`, { credentials: "same-origin" })
      .then((response) => payload<{ resultSetId: string | null }>(response))
      .then((current) => { if (!stopped) { setResultSetId(current.resultSetId); setContextState(current.resultSetId ? "ready" : "missing"); setSummaryLoading(Boolean(current.resultSetId)); } })
      .catch((cause) => { if (!stopped) { if ((cause as { status?: number })?.status === 401) onUnauthorized?.(); else setError(cause instanceof Error ? cause.message : "Nie udało się otworzyć zestawu wyników."); } });
    return () => { stopped = true; };
  }, [directResultSetId, expectedBatchId, submissionId, executionId, onUnauthorized, retryVersion]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!resultSetId) return;
    let stopped = false;
    let timer: number | null = null;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      if (!summary) setSummaryLoading(true);
      try {
        const current = await payload<ResultSetSummary>(await fetch(`/api/result-sets/${resultSetId}/summary`, { credentials: "same-origin" }));
        if (stopped) return;
        const requestedBatchId = expectedBatchId ?? new URLSearchParams(window.location.search).get("import");
        const sourceMismatch = submissionId
          ? current.sourceType !== "run_submission" || current.sourceId !== submissionId
          : executionId
            ? current.sourceType !== "prepared_set_execution" || current.sourceId !== executionId
            : false;
        if ((requestedBatchId && current.batchId !== requestedBatchId) || sourceMismatch) {
          setSummary(null);
          setRows([]);
          setCursor(null);
          setRowsLoading(false);
          setError("Import i zestaw wyników nie są ze sobą powiązane. Otwórz wyniki z właściwej operacji.");
          return;
        }
        setSummary(current);
        onStatus?.(current.status);
        setError("");
        if (!["completed", "cancelled", "failed"].includes(current.status)) timer = window.setTimeout(() => void refresh(), 4_000);
      } catch (cause) {
        if (!stopped) {
          if ((cause as { status?: number })?.status === 401) onUnauthorized?.();
          else {
            setError(cause instanceof Error ? cause.message : "Nie udało się odświeżyć wyników.");
            timer = window.setTimeout(() => void refresh(), 12_000);
          }
        }
      } finally { inFlight = false; if (!stopped) setSummaryLoading(false); }
    };
    void refresh();
    return () => { stopped = true; if (timer !== null) window.clearTimeout(timer); };
  }, [resultSetId, expectedBatchId, submissionId, executionId, onStatus, onUnauthorized, retryVersion]);

  useEffect(() => {
    if (!resultSetId || summary?.resultSetId !== resultSetId) { setRows([]); return; }
    let stopped = false;
    const controller = new AbortController();
    setRowsLoading(true);
    setRows([]);
    setCursor(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (statusFilter) params.set("status", statusFilter);
    const query = params.toString();
    const queryKey = `${resultSetId}:${query}`;
    if (rowQuery.current !== queryKey) { rowQuery.current = queryKey; loadedPages.current = 1; }
    void (async () => {
      const items: ResultRow[] = [];
      let nextCursor: string | null = null;
      const pages = loadedPages.current;
      for (let index = 0; index < pages; index += 1) {
        const pageParams = new URLSearchParams(params);
        if (nextCursor) pageParams.set("cursor", nextCursor);
        const page = await payload<ResultRowsPage>(await fetch(`/api/result-sets/${resultSetId}/rows?${pageParams}`, { credentials: "same-origin", signal: controller.signal }));
        if (stopped) return;
        items.push(...(page.items ?? []));
        nextCursor = page.nextCursor ?? null;
        if (!nextCursor) break;
      }
      if (!stopped) { setRows(items); setCursor(nextCursor); }
    })().catch((cause) => { if (!stopped && !controller.signal.aborted) { if ((cause as { status?: number }).status === 401) onUnauthorized?.(); else setError(cause instanceof Error ? cause.message : "Nie udało się odczytać wierszy wyników."); } })
      .finally(() => { if (!stopped) setRowsLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, [resultSetId, summary, debouncedSearch, statusFilter, onUnauthorized, retryVersion]);

  async function loadMore() {
    if (!resultSetId || !cursor || loadingMore || rowsLoading) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ cursor });
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (statusFilter) params.set("status", statusFilter);
      const page = await payload<ResultRowsPage>(await fetch(`/api/result-sets/${resultSetId}/rows?${params.toString()}`, { credentials: "same-origin" }));
      loadedPages.current += 1;
      setRows((current) => [...current, ...(page.items ?? [])]);
      setCursor(page.nextCursor ?? null);
    } catch (cause) { if ((cause as { status?: number })?.status === 401) onUnauthorized?.(); else setError(cause instanceof Error ? cause.message : "Nie udało się pobrać kolejnych wyników."); }
    finally { setLoadingMore(false); }
  }

  return <section className="result-section oc-results" aria-labelledby="oc-results-title" aria-busy={summaryLoading || rowsLoading}>
    <div className="section-head"><div><p className="eyebrow">KROK 08 / ZAPISANE WYNIKI</p><h3 id="oc-results-title">Wyniki tej partii</h3></div>
      {summary && canDownload && <a className="download-link" href={`/api/result-sets/${summary.resultSetId}/export`}>Pobierz raport Excel</a>}
    </div>
    {summary && <>
      <p>Zestaw {summary.resultSetId.slice(0, 8)} · data odniesienia {summary.referenceDate} · stan: {statusLabels[summary.status] ?? summary.status}</p>
      {!(["completed", "cancelled", "failed"].includes(summary.status)) && <p className="submission-notice">Wyniki są częściowe. Raport Excel zawiera ich stan i godzinę utworzenia.</p>}
      <dl className="submission-counts">
        <div><dt>Wiersze</dt><dd>{summary.counts.rows}</dd></div>
        <div><dt>Osobne zadania</dt><dd>{summary.counts.uniqueGroups}</dd></div>
        <div><dt>Zapisane polisy</dt><dd>{summary.counts.policyCount}</dd></div>
        {Object.entries(summary.counts.byStatus).map(([status, count]) => <div key={status}><dt>{statusLabels[status] ?? status.replaceAll("_", " ")}</dt><dd>{count}</dd></div>)}
      </dl>
    </>}
    {!summary && contextState === "loading" && summaryLoading && !error && <p className="intervention-empty" role="status">Wczytuję dane zapisanej operacji…</p>}
    {!summary && contextState === "loading" && !summaryLoading && !error && <p className="intervention-empty" role="status">Odczyt operacji nie zwrócił jeszcze zestawu wyników.</p>}
    {!summary && contextState === "missing" && <div className="intervention-empty"><strong>Nie wybrano sprawdzania OC</strong><p>Wybierz zapisaną operację, aby zobaczyć jej wynik. Samo otwarcie tego etapu nie uruchamia odczytu ani nowej operacji.</p><a className="lead-inline-link" href={submissionId ? `/submissions/${encodeURIComponent(submissionId)}` : "/runs"}>{submissionId ? "Otwórz zgłoszenie" : "Otwórz przebiegi"} →</a></div>}
    {error && <div className="error" role="alert"><p>{error}</p><button type="button" onClick={() => { setError(""); setRetryVersion((value) => value + 1); }}>Spróbuj ponownie</button></div>}
    {summary && <div className="row-tools"><label>Szukaj firmy<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Wpisz nazwę firmy" maxLength={120} /></label>
      <label>Wynik<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">Wszystkie wyniki</option><option value="queued">Oczekujące</option><option value="running">W toku</option><option value="waiting_attention">Wymagają uwagi</option><option value="completed">Zakończone</option><option value="no_matching_policies">Brak polis</option><option value="failed">Błąd</option><option value="cancelled">Anulowane</option><option value="needs_review">Do kontroli</option><option value="excluded">Pominięte</option></select></label>
      <span>Pokazano {rows.length} z {summary.counts.rows}</span></div>}
    {rowsLoading && <p className="intervention-empty">Aktualizuję listę wyników…</p>}
    {rows.length > 0 && <div className="table-wrap" tabIndex={0} role="region" aria-label="Wyniki wierszy tego zestawu; przewiń poziomo, aby zobaczyć kolumny">
      <table><thead><tr><th>Wiersz</th><th>Firma</th><th>Wynik</th><th>Polisy</th><th>Szczegóły</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.sourceRowId}>
          <td>{row.rowNumber}</td><td>{row.companyName}</td><td>{statusLabels[row.status] ?? row.status.replaceAll("_", " ")}{row.reasonCode ? <small className="table-note">{row.reasonCode}</small> : null}</td>
          <td>{row.policyCount}</td><td>{row.runId && onOpenRun ? <button type="button" onClick={() => onOpenRun(row.runId!)}>Otwórz zadanie</button> : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {cursor && <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Pobieram…" : "Pokaż kolejne wiersze"}</button>}
    {!rowsLoading && !rows.length && summary && <p className="intervention-empty">Brak wierszy spełniających wybrane filtry.</p>}
    <p className="table-note">Raport obejmuje tylko zapisane wyniki tego zestawu. Eksport korzysta z utrwalonych snapshotów polis.</p>
  </section>;
}
