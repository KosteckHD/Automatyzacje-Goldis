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

function CorrectionProposal({ row, batchId, csrfToken, onSubmitted }: {
  row: ReviewRow;
  batchId: string;
  csrfToken: string;
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

  if (row.correction?.status === "pending") return <p className="review-note">Propozycja {row.correction.proposedRegon} oczekuje na rozstrzygnięcie. Powód: {row.correction.reason}</p>;

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

export default function EnrichmentReviewPanel({ batchId, csrfToken }: { batchId: string; csrfToken: string }) {
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    fetch(`/api/imports/${batchId}/enrichment?page=${page}`, { credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as ReviewData & { message?: string };
        if (!response.ok) throw new Error(payload.message || "Nie udało się pobrać statusu REGON.");
        if (active) setData(payload);
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać statusu REGON."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [batchId, page, refreshKey]);

  const lookupCount = data ? Object.values(data.summary.lookupStatuses).reduce((sum, count) => sum + count, 0) : 0;
  const nextPageAvailable = Boolean(data && page * data.pageSize < data.totalRows);

  return <section className="result-section enrichment-section" aria-labelledby="enrichment-title">
    <div className="section-head"><div><p className="eyebrow">REGON / KONTROLA ŹRÓDEŁ</p><h2 id="enrichment-title">Uzupełnianie i korekty danych</h2></div><span className="result-id">Strona {page}</span></div>
    <p className="enrichment-intro">Wartość operacyjna pozostaje oddzielona od danych z importu. Propozycja korekty jest zapisywana do kontroli i sama nie zmienia REGON-u używanego przy uruchamianiu zadania.</p>
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
          <td><CorrectionProposal row={row} batchId={batchId} csrfToken={csrfToken} onSubmitted={() => setRefreshKey((value) => value + 1)} /></td>
        </tr>)}
        {data.rows.length === 0 && <tr><td colSpan={6}>Ten import nie zawiera wierszy.</td></tr>}
      </tbody></table></div>
      <div className="review-pagination"><span>Strona {page} · {data.totalRows.toLocaleString("pl-PL")} wierszy w imporcie</span><div><button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Poprzednia</button><button type="button" disabled={!nextPageAvailable} onClick={() => setPage((value) => value + 1)}>Następna</button></div></div>
    </>}
  </section>;
}
