"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Preparation = {
  preparationId: string; batchId: string; revision: number; rulesVersion: string;
  sourceFingerprint: string; status: string; stage: string; totalRows: number;
  counts: { ready: number; review: number; skippedNoIdentifiers: number; duplicates: number; waitingRegistry: number };
  version: number; errorCode: string | null; createdAt: string; updatedAt: string;
  finishedAt: string | null; sealedAt: string | null;
};
type PreparationRow = {
  rowNumber: number; sourceRowId: string; expectedRowVersion: number; status: string;
  reasonCode: string | null; representativeRowNumber: number | null; normalizedName: string | null;
  normalizedNip: string | null; effectiveRegon: string | null; regonProvenance: string;
};
type PreparationPage = { preparationId: string; status: string; page: number; pageSize: number; total: number; rows: PreparationRow[] };
type PreparationWorkflow = {
  workflowId: string; batchId: string; sourcePreparationId: string; status: string; version: number;
  reanalysisPreparationId: string | null; errorCode: string | null; createdAt: string; updatedAt: string; finishedAt: string | null;
  registryJobs: Array<{ jobId: string; status: string; selectedCount: number; completedCount: number; excludedCount: number; failedCount: number; cancelledCount: number }>;
  reanalysis: { preparationId: string; revision: number; status: string; counts: Preparation["counts"] } | null;
};

const statusLabels: Record<string, string> = {
  queued: "W kolejce", processing: "Analiza danych", waiting_registry: "Oczekuje na rejestr",
  completed: "Gotowe", completed_with_attention: "Gotowe z uwagami", cancelled: "Anulowano", failed: "Niepowodzenie",
};
const rowStatusLabels: Record<string, string> = {
  pending: "Oczekuje", ready: "Gotowy", review: "Do kontroli", skipped_no_identifiers: "Pominięty — brak NIP i REGON",
  duplicate: "Duplikat — pominięty", waiting_registry: "Oczekuje na REGON", excluded: "Wyłączony",
};
const reasonLabels: Record<string, string> = {
  NO_NIP_OR_REGON: "Brak NIP-u i REGON-u — wiersz pozostaje w imporcie, ale nie trafi do automatyzacji.",
  REGON_LOOKUP_REQUIRED: "Poprawny NIP; potrzebne jest ustalenie REGON-u w rejestrze.",
  DUPLICATE_SOURCE_ROW: "Powtórzona tożsamość. Wskazany reprezentant zostanie użyty; źródłowy wiersz pozostaje zachowany.",
  IDENTITY_CONFLICT: "Te same identyfikatory wskazują sprzeczne dane firmy. Wymagana kontrola.",
  DECISION_MAKER_AMBIGUOUS: "Brak osoby kontaktowej, a firma ma kilka różnych osób. Uzupełnij osobę przed uruchomieniem.",
  PERSON_REQUIRED: "Brak osoby decyzyjnej. Wiersz zostanie pominięty; uzupełnij dane w Excelu i zaimportuj plik ponownie.",
  CORRECTION_PENDING: "Oczekuje zatwierdzenie korekty REGON.",
  GROUPING_CONFLICT: "Oczekuje rozstrzygnięcie konfliktu przypisania firmy.",
  REGON_CHECKSUM_INVALID: "REGON ma nieprawidłową sumę kontrolną.",
  NIP_CHECKSUM_INVALID: "NIP ma nieprawidłową sumę kontrolną.",
  NAME_EMPTY: "Brak nazwy firmy.",
  REGON_FORMULA_NOT_ALLOWED: "Wartość REGON pochodzi z formuły i wymaga ręcznego sprawdzenia.",
};
const terminal = new Set(["completed", "completed_with_attention", "cancelled", "failed"]);
const workflowTerminal = new Set(["completed", "completed_with_attention", "cancelled", "failed"]);
const workflowStatusLabels: Record<string, string> = {
  queued: "W kolejce", starting_registry: "Uruchamiam lookup", waiting_registry: "Uzupełniam REGON",
  starting_reanalysis: "Uruchamiam ponowną analizę", waiting_reanalysis: "Ponownie analizuję import",
  completed: "Zakończono", completed_with_attention: "Zakończono z uwagami", cancelled: "Anulowano", failed: "Niepowodzenie",
};

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || `Żądanie nie powiodło się (${response.status}).`);
  return payload;
}

export default function ImportPreparationPanel({ batchId, csrfToken, canStart, canDownload, onUnauthorized, onRunReadyChange }: {
  batchId: string; csrfToken: string; canStart: boolean; canDownload: boolean;
  onUnauthorized: () => void; onRunReadyChange: (ready: boolean) => void;
}) {
  const [preparations, setPreparations] = useState<Preparation[]>([]);
  const [workflows, setWorkflows] = useState<PreparationWorkflow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [items, setItems] = useState<PreparationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const selected = useMemo(() => preparations.find((item) => item.preparationId === selectedId) ?? null, [preparations, selectedId]);
  const newest = preparations[0] ?? null;
  const latestWorkflow = workflows[0] ?? null;
  const workflowActive = Boolean(latestWorkflow && !workflowTerminal.has(latestWorkflow.status));
  const active = Boolean((newest && ["queued", "processing", "waiting_registry"].includes(newest.status)) || workflowActive);
  const runReady = Boolean(selected && newest?.preparationId === selected.preparationId
    && selected.sealedAt && ["completed", "completed_with_attention"].includes(selected.status) && !workflowActive);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const [preparationsResponse, workflowsResponse] = await Promise.all([
      fetch(`/api/imports/${batchId}/preparations`, { credentials: "same-origin", signal }),
      fetch(`/api/imports/${batchId}/preparation-workflows`, { credentials: "same-origin", signal }),
    ]);
    if (preparationsResponse.status === 401 || workflowsResponse.status === 401) { onUnauthorized(); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
    const [preparationPayload, workflowPayload] = await Promise.all([
      readPayload<{ preparations: Preparation[] }>(preparationsResponse),
      readPayload<{ workflows: PreparationWorkflow[] }>(workflowsResponse),
    ]);
    setPreparations(preparationPayload.preparations);
    setWorkflows(workflowPayload.workflows);
    setSelectedId((current) => {
      const completedFollowUp = workflowPayload.workflows.find((workflow) => workflow.sourcePreparationId === current
        && workflow.reanalysisPreparationId)?.reanalysisPreparationId;
      if (completedFollowUp) return completedFollowUp;
      return preparationPayload.preparations.some((item) => item.preparationId === current)
        ? current : preparationPayload.preparations[0]?.preparationId ?? "";
    });
    return { preparations: preparationPayload.preparations, workflows: workflowPayload.workflows };
  }, [batchId, onUnauthorized]);

  useEffect(() => {
    onRunReadyChange(runReady);
  }, [onRunReadyChange, runReady]);

  useEffect(() => {
    let activeEffect = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller = new AbortController();
      try {
        const result = await reload(controller.signal);
        if (activeEffect && ((result.preparations[0] && !terminal.has(result.preparations[0].status))
          || result.workflows.some((workflow) => !workflowTerminal.has(workflow.status)))) {
          timer = window.setTimeout(() => void poll(), 1_500);
        }
      } catch (cause) {
        if (activeEffect && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać przygotowania.");
      } finally {
        if (activeEffect) setLoading(false);
        controller = null;
      }
    };
    setLoading(true);
    void poll();
    return () => { activeEffect = false; if (timer !== null) window.clearTimeout(timer); controller?.abort(); };
  }, [reload, refreshKey]);

  useEffect(() => {
    if (!selected || !selected.sealedAt) { setItems(null); return; }
    let activeEffect = true;
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page) });
    if (filter) query.set("state", filter);
    fetch(`/api/imports/${batchId}/preparations/${selected.preparationId}/rows?${query}`, {
      credentials: "same-origin", signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 401) { onUnauthorized(); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      return readPayload<PreparationPage>(response);
    }).then((payload) => { if (activeEffect) setItems(payload); })
      .catch((cause) => { if (activeEffect && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się wczytać wierszy."); });
    return () => { activeEffect = false; controller.abort(); };
  }, [batchId, filter, onUnauthorized, page, selected?.preparationId, selected?.sealedAt]);

  async function startPreparation() {
    if (busy || !canStart || !csrfToken) return;
    setBusy(true); setError(""); setItems(null);
    try {
      const response = await fetch(`/api/imports/${batchId}/preparations`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      if (response.status === 401) { onUnauthorized(); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      const preparation = await readPayload<Preparation>(response);
      setPreparations((current) => [preparation, ...current.filter((item) => item.preparationId !== preparation.preparationId)]
        .sort((left, right) => right.revision - left.revision));
      setSelectedId(preparation.preparationId); setPage(1); setFilter(""); setRefreshKey((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się rozpocząć przygotowania."); }
    finally { setBusy(false); }
  }

  async function cancelPreparation() {
    if (!selected || busy || !canStart || !csrfToken) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/imports/${batchId}/preparations/${selected.preparationId}/cancel`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: selected.version }),
      });
      if (response.status === 401) { onUnauthorized(); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      await readPayload<Preparation>(response);
      setRefreshKey((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się anulować przygotowania."); }
    finally { setBusy(false); }
  }

  async function startWorkflow() {
    if (!selected || busy || !canStart || !csrfToken || !selected.sealedAt || selected.counts.waitingRegistry < 1) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/imports/${batchId}/preparations/${selected.preparationId}/workflow`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      if (response.status === 401) { onUnauthorized(); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      await readPayload<PreparationWorkflow>(response);
      setRefreshKey((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się uruchomić automatyzacji importu."); }
    finally { setBusy(false); }
  }

  async function cancelWorkflow() {
    if (!latestWorkflow || busy || !canStart || !csrfToken) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/imports/${batchId}/preparation-workflows/${latestWorkflow.workflowId}/cancel`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: latestWorkflow.version }),
      });
      if (response.status === 401) { onUnauthorized(); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      await readPayload<PreparationWorkflow>(response);
      setRefreshKey((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się anulować automatyzacji."); }
    finally { setBusy(false); }
  }

  return <section className="result-section import-preparation" aria-labelledby="import-preparation-title">
    <div className="section-head">
      <div><p className="eyebrow">KONTROLA PRZED STARTEM</p><h2 id="import-preparation-title">Przygotowanie i deduplikacja</h2></div>
      {selected && <span className={`preparation-status preparation-status--${selected.status}`}>{statusLabels[selected.status] ?? selected.status}</span>}
    </div>
    <p>System analizuje cały import, sprawdza identyfikatory i wskazuje powtórzone firmy. Oryginalne wiersze pozostają w Excelu i w historii; duplikat jest pomijany wyłącznie w zestawie roboczym.</p>

    {canStart && <div className="preparation-actions">
      <button type="button" onClick={() => void startPreparation()} disabled={busy || !csrfToken || Boolean(active)}>
        {busy ? "Zapisywanie…" : active ? "Przygotowanie trwa" : newest ? "Utwórz nową rewizję przygotowania" : "Sprawdź i przygotuj import"}
      </button>
      {selected && active && canStart && <button className="preparation-secondary" type="button" onClick={() => void cancelPreparation()} disabled={busy || !csrfToken}>Anuluj przygotowanie</button>}
    </div>}
    {loading && <p className="preparation-message" role="status">Wczytuję historię przygotowań…</p>}
    {!loading && preparations.length === 0 && <p className="preparation-message">Przygotuj import, aby sprawdzić duplikaty i odblokować podgląd uruchomienia.</p>}
    {preparations.length > 1 && <div className="preparation-history" aria-label="Historia rewizji przygotowania">
      {preparations.map((item) => <button key={item.preparationId} type="button" aria-pressed={selectedId === item.preparationId}
        onClick={() => { setSelectedId(item.preparationId); setPage(1); setFilter(""); }}>
        Rewizja {item.revision} · {statusLabels[item.status] ?? item.status}
      </button>)}
    </div>}
    {selected && <>
      <dl className="preparation-counts">
        <div><dt>Gotowe</dt><dd>{selected.counts.ready.toLocaleString("pl-PL")}</dd></div>
        <div><dt>Duplikaty do pominięcia</dt><dd>{selected.counts.duplicates.toLocaleString("pl-PL")}</dd></div>
        <div><dt>Do kontroli</dt><dd>{selected.counts.review.toLocaleString("pl-PL")}</dd></div>
        <div><dt>Brak NIP i REGON</dt><dd>{selected.counts.skippedNoIdentifiers.toLocaleString("pl-PL")}</dd></div>
        <div><dt>REGON do ustalenia</dt><dd>{selected.counts.waitingRegistry.toLocaleString("pl-PL")}</dd></div>
      </dl>
      {canDownload && selected.sealedAt && <p className="preparation-message">
        <a className="download-link" href={`/api/imports/${batchId}/preparations/${selected.preparationId}/export`}>
          Pobierz Excel z zestawem roboczym i mapą decyzji · rewizja {selected.revision}
        </a>
      </p>}
      {selected.status === "failed" && <p className="preparation-message preparation-message--warning" role="alert">
        Przygotowanie nie zostało zamknięte ({selected.errorCode ?? "błąd przetwarzania"}). Sprawdź, czy dane nie zmieniły się w trakcie analizy, i uruchom nową rewizję.
      </p>}
      {selected.counts.waitingRegistry > 0 && selected.sealedAt && <p className="preparation-message preparation-message--warning">
        Część wierszy ma poprawny NIP, ale nie ma REGON-u. Możesz uruchomić pełny proces: lookup rejestru, oczekiwanie na jego wynik i ponowną analizę całego importu.
      </p>}
      {canStart && selected.sealedAt && selected.counts.waitingRegistry > 0 && selected.preparationId === newest?.preparationId && <div className="preparation-actions">
        <button type="button" onClick={() => void startWorkflow()} disabled={busy || active || !csrfToken}>
          {busy ? "Zapisywanie…" : "Uruchom lookup REGON i ponowną analizę"}
        </button>
      </div>}
      {latestWorkflow && <div className="preparation-workflow" aria-live="polite">
        <div className="section-head"><div><p className="eyebrow">AUTOMATYZACJA IMPORTU</p><strong>{workflowStatusLabels[latestWorkflow.status] ?? latestWorkflow.status}</strong></div>
          {workflowActive && canStart && <button className="preparation-secondary" type="button" onClick={() => void cancelWorkflow()} disabled={busy || !csrfToken}>Anuluj cały proces</button>}
        </div>
        {latestWorkflow.registryJobs.length > 0 && <p>Lookup: {latestWorkflow.registryJobs.reduce((sum, job) => sum + job.completedCount, 0).toLocaleString("pl-PL")} sprawdzonych z {latestWorkflow.registryJobs.reduce((sum, job) => sum + job.selectedCount, 0).toLocaleString("pl-PL")} · {latestWorkflow.registryJobs.reduce((sum, job) => sum + job.failedCount, 0).toLocaleString("pl-PL")} błędów.</p>}
        {latestWorkflow.status === "waiting_registry" && <p>Proces czeka na worker rejestru. Gdy dostawca jest wyłączony, zadania pozostają w kolejce i zostaną wznowione po jego konfiguracji.</p>}
        {latestWorkflow.reanalysis && <p>Rewizja {latestWorkflow.reanalysis.revision}: {workflowStatusLabels[latestWorkflow.reanalysis.status] ?? latestWorkflow.reanalysis.status} · gotowe {latestWorkflow.reanalysis.counts.ready} · kontrola {latestWorkflow.reanalysis.counts.review} · duplikaty {latestWorkflow.reanalysis.counts.duplicates} · nadal bez REGON {latestWorkflow.reanalysis.counts.waitingRegistry}.</p>}
        {latestWorkflow.errorCode && <p className="preparation-message preparation-message--warning" role="alert">Proces zakończył się kodem: {latestWorkflow.errorCode}. Po rozwiązaniu przyczyny można uruchomić go ponownie.</p>}
      </div>}
      {selected.counts.duplicates > 0 && selected.sealedAt && <p className="preparation-message">
        Każdy duplikat ma wskazany numer pełniejszego wiersza. Automatyzacja zachowa reprezentanta; dane źródłowe nie są kasowane.
      </p>}
      {runReady && <p className="preparation-message preparation-message--ready" role="status">
        Ta rewizja jest zamknięta. Możesz przejść do podglądu uruchomienia; wiersze do kontroli, duplikaty i rekordy bez REGON-u zostaną pominięte.
      </p>}
      {selected.sealedAt && <>
        <div className="preparation-row-tools">
          <label>Wyniki<select value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}>
            <option value="">Wszystkie</option><option value="ready">Gotowe</option><option value="duplicate">Duplikaty</option>
            <option value="review">Do kontroli</option><option value="waiting_registry">Oczekuje na REGON</option>
            <option value="skipped_no_identifiers">Brak NIP i REGON</option>
          </select></label>
          <span>{items ? `${items.total.toLocaleString("pl-PL")} wierszy · strona ${page}` : "Wczytuję wiersze…"}</span>
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Poprzednia</button>
          <button type="button" disabled={!items || page * items.pageSize >= items.total} onClick={() => setPage((value) => value + 1)}>Następna</button>
        </div>
        <div className="table-wrap preparation-table-wrap" role="region" aria-label="Wyniki przygotowania importu; przewiń poziomo, aby zobaczyć pozostałe kolumny" tabIndex={0}>
          <table><thead><tr><th>Wiersz</th><th>Firma</th><th>NIP</th><th>REGON użyty</th><th>Decyzja</th><th>Uzasadnienie</th></tr></thead>
            <tbody>{items?.rows.map((row) => <tr key={row.sourceRowId}>
              <td>{row.rowNumber}</td><td>{row.normalizedName ?? "—"}</td><td className="mono">{row.normalizedNip ?? "—"}</td>
              <td className="mono">{row.effectiveRegon ?? "—"}</td>
              <td><span className={`preparation-row-status preparation-row-status--${row.status}`}>{rowStatusLabels[row.status] ?? row.status}</span>
                {row.representativeRowNumber && <small className="preparation-representative">Reprezentant: wiersz {row.representativeRowNumber}</small>}</td>
              <td>{row.reasonCode ? reasonLabels[row.reasonCode] ?? "Wymaga dodatkowej kontroli." : "Dane przechodzą kontrolę przygotowania."}</td>
            </tr>)}
              {items?.rows.length === 0 && <tr><td colSpan={6}>Brak wierszy dla wybranego filtra.</td></tr>}
            </tbody>
          </table>
        </div>
      </>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
