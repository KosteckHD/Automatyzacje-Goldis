"use client";

import { useEffect, useState, type FormEvent } from "react";

type ReviewRow = {
  rowNumber: number;
  companyName: string;
  decisionMakerName: string | null;
  regonRaw: string;
  effectiveRegon: string | null;
  rowVersion: number;
  issues: string[];
  state: "conflict" | "correction_pending" | "validation_review" | "missing_regon" | "ready";
  source: "missing" | "import" | "registry" | "manual" | "unknown";
  correction: { correctionId: string; proposedRegon: string; status: "pending" | "approved" | "rejected"; reason: string; createdAt: string } | null;
  lookup: { status: string; reasonCode: string | null; providerName: string; providerVersion: string; checkedAt: string } | null;
  conflict: { reasonCode: string; candidateCount: number; createdAt: string } | null;
};

type ReviewData = {
  page: number;
  pageSize: number;
  totalRows: number;
  summary: { missingRegonRows: number; pendingCorrectionRows: number; openConflictRows: number; lookupStatuses: Record<string, number> };
  rows: ReviewRow[];
};

type EnrichmentJob = {
  id: string;
  batchId: string;
  status: "queued" | "processing" | "completed" | "partial" | "failed" | "cancelled";
  selectedCount: number;
  completedCount: number;
  excludedCount: number;
  failedCount: number;
  cancelledCount: number;
  version: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

type EnrichmentJobItem = {
  rowNumber: number;
  status: string;
  reasonCode: string | null;
  errorCode: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
};

type EnrichmentRuntimeHealth = {
  status: "ready" | "not_ready";
  available: boolean;
  worker: "disabled" | "ready" | "degraded" | "offline";
  provider: "disabled" | "configured" | "unknown";
  providerName: string | null;
  message: string;
};

const sourceLabels: Record<ReviewRow["source"], string> = {
  missing: "Brak REGON-u",
  import: "Plik Excel",
  registry: "Rejestr",
  manual: "Korekta zatwierdzona",
  unknown: "Nieustalone",
};

const stateLabels: Record<ReviewRow["state"], string> = {
  conflict: "Konflikt podmiotu",
  correction_pending: "Korekta oczekuje",
  validation_review: "Dane do sprawdzenia",
  missing_regon: "Brak REGON-u",
  ready: "Gotowy",
};

const lookupLabels: Record<string, string> = {
  matched: "Dopasowano",
  not_found: "Brak wyniku",
  ambiguous: "Wiele możliwych wyników",
  manual_review: "Wymaga kontroli",
  unavailable: "Rejestr niedostępny",
};

const conflictLabels: Record<string, string> = {
  INVALID_NIP: "NIP ma nieprawidłowy format lub sumę kontrolną.",
  INVALID_REGON: "REGON ma nieprawidłowy format.",
  IDENTIFIER_MISSING: "Brakuje wspólnego, poprawnego identyfikatora firmy.",
  SOURCE_NAME_MISSING: "Brakuje nazwy firmy w źródle.",
  CANONICAL_IDENTITY_INVALID: "Zapisana grupa ma nieprawidłowy identyfikator.",
  SAME_NIP_DIFFERENT_REGON: "Ten sam NIP wskazuje różne numery REGON.",
  SAME_REGON_DIFFERENT_NIP: "Ten sam REGON wskazuje różne numery NIP.",
  NAME_MISMATCH: "Identyfikator pasuje, ale nazwa firmy jest inna.",
  MULTIPLE_CANONICAL_MATCHES: "W bazie istnieje więcej niż jedna pasująca grupa.",
  SOURCE_LINK_MISMATCH: "Powiązanie źródła z grupą wymaga ręcznej kontroli.",
};

const jobStatusLabels: Record<EnrichmentJob["status"], string> = {
  queued: "Oczekuje na workera",
  processing: "W trakcie",
  completed: "Zakończono",
  partial: "Zakończono częściowo",
  failed: "Nie udało się wykonać",
  cancelled: "Anulowano",
};

const itemStatusLabels: Record<string, string> = {
  pending: "Oczekuje",
  processing: "Sprawdzam",
  matched: "Dopasowano",
  not_found: "Brak wyniku",
  ambiguous: "Wymaga wyboru",
  manual_review: "Wymaga kontroli",
  excluded: "Pominięto",
  failed: "Błąd",
  cancelled: "Anulowano",
};

const runtimeStatusLabels: Record<EnrichmentRuntimeHealth["worker"], string> = {
  disabled: "worker działa, lookup wyłączony",
  ready: "worker działa",
  degraded: "worker wymaga uwagi",
  offline: "worker nie odpowiada",
};

const providerLabels: Record<string, string> = {
  "mf-vat": "MF VAT — wykaz podatników VAT",
  "gus-bir": "GUS BIR — rejestr REGON",
};

const providerCoverage: Record<string, string> = {
  "mf-vat": "Wykaz MF obejmuje podmioty ujęte w wykazie VAT; brak wyniku nie dowodzi, że firma nie istnieje.",
  "gus-bir": "GUS BIR wyszukuje w rejestrze REGON po NIP; produkcyjne użycie wymaga klucza wydanego przez GUS.",
};

const jobReasonLabels: Record<string, string> = {
  PROVIDER_UNCONFIGURED: "Dostawca rejestru nie jest skonfigurowany.",
  ROW_VERSION_CHANGED: "Wiersz zmienił się przed rozpoczęciem sprawdzania.",
  ROW_NO_LONGER_ELIGIBLE: "Dane wiersza zmieniły się w trakcie sprawdzania.",
  CORRECTION_PENDING: "Najpierw rozstrzygnij oczekującą korektę.",
  GROUPING_CONFLICT: "Najpierw rozstrzygnij konflikt podmiotu.",
  RUN_EXISTS: "Wiersz należy już do zadania automatyzacji.",
  REGON_PRESENT: "Wiersz ma już REGON.",
  REGON_REQUIRES_REVIEW: "Format REGON-u wymaga ręcznej kontroli.",
  NIP_INVALID: "NIP wymaga poprawy przed wyszukiwaniem.",
  RATE_LIMITED: "Dostawca ograniczył liczbę zapytań; zadanie ponowi próbę po wskazanym czasie.",
  REGISTRY_PROVIDER_UNAVAILABLE: "Dostawca rejestru jest chwilowo niedostępny; zadanie oczekuje na ponowienie.",
};

function jobSelectionStorageKey(batchId: string): string {
  return `goldis.enrichment.selected-job.${batchId}`;
}

function readStoredJobSelection(batchId: string): string | null {
  try { return window.sessionStorage.getItem(jobSelectionStorageKey(batchId)); }
  catch { return null; }
}

function storeJobSelection(batchId: string, jobId: string): void {
  try { window.sessionStorage.setItem(jobSelectionStorageKey(batchId), jobId); }
  catch { /* The server remains the source of job state when storage is unavailable. */ }
}

function CorrectionProposal({ row, batchId, csrfToken, onUnauthorized, onConflict, onSubmitted }: {
  row: ReviewRow;
  batchId: string;
  csrfToken: string;
  onUnauthorized: () => void;
  onConflict: () => void;
  onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [regon, setRegon] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!csrfToken || pending) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${batchId}/rows/${row.rowNumber}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ proposedRegon: regon, reason, expectedVersion: row.rowVersion }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (response.status === 401) { onUnauthorized(); return; }
      if (response.status === 409) {
        setOpen(false);
        onConflict();
        onSubmitted();
        return;
      }
      if (!response.ok) throw new Error(payload.message || "Nie udało się zapisać propozycji korekty.");
      setMessage("Propozycja została zapisana do kontroli. Nie zmienia jeszcze wartości używanej przez zadania.");
      setRegon("");
      setReason("");
      setOpen(false);
      onSubmitted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zapisać propozycji korekty.");
    } finally {
      setPending(false);
    }
  }

  if (row.correction?.status === "pending") return <p className="review-note">Propozycja {row.correction.proposedRegon} oczekuje na rozstrzygnięcie. Powód: {row.correction.reason} <a href={`/review?batchId=${encodeURIComponent(batchId)}&toolId=oc-policy-verification`}>Zobacz moje korekty</a></p>;

  return <div className="correction-action">
    {row.correction && <p className="review-note">Ostatnia propozycja: {row.correction.proposedRegon} · {row.correction.status === "approved" ? "zatwierdzona" : "odrzucona"}. {row.correction.reason}</p>}
    {message && <p className="review-success" role="status">{message}</p>}
    {!open ? <button className="review-button" type="button" onClick={() => setOpen(true)}>Zaproponuj korektę</button> : <form className="correction-form" onSubmit={submit}>
      <label>Proponowany REGON<input aria-label={`Proponowany REGON dla wiersza ${row.rowNumber}`} inputMode="numeric" autoComplete="off" pattern="[0-9]{9}([0-9]{5})?" maxLength={14} value={regon} onChange={(event) => setRegon(event.target.value.replace(/\D/g, "").slice(0, 14))} required /></label>
      <label>Powód<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} rows={2} required /></label>
      <div className="review-actions"><button type="submit" disabled={pending || !csrfToken}>{pending ? "Zapisywanie…" : "Zapisz propozycję"}</button><button type="button" className="quiet-button" onClick={() => setOpen(false)} disabled={pending}>Anuluj</button></div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>}
  </div>;
}

export default function EnrichmentReviewPanel({ batchId, csrfToken, canStart, onUnauthorized }: { batchId: string; csrfToken: string; canStart: boolean; onUnauthorized: () => void }) {
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<EnrichmentJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [jobItems, setJobItems] = useState<EnrichmentJobItem[]>([]);
  const [fromRow, setFromRow] = useState("");
  const [toRow, setToRow] = useState("");
  const [jobRefreshKey, setJobRefreshKey] = useState(0);
  const [jobItemPages, setJobItemPages] = useState(1);
  const [jobItemsCursor, setJobItemsCursor] = useState<string | null>(null);
  const [jobItemsHasMore, setJobItemsHasMore] = useState(false);
  const [jobItemsLoadingMore, setJobItemsLoadingMore] = useState(false);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobError, setJobError] = useState("");
  const [jobNotice, setJobNotice] = useState("");
  const [correctionNotice, setCorrectionNotice] = useState("");
  const [runtimeHealth, setRuntimeHealth] = useState<EnrichmentRuntimeHealth | null>(null);
  const [runtimeHealthUnavailable, setRuntimeHealthUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    fetch(`/api/imports/${batchId}/enrichment?page=${page}`, { credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as ReviewData & { message?: string };
        if (response.status === 401) { onUnauthorized(); return; }
        if (!response.ok) throw new Error(payload.message || "Nie udało się pobrać statusu REGON.");
        if (active) setData(payload);
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać statusu REGON."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [batchId, page, refreshKey, onUnauthorized]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/health/enrichment", { credentials: "same-origin", signal: controller.signal });
        const payload = await response.json().catch(() => null) as EnrichmentRuntimeHealth | null;
        if (!payload || typeof payload.message !== "string"
          || !["disabled", "ready", "degraded", "offline"].includes(payload.worker)
          || !["disabled", "configured", "unknown"].includes(payload.provider)
          || !(payload.providerName === null || typeof payload.providerName === "string")) {
          throw new Error("ENRICHMENT_HEALTH_INVALID");
        }
        if (active) {
          setRuntimeHealth((previous) => previous
            && previous.worker === payload.worker && previous.provider === payload.provider
            && previous.providerName === payload.providerName && previous.message === payload.message
            ? previous : payload);
          setRuntimeHealthUnavailable(false);
        }
      } catch {
        if (active && !controller.signal.aborted) setRuntimeHealthUnavailable(true);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 15_000);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let running = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const loadJobs = async () => {
      if (!active || running) return;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/imports/${batchId}/enrichment-jobs`, { credentials: "same-origin", signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as { items?: EnrichmentJob[]; message?: string };
        if (response.status === 401) { onUnauthorized(); return; }
        if (!response.ok) throw new Error(payload.message || "Nie udało się pobrać zadań rejestru.");
        const nextJobs = payload.items ?? [];
        if (!active) return;
        setJobs(nextJobs);
        setJobError("");
        const savedSelection = readStoredJobSelection(batchId);
        const selected = nextJobs.find((job) => job.id === selectedJobId)
          ?? nextJobs.find((job) => job.id === savedSelection)
          ?? nextJobs[0];
        if (selected && selected.id !== selectedJobId) {
          setSelectedJobId(selected.id);
          setJobItemPages(1);
          storeJobSelection(batchId, selected.id);
        }
        if (selected) {
          const allItems: EnrichmentJobItem[] = [];
          let cursor: string | undefined;
          const pagesToLoad = selected.id === selectedJobId ? jobItemPages : 1;
          for (let pageIndex = 0; pageIndex < pagesToLoad; pageIndex += 1) {
            const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
            const itemsResponse = await fetch(`/api/enrichment-jobs/${selected.id}/items${query}`, { credentials: "same-origin", signal: controller.signal });
            const itemsPayload = await itemsResponse.json().catch(() => ({})) as { items?: EnrichmentJobItem[]; nextCursor?: string | null };
            if (itemsResponse.status === 401) { onUnauthorized(); return; }
            if (!itemsResponse.ok) throw new Error("Nie udało się pobrać pozycji zadania.");
            allItems.push(...(itemsPayload.items ?? []));
            cursor = itemsPayload.nextCursor ?? undefined;
            if (!cursor) break;
          }
          if (active) {
            setJobItems(allItems);
            setJobItemsCursor(cursor ?? null);
            setJobItemsHasMore(Boolean(cursor));
          }
        } else if (active) {
          setJobItems([]);
          setJobItemsCursor(null);
          setJobItemsHasMore(false);
        }
      } catch (cause) {
        if (active && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setJobError(cause instanceof Error ? cause.message : "Nie udało się pobrać zadań rejestru.");
        }
      } finally {
        running = false;
        if (active) timer = window.setTimeout(() => void loadJobs(), 4000);
      }
    };
    void loadJobs();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); controller?.abort(); };
  }, [batchId, jobRefreshKey, selectedJobId, jobItemPages, onUnauthorized]);

  async function loadMoreJobItems() {
    if (!selectedJob || !jobItemsCursor || jobItemsLoadingMore) return;
    setJobItemsLoadingMore(true);
    setJobError("");
    try {
      const response = await fetch(`/api/enrichment-jobs/${selectedJob.id}/items?cursor=${encodeURIComponent(jobItemsCursor)}`, { credentials: "same-origin" });
      const payload = await response.json().catch(() => ({})) as { items?: EnrichmentJobItem[]; nextCursor?: string | null; message?: string };
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error(payload.message || "Nie udało się pobrać kolejnej strony zadania.");
      setJobItems((current) => [...current, ...(payload.items ?? [])]);
      setJobItemsCursor(payload.nextCursor ?? null);
      setJobItemsHasMore(Boolean(payload.nextCursor));
      setJobItemPages((current) => current + 1);
    } catch (cause) {
      setJobError(cause instanceof Error ? cause.message : "Nie udało się pobrać kolejnej strony zadania.");
    } finally {
      setJobItemsLoadingMore(false);
    }
  }

  function selectJob(jobId: string) {
    setSelectedJobId(jobId);
    setJobItemPages(1);
    storeJobSelection(batchId, jobId);
  }

  async function startEnrichmentJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = Number(fromRow);
    const end = Number(toRow);
    if (!canStart || !csrfToken || jobBusy || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 2 || end < start) return;
    setJobBusy(true);
    setJobError("");
    setJobNotice("");
    try {
      const response = await fetch(`/api/imports/${batchId}/enrichment-jobs`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), fromRow: start, toRow: end }),
      });
      const payload = await response.json().catch(() => ({})) as EnrichmentJob & { message?: string };
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error(payload.message || "Nie udało się uruchomić zadania rejestru.");
      setJobNotice(`Dodano zadanie dla ${payload.selectedCount} wierszy.`);
      selectJob(payload.id);
      setJobRefreshKey((value) => value + 1);
    } catch (cause) {
      setJobError(cause instanceof Error ? cause.message : "Nie udało się uruchomić zadania rejestru.");
    } finally {
      setJobBusy(false);
    }
  }

  async function cancelEnrichmentJob(job: EnrichmentJob) {
    if (!csrfToken || jobBusy) return;
    setJobBusy(true);
    setJobError("");
    setJobNotice("");
    try {
      const response = await fetch(`/api/enrichment-jobs/${job.id}/cancel`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: job.version }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (response.status === 401) { onUnauthorized(); return; }
      if (response.status === 409) {
        setJobNotice("Zadanie zmieniło się w innej karcie. Odświeżam zapisany stan; nie wysyłam ponownie anulowania.");
        setJobRefreshKey((value) => value + 1);
        return;
      }
      if (!response.ok) throw new Error(payload.message || "Nie udało się anulować zadania.");
      setJobNotice("Zadanie anulowano. Zapisane wyniki pozostają bez zmian.");
      setJobRefreshKey((value) => value + 1);
    } catch (cause) {
      setJobError(cause instanceof Error ? cause.message : "Nie udało się anulować zadania.");
    } finally {
      setJobBusy(false);
    }
  }

  const lookupCount = data ? Object.values(data.summary.lookupStatuses).reduce((sum, count) => sum + count, 0) : 0;
  const nextPageAvailable = Boolean(data && page * data.pageSize < data.totalRows);
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0];

  return <section className="result-section enrichment-section" aria-labelledby="enrichment-title">
    <div className="section-head"><div><p className="eyebrow">REGON / KONTROLA ŹRÓDEŁ</p><h2 id="enrichment-title">Uzupełnianie i korekty danych</h2></div><span className="result-id">Strona {page}</span></div>
    <p className="enrichment-intro">Wartość operacyjna pozostaje oddzielona od danych z importu. Propozycja korekty jest zapisywana do kontroli i sama nie zmienia REGON-u używanego przy uruchamianiu zadania.</p>
    {correctionNotice && <p className="review-conflict" role="status">{correctionNotice}</p>}
    <div className="enrichment-job-panel" aria-label="Trwałe zadania rejestru">
      <div className="section-head"><div><p className="eyebrow">ZADANIA REJESTRU</p><h3>Wzbogacanie NIP → REGON</h3><p>Wybierz zakres numerów wierszy z arkusza. Wybór nie zależy od aktualnej strony tabeli.</p></div><button className="review-button" type="button" onClick={() => setJobRefreshKey((value) => value + 1)}>Odśwież status</button></div>
      <div className="enrichment-runtime-status" data-state={runtimeHealthUnavailable || runtimeHealth?.worker === "offline" || runtimeHealth?.worker === "degraded" || runtimeHealth?.provider === "unknown" ? "warning" : runtimeHealth?.provider === "configured" ? "ready" : "disabled"} role="status" aria-live="polite">
        <strong>{runtimeHealthUnavailable ? "Status rejestru jest chwilowo niedostępny." : runtimeHealth ? runtimeStatusLabels[runtimeHealth.worker] : "Odczytuję status workera…"}</strong>
        {runtimeHealth && !runtimeHealthUnavailable && <span>Dostawca: {runtimeHealth.providerName ? providerLabels[runtimeHealth.providerName] ?? runtimeHealth.providerName : runtimeHealth.provider === "disabled" ? "wyłączony" : "status konfiguracji niedostępny"}</span>}
        {!runtimeHealthUnavailable && runtimeHealth?.providerName && providerCoverage[runtimeHealth.providerName] && <span className="enrichment-provider-coverage">{providerCoverage[runtimeHealth.providerName]}</span>}
        {runtimeHealth?.worker === "offline" || runtimeHealth?.worker === "degraded" ? <span>{runtimeHealth.message}</span> : null}
        <small>Status jest odświeżany co 15 sekund.</small>
      </div>
      {canStart && <form className="enrichment-job-form" onSubmit={(event) => void startEnrichmentJob(event)}>
        <label>Od wiersza<input type="number" min="2" step="1" value={fromRow} onChange={(event) => setFromRow(event.target.value)} required /></label>
        <label>Do wiersza<input type="number" min="2" step="1" value={toRow} onChange={(event) => setToRow(event.target.value)} required /></label>
        <button type="submit" disabled={jobBusy || !csrfToken || !fromRow || !toRow}>{jobBusy ? "Zapisywanie…" : "Dodaj zadanie"}</button>
      </form>}
      {jobError && <p className="error" role="alert">{jobError}</p>}
      {jobNotice && <p className="review-success" role="status">{jobNotice}</p>}
      {jobs.length > 1 && <nav className="enrichment-job-history" aria-label="Historia zadań rejestru">{jobs.map((job) => <button key={job.id} type="button" aria-pressed={job.id === selectedJob?.id} onClick={() => selectJob(job.id)}>{jobStatusLabels[job.status]} · {new Date(job.createdAt).toLocaleString("pl-PL")}</button>)}</nav>}
      {selectedJob && <div className="enrichment-job-state" aria-live="polite">
        <div className="section-head"><div><span className={`pill ${["completed", "partial"].includes(selectedJob.status) ? "good" : "warn"}`}>{jobStatusLabels[selectedJob.status]}</span><small className="review-subline">{new Date(selectedJob.createdAt).toLocaleString("pl-PL")}</small></div>
          {canStart && ["queued", "processing"].includes(selectedJob.status) && <button className="review-button" type="button" disabled={jobBusy} onClick={() => void cancelEnrichmentJob(selectedJob)}>Anuluj zadanie</button>}
        </div>
        <div className="review-metrics"><div><strong>{selectedJob.completedCount.toLocaleString("pl-PL")}</strong><span>sprawdzone</span></div><div><strong>{selectedJob.excludedCount.toLocaleString("pl-PL")}</strong><span>pominięte</span></div><div><strong>{selectedJob.failedCount.toLocaleString("pl-PL")}</strong><span>błędy</span></div><div><strong>{(selectedJob.selectedCount - selectedJob.completedCount - selectedJob.excludedCount - selectedJob.failedCount - selectedJob.cancelledCount).toLocaleString("pl-PL")}</strong><span>oczekujące</span></div></div>
        {selectedJob.errorCode && <p className="review-conflict">{jobReasonLabels[selectedJob.errorCode] ?? selectedJob.errorCode}</p>}
        <ul className="enrichment-job-items">{jobItems.map((item) => <li key={item.rowNumber}><span>Wiersz {item.rowNumber}</span><span>{itemStatusLabels[item.status] ?? item.status}</span>{(item.reasonCode || item.errorCode) && <small>{jobReasonLabels[item.errorCode ?? item.reasonCode!] ?? item.errorCode ?? item.reasonCode}</small>}{item.nextAttemptAt && <small>Następna próba po {new Date(item.nextAttemptAt).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}</small>}</li>)}</ul>
        {jobItemsHasMore && <div className="review-pagination"><span>Załadowano {jobItems.length.toLocaleString("pl-PL")} z {selectedJob.selectedCount.toLocaleString("pl-PL")} pozycji</span><button type="button" disabled={jobItemsLoadingMore} onClick={() => void loadMoreJobItems()}>{jobItemsLoadingMore ? "Pobieranie…" : "Pokaż następne 50"}</button></div>}
      </div>}
    </div>
    {data && <div className="review-metrics" aria-label="Postęp uzupełniania REGON">
      <div><strong>{data.summary.missingRegonRows.toLocaleString("pl-PL")}</strong><span>wierszy bez REGON-u</span></div>
      <div><strong>{data.summary.pendingCorrectionRows.toLocaleString("pl-PL")}</strong><span>oczekujących korekt</span></div>
      <div><strong>{data.summary.openConflictRows.toLocaleString("pl-PL")}</strong><span>otwartych konfliktów</span></div>
      <div><strong>{lookupCount.toLocaleString("pl-PL")}</strong><span>wierszy z wynikiem rejestru</span></div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p className="review-loading" role="status">Pobieram status i historię REGON…</p>}
    {data && !loading && <>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabela wyników; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table className="enrichment-table"><thead><tr><th>Źródło</th><th>Wiersz / firma</th><th>REGON z Excela</th><th>REGON operacyjny</th><th>Wzbogacenie i konflikty</th><th>Korekta operatora</th></tr></thead><tbody>
        {data.rows.map((row) => <tr key={row.rowNumber}>
          <td><span className={`pill ${row.source === "missing" ? "warn" : "good"}`}>{sourceLabels[row.source]}</span></td>
          <td><strong>{row.companyName}</strong><small className="review-subline">Wiersz {row.rowNumber}{row.decisionMakerName ? ` · ${row.decisionMakerName}` : ""}</small></td>
          <td className="mono">{row.regonRaw || "—"}</td>
          <td className="mono">{row.effectiveRegon || "—"}</td>
          <td><span className={`pill ${row.state === "ready" ? "good" : "warn"}`}>{stateLabels[row.state]}</span>
            {row.lookup && <small className="review-subline">{lookupLabels[row.lookup.status] ?? row.lookup.status} · {row.lookup.providerName}{row.lookup.reasonCode ? ` · ${row.lookup.reasonCode}` : ""}</small>}
            {row.conflict && <small className="review-conflict">{conflictLabels[row.conflict.reasonCode] ?? "Nierozpoznany konflikt podmiotu."} ({row.conflict.candidateCount} dopas.)</small>}
            {row.issues.map((issue) => <small className="review-subline" key={issue}>{issue}</small>)}
          </td>
          <td><CorrectionProposal row={row} batchId={batchId} csrfToken={csrfToken} onUnauthorized={onUnauthorized} onConflict={() => setCorrectionNotice("Wiersz zmienił się od czasu odczytu. Odświeżyłem dane; sprawdź nową wartość przed ponowną propozycją.")} onSubmitted={() => setRefreshKey((value) => value + 1)} /></td>
        </tr>)}
        {data.rows.length === 0 && <tr><td colSpan={6}>Ten import nie zawiera wierszy.</td></tr>}
      </tbody></table></div>
      <div className="review-pagination"><span>Strona {page} · {data.totalRows.toLocaleString("pl-PL")} wierszy w imporcie</span><div><button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Poprzednia</button><button type="button" disabled={!nextPageAvailable} onClick={() => setPage((value) => value + 1)}>Następna</button></div></div>
    </>}
  </section>;
}
