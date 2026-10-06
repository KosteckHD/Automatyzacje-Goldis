"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GoldisLogo } from "../../components/brand/GoldisLogo";

type Role = "admin" | "operator" | "reviewer" | "auditor";
type Session = { role: Role; username: string; csrfToken: string; mustChangePassword?: boolean };
type Correction = {
  id: string; status: "pending" | "approved" | "rejected"; createdAt: string; previousRegon: string | null;
  proposedRegon: string; reason: string; rowNumber: number; rowVersion: number; companyName: string; batchId: string; toolId: string;
};
type Candidate = { id: string; businessName: string; regon: string | null };
type Conflict = {
  id: string; status: "open" | "resolved"; createdAt: string; reasonCode: string; rowNumber: number; rowVersion: number;
  companyName: string; effectiveRegon: string | null; batchId: string; toolId: string; candidates: Candidate[];
};
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean; limit: number };
type Tab = "corrections" | "conflicts";
type QueueFilters = { status: string; batchId: string; toolId: string; cursor: string | null };

const roles: Record<Role, string> = { admin: "Administrator", operator: "Operator", reviewer: "Reviewer", auditor: "Auditor" };
const conflictLabels: Record<string, string> = {
  INVALID_NIP: "Nieprawidłowy NIP", INVALID_REGON: "Nieprawidłowy REGON", IDENTIFIER_MISSING: "Brak poprawnego identyfikatora",
  SOURCE_NAME_MISSING: "Brak nazwy firmy", CANONICAL_IDENTITY_INVALID: "Nieprawidłowa tożsamość encji",
  SAME_NIP_DIFFERENT_REGON: "Ten sam NIP, różny REGON", SAME_REGON_DIFFERENT_NIP: "Ten sam REGON, różny NIP",
  NAME_MISMATCH: "Identyfikator pasuje, nazwa jest inna", MULTIPLE_CANONICAL_MATCHES: "Wiele pasujących encji",
  SOURCE_LINK_MISMATCH: "Powiązanie źródła wymaga kontroli",
};
const correctionReasonLabels: Record<string, string> = {
  SOURCE_DOCUMENT_VERIFIED: "Dokument źródłowy sprawdzony",
  REGISTRY_MATCH_VERIFIED: "Zgodność z rejestrem potwierdzona",
  DUPLICATE_IMPORT: "Duplikat w imporcie rozstrzygnięty",
  OTHER: "Inny udokumentowany powód",
};

function filtersFromUrl(): { tab: Tab; filters: QueueFilters } {
  const params = new URLSearchParams(window.location.search);
  return {
    tab: params.get("tab") === "conflicts" ? "conflicts" : "corrections",
    filters: { status: params.get("status") ?? "", batchId: params.get("batchId") ?? "", toolId: params.get("toolId") ?? "", cursor: params.get("cursor") },
  };
}

function writeUrl(tab: Tab, filters: QueueFilters, replace = false) {
  const params = new URLSearchParams();
  params.set("tab", tab);
  for (const [key, value] of Object.entries(filters)) if (value && key !== "cursor") params.set(key, value);
  if (filters.cursor) params.set("cursor", filters.cursor);
  window.history[replace ? "replaceState" : "pushState"]({ goldisReview: true }, "", `${window.location.pathname}?${params.toString()}`);
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) {
    const message = response.status === 409
      ? "Wiersz zmienił się od czasu otwarcia kolejki. Odśwież kolejkę, porównaj dane i podejmij decyzję ponownie."
      : response.status === 503 ? "Usługa jest chwilowo niedostępna. Spróbuj później."
        : response.status === 404 ? "Zasób jest niedostępny w bieżącym zakresie uprawnień."
          : payload.message || `Operacja nie powiodła się (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload;
}

export default function ReviewPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [tab, setTab] = useState<Tab>("corrections");
  const [filters, setFilters] = useState<QueueFilters>({ status: "", batchId: "", toolId: "", cursor: null });
  const [draft, setDraft] = useState<QueueFilters>({ status: "", batchId: "", toolId: "", cursor: null });
  const [page, setPage] = useState<Page<Correction | Conflict> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [actionId, setActionId] = useState("");
  const [reasonCode, setReasonCode] = useState("REGISTRY_MATCH_VERIFIED");
  const [candidateId, setCandidateId] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const initial = filtersFromUrl();
    setTab(initial.tab); setFilters(initial.filters); setDraft(initial.filters);
    writeUrl(initial.tab, initial.filters, true);
    const abort = new AbortController();
    fetch("/api/auth/me", { credentials: "same-origin", signal: abort.signal }).then((response) => jsonResponse<Session>(response))
      .then((value) => { setSession(value); setSessionState("ready"); })
      .catch((cause) => { if (!abort.signal.aborted) setSessionState((cause as { status?: number }).status === 401 ? "signed-out" : "error"); });
    const onPopState = () => {
      const restored = filtersFromUrl(); setTab(restored.tab); setFilters(restored.filters); setDraft(restored.filters);
    };
    window.addEventListener("popstate", onPopState);
    return () => { abort.abort(); window.removeEventListener("popstate", onPopState); };
  }, []);

  const allowedToDecide = session?.role === "admin" || session?.role === "reviewer";
  const endpoint = session?.role === "operator" ? "/api/review/my-corrections"
    : tab === "corrections" ? "/api/review/corrections" : "/api/review/conflicts";
  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value && key !== "cursor") params.set(key, value);
    if (filters.cursor) params.set("cursor", filters.cursor);
    params.set("limit", "50");
    return params.toString();
  }, [filters]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (sessionState !== "ready" || !session || session.role === "auditor") return;
    setLoading(true); setError("");
    try {
      const payload = await jsonResponse<Page<Correction | Conflict>>(await fetch(`${endpoint}?${query}`, {
        credentials: "same-origin", signal,
      }));
      setPage(payload);
    } catch (cause) {
      if (!signal?.aborted) {
        setError(cause instanceof Error ? cause.message : "Nie udało się pobrać kolejki.");
        if ((cause as { status?: number }).status !== 409) setPage(null);
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [endpoint, query, session, sessionState]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, revision]);

  function changeTab(next: Tab) {
    const nextFilters = { ...filters, status: "", cursor: null };
    setTab(next); setFilters(nextFilters); setDraft(nextFilters); setPage(null); setActionId(""); writeUrl(next, nextFilters);
  }

  function applyFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = { ...draft, cursor: null };
    setFilters(next); setPage(null); setActionId(""); writeUrl(tab, next);
  }

  function nextPage() {
    if (!page?.nextCursor) return;
    const next = { ...filters, cursor: page.nextCursor };
    setFilters(next); writeUrl(tab, next);
  }

  async function submitDecision(id: string, route: string, body: unknown) {
    if (!session?.csrfToken || busyId) return;
    setBusyId(id); setError(""); setNotice("");
    try {
      const result = await jsonResponse<{ decision?: string }>(await fetch(`/api/review/${route}/${id}/${route === "corrections" ? "decision" : "resolution"}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify(body),
      }));
      setNotice(result.decision === "approved" ? "Korekta zatwierdzona. REGON operacyjny został zaktualizowany i ponownie sprawdzono grupowanie."
        : result.decision === "rejected" ? "Korekta odrzucona. Wartość operacyjna pozostała bez zmian."
          : "Decyzja zapisana. Kolejka została odświeżona.");
      setActionId(""); setCandidateId(""); setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zapisać decyzji.");
    } finally { setBusyId(""); }
  }

  async function logout() {
    if (session?.csrfToken) await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": session.csrfToken } }).catch(() => undefined);
    window.location.assign("/");
  }

  const rows = page?.items ?? [];
  const title = session?.role === "operator" ? "Moje propozycje korekt" : tab === "corrections" ? "Korekty REGON" : "Konflikty encji";

  return <div className="admin-shell review-shell">
    <aside className="admin-rail">
      <a className="admin-brand" href="/"><GoldisLogo variant="sidebar" /><div><strong>GOLDIS</strong><small>centrum operacyjne</small></div></a>
      <nav aria-label="Nawigacja platformy">
        <a href="/">Narzędzia</a><a href="/imports">Importy</a><a href="/runs">Zadania</a>
        {(session?.role === "admin" || session?.role === "reviewer") && <a className="admin-nav-active" href="/review" aria-current="page">Decyzje i konflikty</a>}
        {session && ["admin", "reviewer", "auditor"].includes(session.role) && <a href="/audit">Audyt</a>}
        {session?.role === "admin" && <a href="/admin">Administracja</a>}
      </nav>
      <div className="admin-rail-foot"><span>Organizacja Goldis</span><a href="/account">Moje konto</a><button type="button" onClick={() => void logout()}>Wyloguj</button></div>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><span>OPERACJE / WERYFIKACJA DANYCH</span><span>{session ? `${session.username} · ${roles[session.role]}` : "Ładowanie sesji…"}</span></header>
      <div className="admin-content review-content">
        <section className="review-hero"><div><p className="eyebrow">KOLEJKI DECYZYJNE</p><h1>{title}</h1><p>Rozstrzygaj zgłoszenia z kontrolą wersji i aktualnych uprawnień. Każda decyzja jest zapisywana w dzienniku audytu.</p></div><div className="review-hero-mark" aria-hidden="true"><span>R</span><i /></div></section>
        {sessionState === "loading" && <section className="admin-card" role="status">Sprawdzam sesję i uprawnienia…</section>}
        {sessionState === "signed-out" && <section className="admin-card"><h2>Sesja wygasła</h2><p>Zaloguj się ponownie, aby otworzyć kolejkę.</p><a className="admin-button" href="/">Przejdź do logowania</a></section>}
        {sessionState === "error" && <section className="admin-card" role="alert"><h2>Nie można sprawdzić sesji</h2><p>Odśwież stronę. Jeśli problem się powtarza, sprawdź dostępność API.</p><button className="admin-quiet" type="button" onClick={() => window.location.reload()}>Odśwież stronę</button></section>}
        {session && session.mustChangePassword && <p className="admin-alert">Hasło wymaga zmiany. <a href="/account?required=1">Przejdź do ustawień bezpieczeństwa</a></p>}
        {session?.role === "auditor" && <section className="admin-card"><h2>Brak dostępu do danych operacyjnych</h2><p>Audytor ma dostęp do dziennika audytu. Kolejki decyzji są dostępne dla administratorów i reviewerów.</p><a className="admin-button" href="/audit">Otwórz audyt</a></section>}
        {session && session.role !== "auditor" && <>
          {session.role !== "operator" && <div className="review-tabs" role="tablist" aria-label="Typ kolejki">
            <button role="tab" aria-selected={tab === "corrections"} className={tab === "corrections" ? "is-active" : ""} onClick={() => changeTab("corrections")}>Korekty REGON</button>
            <button role="tab" aria-selected={tab === "conflicts"} className={tab === "conflicts" ? "is-active" : ""} onClick={() => changeTab("conflicts")}>Konflikty encji</button>
          </div>}
          <form className="review-filters" onSubmit={applyFilters}>
            <label>Status<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
              <option value="">{session.role === "operator" ? "Wszystkie" : tab === "corrections" ? "Oczekujące" : "Otwarte"}</option>
              {tab === "corrections" ? <><option value="pending">Oczekujące</option><option value="approved">Zatwierdzone</option><option value="rejected">Odrzucone</option></>
                : <><option value="open">Otwarte</option><option value="resolved">Rozstrzygnięte</option></>}
            </select></label>
            <label>Import UUID<input value={draft.batchId} onChange={(event) => setDraft({ ...draft, batchId: event.target.value })} maxLength={36} placeholder="Opcjonalny filtr" /></label>
            <label>Narzędzie<input value={draft.toolId} onChange={(event) => setDraft({ ...draft, toolId: event.target.value })} maxLength={80} placeholder="np. oc-policy-verification" /></label>
            <button className="admin-button" type="submit" disabled={loading}>Zastosuj filtry</button>
          </form>
          {error && <div className="review-error" role="alert"><p>{error}</p>{error.includes("Odśwież kolejkę") && <button className="admin-quiet" type="button" onClick={() => setRevision((value) => value + 1)}>Odśwież kolejkę</button>}</div>}
          {notice && <p className="review-notice" role="status">{notice}</p>}
          {loading && <p className="review-loading" role="status">Pobieram aktualną kolejkę…</p>}
          {!loading && !error && rows.length === 0 && <section className="admin-card review-empty"><span aria-hidden="true">✓</span><h2>Brak spraw do rozpatrzenia</h2><p>Przy zastosowanych filtrach kolejka jest pusta.</p></section>}
          {rows.length > 0 && <section className="review-list" aria-label={title}>
            {rows.map((item) => tab === "corrections" || session.role === "operator"
              ? <CorrectionCard key={item.id} item={item as Correction} mayDecide={allowedToDecide} busy={busyId === item.id} open={actionId === item.id}
                  onOpen={() => { setActionId(item.id); setReasonCode("REGISTRY_MATCH_VERIFIED"); }} onCancel={() => setActionId("")}
                  reasonCode={reasonCode} setReasonCode={setReasonCode} onDecision={(decision) => void submitDecision(item.id, "corrections", {
                    decision, expectedRowVersion: item.rowVersion, reasonCode,
                  })} />
              : <ConflictCard key={item.id} item={item as Conflict} mayDecide={allowedToDecide} busy={busyId === item.id} open={actionId === item.id}
                  candidateId={candidateId} setCandidateId={setCandidateId} onOpen={() => { setActionId(item.id); setCandidateId(""); }} onCancel={() => setActionId("")}
                  onDecision={(action, selectedCandidate) => void submitDecision(item.id, "conflicts", {
                    action, expectedRowVersion: item.rowVersion,
                    reasonCode: action === "link_existing" ? "IDENTIFIERS_VERIFIED" : action === "recheck" ? "SOURCE_DATA_UPDATED" : "CANDIDATE_REJECTED",
                    ...(selectedCandidate ? { canonicalEntityId: selectedCandidate } : {}),
                  })} />)}
          </section>}
          {page?.hasMore && <div className="review-pagination"><span>Limit {page.limit} rekordów na stronę</span><button type="button" className="admin-quiet" disabled={loading} onClick={nextPage}>Następna strona</button></div>}
        </>}
      </div>
    </main>
  </div>;
}

function CorrectionCard({ item, mayDecide, busy, open, onOpen, onCancel, reasonCode, setReasonCode, onDecision }: {
  item: Correction; mayDecide: boolean; busy: boolean; open: boolean; onOpen: () => void; onCancel: () => void;
  reasonCode: string; setReasonCode: (value: string) => void; onDecision: (decision: "approved" | "rejected") => void;
}) {
  return <article className="review-card">
    <div className="review-card-head"><div><p className="eyebrow">KOREKTA REGON · WIERSZ {item.rowNumber}</p><h2>{item.companyName}</h2><p className="review-meta">{item.toolId} · import <code>{item.batchId}</code> · {displayDate(item.createdAt)}</p></div><span className={`review-status status-${item.status}`}>{item.status === "pending" ? "Oczekuje" : item.status === "approved" ? "Zatwierdzona" : "Odrzucona"}</span></div>
    <div className="review-diff"><div><small>REGON operacyjny przed decyzją</small><strong>{item.previousRegon || "Brak"}</strong></div><span aria-hidden="true">→</span><div><small>Proponowana wartość</small><strong>{item.proposedRegon}</strong></div><div><small>Wersja wiersza</small><strong>{item.rowVersion}</strong></div></div>
    <p className="review-reason"><strong>Uzasadnienie operatora:</strong> {item.reason}</p>
    {mayDecide && item.status === "pending" && !open && <button className="admin-button" type="button" disabled={busy} onClick={onOpen}>Rozpatrz korektę</button>}
    {open && <div className="review-decision"><p>Potwierdź decyzję dla wersji {item.rowVersion}. Zatwierdzenie ustawi wartość operacyjną i ponownie sprawdzi grupowanie.</p><label>Kod przyczyny<select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>{Object.entries(correctionReasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="review-actions"><button className="admin-button" type="button" disabled={busy} onClick={() => onDecision("approved")}>{busy ? "Zapisywanie…" : "Zatwierdź"}</button><button className="admin-quiet danger" type="button" disabled={busy} onClick={() => onDecision("rejected")}>Odrzuć</button><button className="admin-quiet" type="button" disabled={busy} onClick={onCancel}>Anuluj</button></div></div>}
  </article>;
}

function ConflictCard({ item, mayDecide, busy, open, candidateId, setCandidateId, onOpen, onCancel, onDecision }: {
  item: Conflict; mayDecide: boolean; busy: boolean; open: boolean; candidateId: string; setCandidateId: (value: string) => void;
  onOpen: () => void; onCancel: () => void; onDecision: (action: "link_existing" | "recheck" | "reject_link", candidateId?: string) => void;
}) {
  return <article className="review-card">
    <div className="review-card-head"><div><p className="eyebrow">KONFLIKT ENCJI · WIERSZ {item.rowNumber}</p><h2>{item.companyName}</h2><p className="review-meta">{item.toolId} · import <code>{item.batchId}</code> · {displayDate(item.createdAt)}</p></div><span className={`review-status status-${item.status}`}>{item.status === "open" ? "Otwarty" : "Rozstrzygnięty"}</span></div>
    <div className="review-diff"><div><small>Powód kontroli</small><strong>{conflictLabels[item.reasonCode] ?? item.reasonCode}</strong></div><div><small>REGON operacyjny</small><strong>{item.effectiveRegon || "Brak"}</strong></div><div><small>Wersja wiersza</small><strong>{item.rowVersion}</strong></div></div>
    <div className="review-candidates"><h3>Kandydaci w tym tenancie</h3>{item.candidates.length ? item.candidates.map((candidate) => <p key={candidate.id}><strong>{candidate.businessName}</strong><span>REGON: {candidate.regon || "brak"} · <code>{candidate.id}</code></span></p>) : <p>Brak bezpiecznych kandydatów do połączenia.</p>}</div>
    {mayDecide && item.status === "open" && !open && <button className="admin-button" type="button" disabled={busy} onClick={onOpen}>Rozpatrz konflikt</button>}
    {open && <div className="review-decision"><p>Decyzja nie może tworzyć powiązania na podstawie samej nazwy. Serwer ponownie sprawdzi NIP, REGON, wersję i stan zadania.</p>{item.candidates.length > 0 && <label>Encja do połączenia<select value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">Wybierz sprawdzoną encję</option>{item.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.businessName} · {candidate.regon || "bez REGON"}</option>)}</select></label>}<div className="review-actions">{item.candidates.length > 0 && <button className="admin-button" type="button" disabled={busy || !candidateId} onClick={() => onDecision("link_existing", candidateId)}>{busy ? "Zapisywanie…" : "Połącz z wybraną encją"}</button>}<button className="admin-quiet" type="button" disabled={busy} onClick={() => onDecision("recheck")}>Sprawdź ponownie</button><button className="admin-quiet danger" type="button" disabled={busy} onClick={() => onDecision("reject_link")}>Odrzuć powiązanie</button><button className="admin-quiet" type="button" disabled={busy} onClick={onCancel}>Anuluj</button></div></div>}
  </article>;
}
