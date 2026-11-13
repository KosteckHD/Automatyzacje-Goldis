"use client";

import { useEffect, useState } from "react";

type PreparedCompany = {
  rowNumber: number;
  sourceRowId: string;
  status: string;
  reasonCode: string | null;
  representativeRowNumber: number | null;
  companyName: string | null;
  normalizedName: string | null;
  normalizedNip: string | null;
  effectiveRegon: string | null;
};
type PreparedCompanyPage = { page: number; pageSize: number; total: number; search: string; rows: PreparedCompany[] };

const statusLabels: Record<string, string> = {
  ready: "Gotowa do sprawdzenia",
  review: "Wymaga kontroli",
  duplicate: "Duplikat",
  skipped_no_identifiers: "Brak NIP i REGON",
  waiting_registry: "Oczekuje na REGON",
  excluded: "Pominięta",
  pending: "W przygotowaniu",
};

const reasonLabels: Record<string, string> = {
  DUPLICATE_SOURCE_ROW: "Zostanie użyty wskazany wiersz reprezentujący firmę.",
  NO_NIP_OR_REGON: "Uzupełnij NIP lub REGON przed sprawdzeniem.",
  REGON_LOOKUP_REQUIRED: "Należy najpierw ustalić REGON w rejestrze.",
  IDENTITY_CONFLICT: "Dane identyfikacyjne wymagają kontroli.",
  GROUPING_CONFLICT: "Powiązanie firmy wymaga decyzji.",
};

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || `Żądanie nie powiodło się (${response.status}).`);
  return payload;
}

export default function CompanySelection({ batchId, preparationId, selectedRows, onChange, onUnauthorized, readOnly = false }: {
  batchId: string;
  preparationId?: string;
  selectedRows: number[];
  onChange: (rows: number[]) => void;
  onUnauthorized: () => void;
  readOnly?: boolean;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [retryVersion, setRetryVersion] = useState(0);
  const [result, setResult] = useState<PreparedCompanyPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectionError, setSelectionError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextSearch = searchInput.trim().slice(0, 120);
      setPageNumber(1);
      setSearch(nextSearch);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!preparationId) { setResult(null); return; }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ page: String(pageNumber) });
    if (search) query.set("q", search);
    fetch(`/api/imports/${batchId}/preparations/${preparationId}/rows?${query}`, {
      credentials: "same-origin", signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 401) { onUnauthorized(); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      return readPayload<PreparedCompanyPage>(response);
    }).then((payload) => { if (!controller.signal.aborted) setResult(payload); })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się wyszukać firm.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [batchId, onUnauthorized, pageNumber, preparationId, retryVersion, search]);

  function toggle(rowNumber: number, checked: boolean) {
    setSelectionError("");
    const next = checked
      ? [...new Set([...selectedRows, rowNumber])].sort((left, right) => left - right)
      : selectedRows.filter((row) => row !== rowNumber);
    if (next.length > 500) { setSelectionError("Można wybrać maksymalnie 500 firm. Użyj „Wszystkie gotowe firmy” dla większego zakresu."); return; }
    onChange(next);
  }

  function togglePage(checked: boolean) {
    if (!result) return;
    const visible = result.rows.map((row) => row.rowNumber);
    const next = checked
      ? [...new Set([...selectedRows, ...visible])].sort((left, right) => left - right)
      : selectedRows.filter((row) => !visible.includes(row));
    if (next.length > 500) { setSelectionError("Ta strona przekroczyłaby limit 500 firm. Usuń część zaznaczeń lub wybierz mniejszy zakres."); return; }
    setSelectionError(""); onChange(next);
  }

  const visibleRows = result?.rows ?? [];
  const selectedVisible = visibleRows.filter((row) => selectedRows.includes(row.rowNumber)).length;
  const pageCount = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return <section className={`company-selection${readOnly ? " is-read-only" : ""}`} aria-labelledby="company-selection-title">
    <div className="company-selection-heading"><div><h3 id="company-selection-title">{readOnly ? "Firmy w przygotowanej rewizji" : "Wybrane firmy"}</h3><p>{readOnly ? "Lista tylko do odczytu. Podsumowanie powyżej rozdziela firmy gotowe od wierszy wymagających kontroli." : "Wyszukuj w przygotowanej rewizji. Zaznaczenia zachowują się przy przejściu między stronami."}</p></div>
      <strong aria-live="polite">{readOnly ? (result ? `${result.total.toLocaleString("pl-PL")} firm` : "Paginowany podgląd") : `${selectedRows.length} / 500 wybranych`}</strong></div>
    {!preparationId ? <p className="submission-notice">Zakończ przygotowanie importu, aby wybierać firmy z aktualnej rewizji.</p> : <>
      <label className="company-selection-search">{readOnly ? "Szukaj w przygotowanej rewizji" : "Szukaj po nazwie, NIP, REGON lub numerze wiersza"}
        <input type="search" name="company-search" autoComplete="off" value={searchInput} maxLength={120} onChange={(event) => {
          setSearchInput(event.target.value); setResult(null); setLoading(true); setPageNumber(1); setError("");
        }} placeholder="np. Alfa, NIP 1234567890…" />
      </label>
      {error && <div className="company-selection-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetryVersion((value) => value + 1)}>Spróbuj ponownie</button></div>}
      {!readOnly && selectionError && <p className="error" role="alert">{selectionError}</p>}
      {result && <div className="company-selection-toolbar"><span>{loading ? "Odświeżam listę…" : `${result.total.toLocaleString("pl-PL")} firm pasuje do wyszukiwania`}</span>
        {!readOnly && <label><input type="checkbox" checked={visibleRows.length > 0 && selectedVisible === visibleRows.length} onChange={(event) => togglePage(event.target.checked)} /> Zaznacz firmy na tej stronie ({visibleRows.length})</label>}
      </div>}
      {loading && !result && <p role="status">Wczytuję firmy przygotowanej rewizji…</p>}
      {!loading && !error && result?.total === 0 && <p className="submission-notice">Nie znaleziono firm. Zmień frazę albo sprawdź stan przygotowania.</p>}
      {result && result.rows.length > 0 && <ul className="company-selection-list" aria-label={readOnly ? "Firmy w przygotowanej rewizji" : "Firmy z przygotowanej rewizji"}>
        {result.rows.map((row) => <li key={row.sourceRowId}>
          <label className={`company-selection-row${readOnly ? " is-read-only" : ""}`}>
            {!readOnly && <input type="checkbox" aria-label={`Wybierz firmę ${row.companyName || row.normalizedName || "bez nazwy"}, wiersz ${row.rowNumber}`} checked={selectedRows.includes(row.rowNumber)} onChange={(event) => toggle(row.rowNumber, event.target.checked)} />}
            <span className="company-selection-copy"><strong>{row.companyName || row.normalizedName || "Firma bez nazwy"}</strong>
              <span>NIP: {row.normalizedNip || "—"} · REGON: {row.effectiveRegon || "—"} · wiersz {row.rowNumber}</span>
              <small>{statusLabels[row.status] ?? "Stan wymaga sprawdzenia"}{row.reasonCode ? ` · ${reasonLabels[row.reasonCode] ?? "Wiersz może wymagać kontroli w podsumowaniu."}` : row.representativeRowNumber ? ` · reprezentuje wiersz ${row.representativeRowNumber}` : ""}</small>
            </span>
          </label>
        </li>)}
      </ul>}
      {result && <nav className="company-selection-pages" aria-label={readOnly ? "Strony firm w rewizji" : "Strony firm"}>
        <button type="button" onClick={() => setPageNumber((value) => Math.max(1, value - 1))} disabled={pageNumber <= 1 || loading}>Poprzednia</button>
        <span>Strona {pageNumber} z {pageCount}</span>
        <button type="button" onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))} disabled={pageNumber >= pageCount || loading}>Następna</button>
      </nav>}
    </>}
  </section>;
}
