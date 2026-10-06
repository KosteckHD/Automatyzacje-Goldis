"use client";

import { useRef, useState, type FormEvent } from "react";

type PreviewItem = { rowNumber: number; state: "ready" | "review" | "excluded"; reasonCode: string | null; alreadyActive: boolean };
type Preview = {
  selectionFingerprint: string;
  referenceDate: string;
  counts: { selected: number; ready: number; needsReview: number; excluded: number; uniqueGroups: number; alreadyActive: number };
  items: PreviewItem[];
};

const reasons: Record<string, string> = {
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
