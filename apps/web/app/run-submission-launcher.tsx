"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type PreviewItem = { rowNumber: number; state: "ready" | "review" | "excluded"; reasonCode: string | null; alreadyActive: boolean };
type Preview = {
  selectionFingerprint: string;
  referenceDate: string;
  counts: { selected: number; ready: number; needsReview: number; excluded: number; uniqueGroups: number; alreadyActive: number };
  items: PreviewItem[];
};
type WholePreview = {
  preparationId: string;
  revision: number;
  snapshotFingerprint: string;
  totalRows: number;
  referenceDate: string;
  counts: { ready: number; review: number; duplicates: number; skippedNoIdentifiers: number; waitingRegistry: number };
};
type WholeExecution = {
  executionId: string;
  status: "queued" | "running" | "waiting_attention" | "pause_requested" | "paused" | "completed" | "cancelled" | "failed";
  version: number;
  referenceDate: string;
  totalRows: number;
  chunkCount: number;
  progress: { generatedChunks: number; completedChunks: number; activeChunks: number; waitingChunks: number; failedChunks: number; cancelledChunks: number };
  chunks?: { ordinal: number; firstRowNumber: number; lastRowNumber: number; rowCount: number;
    status: string; childSubmissionId: string | null; finishedAt: string | null }[];
  chunkPage?: { nextAfterOrdinal: number | null };
  errorCode: string | null;
};

const reasons: Record<string, string> = {
  DUPLICATE_SOURCE_ROW: "duplikat — pominięty w zestawie roboczym; źródłowy import pozostaje zachowany",
  PENDING_REGON_CORRECTION: "oczekuje korekta REGON",
  OPEN_ENTITY_CONFLICT: "otwarty konflikt grupowania",
  REGON_REQUIRED: "brak REGON-u",
  SOURCE_ROW_HAS_ISSUES: "wiersz ma błędy walidacji",
  INVALID_NIP: "nieprawidłowy NIP",
  INVALID_REGON: "nieprawidłowy REGON",
  SAME_NIP_DIFFERENT_REGON: "NIP wskazuje różne numery REGON",
  SAME_REGON_DIFFERENT_NIP: "REGON wskazuje różne numery NIP",
  NAME_MISMATCH: "nazwa firmy wymaga sprawdzenia",
  SOURCE_LINK_MISMATCH: "powiązanie firmy wymaga sprawdzenia",
  ACTIVE_RUN_REFERENCE_DATE_MISMATCH: "aktywne zadanie ma inną datę odniesienia",
};
const chunkStatusLabels: Record<string, string> = {
  queued: "w kolejce", submitting: "przekazywana", running: "w toku", waiting_attention: "wymaga uwagi",
  completed: "zakończona", cancelled: "anulowana", failed: "błąd",
};

function parseRows(value: string): number[] {
  const tokens = value.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 500 || tokens.some((token) => !/^\d+$/.test(token))) {
    throw new Error("Wpisz od 1 do 500 numerów wierszy, oddzielonych przecinkami lub spacjami.");
  }
  const rows = tokens.map(Number);
  if (rows.some((row) => !Number.isSafeInteger(row) || row < 2) || new Set(rows).size !== rows.length) {
    throw new Error("Numery muszą być różne i zaczynać się od 2 (pierwszy wiersz danych w Excelu).");
  }
  return rows.sort((a, b) => a - b);
}

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || `Żądanie nie powiodło się (${response.status}).`);
  return payload;
}

export default function RunSubmissionLauncher({ batchId, csrfToken }: { batchId: string; csrfToken: string }) {
  const [mode, setMode] = useState<"range" | "list">("range");
  const [fromRow, setFromRow] = useState("");
  const [toRow, setToRow] = useState("");
  const [rowList, setRowList] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const idempotencyKey = useRef("");
  const wholeIdempotencyKey = useRef("");
  const [wholePreview, setWholePreview] = useState<WholePreview | null>(null);
  const [wholeExecution, setWholeExecution] = useState<WholeExecution | null>(null);
  const [chunkAfterOrdinal, setChunkAfterOrdinal] = useState(0);
  const [wholeConfirmed, setWholeConfirmed] = useState(false);
  const [wholeBusy, setWholeBusy] = useState(false);
  const [wholeError, setWholeError] = useState("");
  const [wholeNotice, setWholeNotice] = useState("");

  useEffect(() => {
    if (!wholeExecution || ["paused", "completed", "cancelled", "failed"].includes(wholeExecution.status)) return;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const cursor = chunkAfterOrdinal > 0 ? `?afterOrdinal=${chunkAfterOrdinal}` : "";
        const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/${wholeExecution.executionId}${cursor}`, { credentials: "same-origin" });
        const current = await readPayload<WholeExecution>(response);
        if (!stopped) { setWholeExecution(current); setWholeError(""); }
      } catch (cause) {
        if (!stopped) setWholeError(cause instanceof Error ? cause.message : "Nie udało się odświeżyć stanu całego importu.");
      } finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [batchId, wholeExecution?.executionId, wholeExecution?.status, chunkAfterOrdinal]);

  async function previewWholeImport() {
    if (wholeBusy) return;
    setWholeBusy(true); setWholeError(""); setWholeNotice(""); setWholePreview(null); setWholeConfirmed(false);
    try {
      const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/preview`, { credentials: "same-origin" });
      setWholePreview(await readPayload<WholePreview>(response));
      wholeIdempotencyKey.current = "";
      setWholeNotice("Podgląd obejmuje całą najnowszą, zakończoną rewizję przygotowania. Żadne zadanie nie zostało jeszcze uruchomione.");
    } catch (cause) { setWholeError(cause instanceof Error ? cause.message : "Nie udało się przygotować podglądu całego importu."); }
    finally { setWholeBusy(false); }
  }

  async function startWholeImport() {
    if (!wholePreview || !wholeConfirmed || wholeBusy) return;
    setWholeBusy(true); setWholeError(""); setWholeNotice("");
    try {
      if (!csrfToken) throw new Error("Brak tokenu bezpieczeństwa sesji. Odśwież stronę.");
      if (!wholeIdempotencyKey.current) wholeIdempotencyKey.current = crypto.randomUUID();
      const response = await fetch(`/api/imports/${batchId}/prepared-set-executions`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ idempotencyKey: wholeIdempotencyKey.current,
          preparationId: wholePreview.preparationId, snapshotFingerprint: wholePreview.snapshotFingerprint }),
      });
      setWholeExecution(await readPayload<WholeExecution>(response));
      setChunkAfterOrdinal(0);
      setWholePreview(null); setWholeConfirmed(false);
      setWholeNotice("Cały zestaw zapisano. Postęp aktualizuje się automatycznie; ponowienie żądania nie tworzy drugiego zestawu.");
    } catch (cause) { setWholeError(cause instanceof Error ? cause.message : "Nie udało się uruchomić całego importu."); }
    finally { setWholeBusy(false); }
  }

  async function cancelWholeImport() {
    if (!wholeExecution || wholeBusy || !csrfToken) return;
    setWholeBusy(true); setWholeError("");
    try {
      const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/${wholeExecution.executionId}/cancel`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: wholeExecution.version }),
      });
      setWholeExecution(await readPayload<WholeExecution>(response));
      setChunkAfterOrdinal(0);
    } catch (cause) { setWholeError(cause instanceof Error ? cause.message : "Nie udało się anulować całego importu."); }
    finally { setWholeBusy(false); }
  }

  async function setWholeImportControl(action: "pause" | "resume") {
    if (!wholeExecution || wholeBusy || !csrfToken) return;
    setWholeBusy(true); setWholeError("");
    try {
      const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/${wholeExecution.executionId}/${action}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: wholeExecution.version }),
      });
      setWholeExecution(await readPayload<WholeExecution>(response));
      setChunkAfterOrdinal(0);
    } catch (cause) { setWholeError(cause instanceof Error ? cause.message : action === "pause" ? "Nie udało się wstrzymać całego importu." : "Nie udało się wznowić całego importu."); }
    finally { setWholeBusy(false); }
  }

  const wholeExecutionTerminal = wholeExecution && ["completed", "cancelled", "failed"].includes(wholeExecution.status);

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setPreview(null); setConfirmed(false); idempotencyKey.current = "";
    try {
      if (!csrfToken) throw new Error("Brak tokenu bezpieczeństwa sesji. Odśwież stronę.");
      const selection = mode === "range"
        ? { fromRow: Number(fromRow), toRow: Number(toRow) }
        : { rowNumbers: parseRows(rowList) };
      const response = await fetch(`/api/imports/${batchId}/run-submissions/preview`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(selection),
      });
      setPreview(await readPayload<Preview>(response));
      setNotice("Podgląd jest aktualny. Zgłoszenie nie uruchamia jeszcze zadań.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się przygotować podglądu."); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!preview || !confirmed || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (!csrfToken) throw new Error("Brak tokenu bezpieczeństwa sesji. Odśwież stronę.");
      const selection = mode === "range"
        ? { fromRow: Number(fromRow), toRow: Number(toRow) }
        : { rowNumbers: parseRows(rowList) };
      if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
      const response = await fetch(`/api/imports/${batchId}/run-submissions`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ ...selection, selectionFingerprint: preview.selectionFingerprint, idempotencyKey: idempotencyKey.current }),
      });
      const created = await readPayload<{ submissionId: string }>(response);
      window.location.assign(`/submissions/${created.submissionId}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zapisać zgłoszenia."); }
    finally { setBusy(false); }
  }

  return <section className="result-section submission-launcher" aria-labelledby="submission-launch-title">
    <div className="section-head"><div><p className="eyebrow">URUCHOMIENIE PARTII</p><h2 id="submission-launch-title">Sprawdź wiele wierszy</h2></div></div>
    <p>Najpierw zobaczysz, które wiersze są gotowe, wymagają kontroli lub zostaną pominięte. Zadania powstaną dopiero po osobnym potwierdzeniu.</p>
    <div className="prepared-set-control" aria-labelledby="prepared-set-title">
      <div><h3 id="prepared-set-title">Uruchom cały przygotowany import</h3>
        <p>System użyje najnowszej zakończonej rewizji, zachowa rozliczenie duplikatów i podzieli wszystkie wiersze na porcje do 500. Przed startem pokaże podsumowanie gotowości. Pauza czeka na bezpieczny koniec przyjętej porcji; anulowanie kończy dalsze porcje.</p></div>
      {(!wholeExecution || wholeExecutionTerminal) && <button className="submission-primary" type="button" onClick={() => void previewWholeImport()} disabled={wholeBusy || !csrfToken}>
        {wholeBusy ? "Sprawdzam przygotowanie…" : wholeExecution ? "Przygotuj nowe wykonanie" : "Pokaż podsumowanie całego importu"}
      </button>}
      {wholeError && <p className="error" role="alert">{wholeError}</p>}
      {wholeNotice && !wholeError && <p className="submission-notice" role="status">{wholeNotice}</p>}
      {wholePreview && <div className="prepared-set-preview">
        <h4>Rewizja {wholePreview.revision} · data {wholePreview.referenceDate}</h4>
        <dl className="submission-counts">
          <div><dt>Wszystkie wiersze</dt><dd>{wholePreview.totalRows}</dd></div>
          <div><dt>Gotowe do sprawdzenia</dt><dd>{wholePreview.counts.ready}</dd></div>
          <div><dt>Do kontroli</dt><dd>{wholePreview.counts.review}</dd></div>
          <div><dt>Duplikaty</dt><dd>{wholePreview.counts.duplicates}</dd></div>
          <div><dt>Bez NIP i REGON</dt><dd>{wholePreview.counts.skippedNoIdentifiers}</dd></div>
          <div><dt>Oczekuje REGON</dt><dd>{wholePreview.counts.waitingRegistry}</dd></div>
        </dl>
        {wholePreview.counts.ready > 0 ? <>
          <label className="submission-confirm"><input type="checkbox" checked={wholeConfirmed} onChange={(event) => setWholeConfirmed(event.target.checked)} />Potwierdzam uruchomienie wszystkich {wholePreview.counts.ready} gotowych wierszy z tej rewizji.</label>
          <button className="submission-primary" type="button" onClick={() => void startWholeImport()} disabled={wholeBusy || !wholeConfirmed}>
            {wholeBusy ? "Zapisuję zestaw…" : "Potwierdź i uruchom cały import"}
          </button>
        </> : <p className="submission-notice">Nie ma gotowych wierszy. Rozstrzygnij problemy lub uzupełnij REGON, a potem przygotuj nową rewizję.</p>}
      </div>}
      {wholeExecution && <div className="prepared-set-progress" aria-live="polite">
        <div className="prepared-set-progress-head"><h4>Cały import · {wholeExecution.status === "queued" ? "w kolejce" : wholeExecution.status === "running" ? "w toku" : wholeExecution.status === "waiting_attention" ? "wymaga uwagi" : wholeExecution.status === "pause_requested" ? "wstrzymywanie" : wholeExecution.status === "paused" ? "wstrzymany" : wholeExecution.status === "completed" ? "zakończony" : wholeExecution.status === "cancelled" ? "anulowany" : "błąd"}</h4>
          {wholeExecution.status !== "paused" && wholeExecution.status !== "pause_requested" && wholeExecution.status !== "completed" && wholeExecution.status !== "cancelled" && wholeExecution.status !== "failed" && <button type="button" onClick={() => void setWholeImportControl("pause")} disabled={wholeBusy || !csrfToken}>Wstrzymaj po bieżącej porcji</button>}
          {wholeExecution.status === "paused" && <button type="button" onClick={() => void setWholeImportControl("resume")} disabled={wholeBusy || !csrfToken}>Wznów import</button>}
          {!(["completed", "cancelled", "failed"].includes(wholeExecution.status)) && <button type="button" onClick={() => void cancelWholeImport()} disabled={wholeBusy || !csrfToken}>Anuluj cały zestaw</button>}
        </div>
        <p>{wholeExecution.progress.completedChunks} z {wholeExecution.chunkCount || "…"} porcji zakończonych; {wholeExecution.progress.generatedChunks} utworzonych, {wholeExecution.totalRows} wierszy w zestawie.</p>
        {wholeExecution.status === "pause_requested" && <p className="submission-notice">Nowe porcje nie będą uruchamiane. Bieżąca porcja dojdzie do bezpiecznego punktu; zewnętrznych działań już wysłanych nie można cofnąć.</p>}
        {wholeExecution.status === "paused" && <p className="submission-notice">Wykonanie jest wstrzymane. Wznowienie kontynuuje od zapisanej porcji i nie tworzy drugiego zestawu.</p>}
        {wholeExecution.status === "waiting_attention" && <p className="submission-notice">System wstrzymał kolejne porcje do czasu rozwiązania problemu: {wholeExecution.errorCode ?? "wymagana kontrola"}.</p>}
        {!!wholeExecution.chunks?.length && <div className="prepared-set-chunks" aria-label="Porcje wykonania">
          <ul>{wholeExecution.chunks.map((chunk) => <li key={chunk.ordinal}><strong>Porcja {chunk.ordinal}</strong>
            <span>wiersze {chunk.firstRowNumber}–{chunk.lastRowNumber} · {chunk.rowCount} rekordów</span>
            <small>{chunkStatusLabels[chunk.status] ?? "stan nieznany"}</small></li>)}</ul>
          <div>
            {chunkAfterOrdinal > 0 && <button type="button" onClick={() => setChunkAfterOrdinal(0)}>Pokaż pierwsze porcje</button>}
            {wholeExecution.chunkPage?.nextAfterOrdinal !== null && wholeExecution.chunkPage?.nextAfterOrdinal !== undefined
              && <button type="button" onClick={() => setChunkAfterOrdinal(wholeExecution.chunkPage!.nextAfterOrdinal!)}>Pokaż kolejne porcje</button>}
          </div>
        </div>}
        {wholeExecution.errorCode === "PREPARATION_CHANGED" && <p className="error" role="alert">Dane zmieniły się po przygotowaniu. Utwórz nową rewizję i uruchom ją ponownie.</p>}
      </div>}
    </div>
    <form className="submission-selection" onSubmit={requestPreview}>
      <div className="submission-mode" role="group" aria-label="Sposób wyboru wierszy">
        <button type="button" aria-pressed={mode === "range"} onClick={() => { setMode("range"); setPreview(null); setConfirmed(false); }}>Zakres</button>
        <button type="button" aria-pressed={mode === "list"} onClick={() => { setMode("list"); setPreview(null); setConfirmed(false); }}>Lista numerów</button>
      </div>
      {mode === "range" ? <div className="submission-fields">
        <label>Od wiersza (zakres partii)<input type="number" min="2" max="100000000" step="1" value={fromRow} onChange={(event) => { setFromRow(event.target.value); setPreview(null); setConfirmed(false); }} required /></label>
        <label>Do wiersza (zakres partii)<input type="number" min="2" max="100000000" step="1" value={toRow} onChange={(event) => { setToRow(event.target.value); setPreview(null); setConfirmed(false); }} required /></label>
      </div> : <label className="submission-row-list">Numery wierszy z Excela<textarea rows={3} value={rowList} onChange={(event) => { setRowList(event.target.value); setPreview(null); setConfirmed(false); }} placeholder="np. 2, 4, 8–10 wpisz jako 8, 9, 10" aria-describedby="submission-list-help" required /></label>}
      {mode === "list" && <small id="submission-list-help">Oddziel numery przecinkiem, średnikiem lub spacją; maksymalnie 500 wierszy.</small>}
      <button type="submit" disabled={busy || !csrfToken}>{busy ? "Przygotowuję podgląd…" : "Pokaż podsumowanie"}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && !error && <p className="submission-notice" role="status">{notice}</p>}
    {preview && <div className="submission-preview" aria-labelledby="submission-preview-title">
      <h3 id="submission-preview-title">Podsumowanie · data {preview.referenceDate}</h3>
      <dl className="submission-counts"><div><dt>Wybrane</dt><dd>{preview.counts.selected}</dd></div><div><dt>Gotowe</dt><dd>{preview.counts.ready}</dd></div><div><dt>Do kontroli</dt><dd>{preview.counts.needsReview}</dd></div><div><dt>Pominięte</dt><dd>{preview.counts.excluded}</dd></div><div><dt>Osobne zadania</dt><dd>{preview.counts.uniqueGroups}</dd></div><div><dt>Już aktywne</dt><dd>{preview.counts.alreadyActive}</dd></div></dl>
      <div className="submission-preview-list" role="region" aria-label="Wiersze w podsumowaniu" tabIndex={0}><ul>{preview.items.map((item) => <li key={item.rowNumber}>
        <strong>Wiersz {item.rowNumber}</strong><span className={`submission-state submission-state--${item.state}`}>{item.state === "ready" ? "Gotowy" : item.state === "review" ? "Do kontroli" : "Pominięty"}</span>
        <small>{item.reasonCode ? reasons[item.reasonCode] ?? "wymaga dodatkowej kontroli" : item.alreadyActive ? "zadanie dla tego wiersza już działa" : "może zostać dodany do zadania"}</small>
      </li>)}</ul></div>
      {preview.counts.ready > 0 && <label className="submission-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Rozumiem podsumowanie i potwierdzam utworzenie maksymalnie {preview.counts.uniqueGroups} zadań.</label>}
      {preview.counts.ready === 0 && <p className="submission-notice">Brak gotowych wierszy. Rozstrzygnij wskazane problemy i przygotuj nowy podgląd.</p>}
      <button className="submission-primary" type="button" onClick={() => void submit()} disabled={busy || !confirmed || preview.counts.ready === 0}>{busy ? "Zapisuję zgłoszenie…" : "Potwierdź i uruchom gotowe wiersze"}</button>
    </div>}
  </section>;
}
