"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { usePathname } from "next/navigation";
import LeadAllocationPanel from "./LeadAllocationPanel";
import LeadSidebar from "./LeadSidebar";
import "./leads.css";
import "./platform-pages.css";

type Role = "admin" | "manager" | "operator" | "reviewer" | "auditor";
type ContactStatus = "not_contacted" | "offer_accepted" | "not_interested";
type Contact = { type: "mobile" | "phone" | "email"; value: string; sourceRowId: string | null };
type SourceRow = { rowNumber: number; companyName: string; decisionMakerName: string | null; nip: string; regon: string; address: string; postalCode: string; city: string; mobile: string; phone: string; email: string };
type Lead = {
  id: string; resultSetId: string; automationId: string; operationId: string; sourceImportId: string | null; sourceImportDeleted: boolean;
  sourceRowIds?: string[]; createdAt: string; referenceDate: string; company: string; nip: string | null; regon: string | null;
  address: string; postalCode: string; city: string; decisionMakers: string[]; contacts: Contact[];
  resultStatus: string; contactStatus: ContactStatus; contactStatusVersion: number; assignmentVersion: number;
  canReleaseAssignment: boolean; contactStatusUpdatedAt: string | null;
  assignedToUserId: string | null; assignedTo: string | null; assignedByUserId: string | null; assignedAt: string | null;
  runCount: number; policyCount: number; runs: string[]; snapshots: { runId: string; referenceDate: string; policyCount: number }[];
  canEditContactStatus: boolean; sourceRows?: SourceRow[];
};
type Recipient = { userId: string; name: string; role: string };
type Props = { mode: "pool" | "mine" | "detail"; leadId?: string };

const statusLabels: Record<ContactStatus, string> = {
  not_contacted: "Nie kontaktowano",
  offer_accepted: "Klient zgadza się na ofertę",
  not_interested: "Klient nie jest zainteresowany",
};

function errorMessage(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.filter((item): item is string => typeof item === "string").join(" · ");
  }
  return fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function LeadWorkspace({ mode, leadId }: Props) {
  const pathname = usePathname();
  const [role, setRole] = useState<Role | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [items, setItems] = useState<Lead[]>([]);
  const [lead, setLead] = useState<Lead | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [resultSetId, setResultSetId] = useState<string | null>(null);
  const [allocationActorKey, setAllocationActorKey] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busyLeadId, setBusyLeadId] = useState("");
  const canAssign = role === "manager" || role === "admin";
  const handleAllocationUnauthorized = useCallback(() => setAuthenticated(false), []);

  useEffect(() => {
    setResultSetId(new URLSearchParams(window.location.search).get("resultSetId"));
  }, []);

  const loadList = useCallback(async (nextCursorValue: string | null = null) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ scope: mode === "mine" ? "mine" : "pool", limit: "25" });
    if (mode === "pool" && resultSetId) params.set("resultSetId", resultSetId);
    if (search) params.set("search", search);
    if (statusFilter) params.set("contactStatus", statusFilter);
    if (nextCursorValue) params.set("cursor", nextCursorValue);
    try {
      const response = await fetch(`/api/leads?${params.toString()}`, { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw new Error(errorMessage(payload, "Nie udało się pobrać wyników."));
      setItems(Array.isArray(payload.items) ? payload.items as Lead[] : []);
      setNextCursor(typeof payload.nextCursor === "string" ? payload.nextCursor : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać wyników."); }
    finally { setLoading(false); }
  }, [mode, resultSetId, search, statusFilter]);

  const loadLead = useCallback(async () => {
    if (!leadId) return;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(leadId)}`, { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw new Error(errorMessage(payload, "Nie udało się pobrać szczegółów wyniku."));
      setLead(payload as Lead);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać szczegółów wyniku."); }
    finally { setLoading(false); }
  }, [leadId]);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) { if (active) { setAuthenticated(false); setLoading(false); } return; }
      const session = await response.json() as { role?: Role; csrfToken?: string; userId?: string; tenantId?: string };
      if (!active) return;
      setRole(session.role ?? null); setCsrfToken(session.csrfToken ?? "");
      if (session.userId && session.tenantId) setAllocationActorKey(`${session.tenantId}:${session.userId}`);
      if (mode === "detail") void loadLead();
      if (session.role === "manager" || session.role === "admin") {
        const recipientsResponse = await fetch("/api/leads/recipients", { credentials: "same-origin", cache: "no-store" });
        if (recipientsResponse.ok && active) {
          const payload = await recipientsResponse.json() as { items?: Recipient[] };
          const nextRecipients = Array.isArray(payload.items) ? payload.items : [];
          setRecipients(nextRecipients);
        }
      }
    }).catch(() => { if (active) { setAuthenticated(false); setLoading(false); } });
    return () => { active = false; };
  // Initial session read; list/detail loaders refresh when filters change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!role || mode === "detail") return;
    setCursor(null); setCursorStack([]); void loadList(null);
  }, [role, mode, resultSetId, search, statusFilter, loadList]);

  async function saveStatus(target: Lead, status: ContactStatus) {
    if (!csrfToken || !target.canEditContactStatus) return;
    setBusyLeadId(target.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(target.id)}/contact-status`, {
        method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ status, expectedVersion: target.contactStatusVersion }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(payload, "Nie udało się zmienić statusu kontaktu."));
      if (mode === "detail") await loadLead();
      else setItems((current) => current.map((item) => item.id === target.id ? { ...item, contactStatus: status,
        contactStatusVersion: Number(payload.contactStatusVersion), contactStatusUpdatedAt: payload.contactStatusUpdatedAt ?? null } : item));
      setNotice("Zapisano status kontaktu.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zmienić statusu kontaktu."); }
    finally { setBusyLeadId(""); }
  }

  async function releaseAssignment(target: Lead) {
    if (!csrfToken || !target.canReleaseAssignment) return;
    setBusyLeadId(target.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/leads/" + encodeURIComponent(target.id) + "/release-assignment", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: target.assignmentVersion }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(payload, "Nie udało się zwolnić przydziału."));
      window.location.assign("/my-results");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zwolnić przydziału."); }
    finally { setBusyLeadId(""); }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSearch(searchDraft.trim());
  }

  if (!authenticated) return <main className="lead-auth-required"><a className="lead-brand" href="/">G<span>.</span> GOLDIS</a><h1>Zaloguj się, aby zobaczyć wyniki</h1><p>Ta sekcja korzysta z firmowych wyników automatyzacji OC.</p><a className="lead-primary" href="/">Przejdź do logowania</a></main>;

  const isMine = mode === "mine";
  const detailFromMine = pathname.startsWith("/my-results/");
  const pageTitle = mode === "detail" ? lead?.company ?? "Szczegóły wyniku" : isMine ? "Moje wyniki" : "Wyniki automatyzacji OC";

  return <div className={`lead-app-shell${sidebarExpanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={role} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <main className="lead-main">
      <header className="lead-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> WYNIKI</span><span className="lead-topbar-name">Przestrzeń operacyjna</span></div><div className="lead-topbar-actions"><a href="/account">Konto</a><span className="lead-avatar">{role === "admin" ? "A" : role === "manager" ? "M" : "P"}</span></div></header>
      <div className="lead-content">
        {mode === "detail" && detailFromMine && lead?.canReleaseAssignment && <div className="lead-release-action"><button className="lead-secondary" type="button" disabled={busyLeadId === lead.id} onClick={() => void releaseAssignment(lead)}>Zwolnij mój przydział</button></div>}
        {mode === "detail" ? <>
          <a className="lead-back-link" href={detailFromMine ? "/my-results" : "/results/oc-policy-verification"}>← Wróć do {detailFromMine ? "moich wyników" : "listy wyników"}</a>
          {loading ? <div className="lead-loading" role="status">Wczytuję szczegóły firmy…</div> : lead ? <>
            <div className="lead-page-heading"><div><p className="lead-overline">WYNIK FIRMY <span>·</span> {lead.resultSetId.slice(0, 8).toUpperCase()}</p><h1>{lead.company}</h1><p>{lead.address}{lead.address && ", "}{lead.postalCode} {lead.city}</p></div><span className="lead-ready-tag">{lead.resultStatus === "ready" ? "Wynik gotowy" : lead.resultStatus}</span></div>
            <section className="lead-detail-grid">
              <article className="lead-panel lead-identity"><p className="lead-overline">IDENTYFIKATORY</p><dl><div><dt>NIP</dt><dd>{lead.nip || "—"}</dd></div><div><dt>REGON</dt><dd>{lead.regon || "—"}</dd></div><div><dt>Osoba decyzyjna</dt><dd>{lead.decisionMakers.length ? lead.decisionMakers.join(", ") : "—"}</dd></div><div><dt>Data uruchomienia</dt><dd>{lead.referenceDate}</dd></div></dl></article>
              <article className="lead-panel"><p className="lead-overline">KONTAKT Z FIRMĄ</p><h2>Status rozmowy</h2>{lead.canEditContactStatus ? <label className="lead-field-label">Decyzja po kontakcie<select disabled={busyLeadId === lead.id} value={lead.contactStatus} onChange={(event) => void saveStatus(lead, event.target.value as ContactStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <p className="lead-status-readonly">{statusLabels[lead.contactStatus]}{lead.assignedTo ? ` · przydzielono ${lead.assignedTo}` : " · wynik oczekuje na przydział"}</p>}{lead.contactStatusUpdatedAt && <small>Ostatnia zmiana: {formatDate(lead.contactStatusUpdatedAt)}</small>}</article>
              <article className="lead-panel"><p className="lead-overline">DANE KONTAKTOWE</p><div className="lead-contact-list">{lead.contacts.length ? lead.contacts.map((contact, index) => <div className="lead-contact" key={`${contact.type}-${contact.value}-${index}`}><span>{contact.type === "mobile" ? "Komórka" : contact.type === "phone" ? "Telefon" : "E-mail"}</span>{contact.type === "email" ? <a href={`mailto:${encodeURIComponent(contact.value)}`}>{contact.value}</a> : <a href={`tel:${encodeURIComponent(contact.value)}`}>{contact.value}</a>}</div>) : <p>W pliku źródłowym nie podano telefonu ani adresu e-mail.</p>}</div></article>
              <article className="lead-panel"><p className="lead-overline">AUTOMATYZACJA</p><h2>Wynik z operacji</h2><dl><div><dt>ID wyniku</dt><dd className="lead-mono">{lead.resultSetId}</dd></div><div><dt>Zadania firmowe</dt><dd>{lead.runCount}</dd></div><div><dt>Pozycje w wyniku</dt><dd>{lead.policyCount}</dd></div></dl>{lead.sourceImportDeleted ? <p className="lead-muted">Import usunięty. Wynik firmy został zachowany.</p> : lead.sourceImportId && <a className="lead-inline-link" href={`/tools/oc-policy-verification?import=${encodeURIComponent(lead.sourceImportId)}`}>Zobacz źródłowy import →</a>}<div className="lead-run-links"><strong>{lead.sourceImportDeleted ? "Pobierz zachowany wynik Excel" : "Szczegółowe raporty"}</strong>{lead.sourceImportDeleted ? lead.snapshots.map((snapshot) => <a key={snapshot.runId} href={`/api/leads/${encodeURIComponent(lead.id)}/snapshots/${encodeURIComponent(snapshot.runId)}/workbook`}>Wynik {snapshot.referenceDate} · {snapshot.policyCount} polis →</a>) : lead.runs.length ? lead.runs.map((runId, index) => <a key={runId} href={`/runs/${encodeURIComponent(runId)}`}>Zadanie firmowe {index + 1} · {runId.slice(0, 8)} →</a>) : <small>Raport pojawi się po przyjęciu zadania firmowego.</small>}</div></article>
            </section>
            <section className="lead-panel lead-source-panel"><div className="lead-section-heading"><div><p className="lead-overline">POCHODZENIE DANYCH</p><h2>{lead.sourceImportDeleted ? "Zachowany wynik" : "Wiersze ze źródłowego Excela"}</h2></div>{lead.sourceImportId && <a className="lead-secondary" href={`/tools/oc-policy-verification?import=${encodeURIComponent(lead.sourceImportId)}`}>Otwórz import</a>}</div>
              {lead.sourceImportDeleted ? <p className="lead-muted">Import usunięty. Kontakt, status i zaszyfrowany wynik polis są dostępne w zachowanym pliku Excel powyżej.</p> : lead.sourceRows?.length ? <div className="lead-source-list">{lead.sourceRows.map((source) => <article key={source.rowNumber}><span className="lead-row-number">WIERSZ {source.rowNumber}</span><strong>{source.companyName}</strong><p>{source.decisionMakerName || "Brak osoby decyzyjnej"} · NIP {source.nip || "—"} · REGON {source.regon || "—"}</p><small>{source.mobile && `Komórka ${source.mobile}`}{source.mobile && source.phone && " · "}{source.phone && `Tel. ${source.phone}`}{(source.mobile || source.phone) && source.email && " · "}{source.email}</small></article>)}</div> : <p className="lead-muted">Brak szczegółowych wierszy źródłowych dla tego wyniku.</p>}
            </section>
          </> : <div className="lead-empty"><h1>Nie udało się otworzyć wyniku</h1><p>Możesz nie mieć dostępu do tego rekordu albo został usunięty.</p></div>}
          {error && <p className="lead-feedback" role="status">{error}</p>}
          {notice && <p className="lead-notice" role="status">{notice}</p>}
        </> : <>
          <div className="lead-page-heading"><div><p className="lead-overline">AUTOMATYZACJA <span>·</span> OC / WERYFIKACJA</p><h1>{pageTitle}</h1><p>{isMine ? "Leady przydzielone do Ciebie. Zmieniaj status po rozmowie z klientem." : "Firmy znalezione przez automatyzację, przypisane do konkretnych uruchomień."}</p></div><span className="lead-live-tag"><i /> Dane aktualne</span></div>
          <section className="lead-metrics" aria-label="Podsumowanie wyników"><article><span>Widoczne firmy</span><strong>{items.length}</strong><small>{loading ? "Odświeżam listę" : "Na tej stronie"}</small></article><article><span>Do kontaktu</span><strong>{items.filter((item) => item.contactStatus === "not_contacted").length}</strong><small>Wymagają rozmowy</small></article><article><span>Pozytywna decyzja</span><strong>{items.filter((item) => item.contactStatus === "offer_accepted").length}</strong><small>Klient zainteresowany</small></article><article><span>Automatyzacja</span><strong className="lead-metric-name">OC</strong><small>Weryfikacja polis</small></article></section>
          {canAssign && !isMine && <LeadAllocationPanel key={`${allocationActorKey}:${resultSetId ?? "pool"}`} recipients={recipients}
            csrfToken={csrfToken} actorKey={allocationActorKey} resultSetId={resultSetId}
            onUnauthorized={handleAllocationUnauthorized} onAllocated={() => loadList(cursor)} />}
          <section className="lead-panel lead-table-panel"><div className="lead-section-heading"><div><p className="lead-overline">REJESTR FIRM</p><h2>{isMine ? "Przypisane do mnie" : "Wyniki automatyzacji"}</h2></div><div className="lead-table-actions"><span className="lead-count-tag">{loading ? "…" : `${items.length} na stronie`}</span><a className="lead-secondary" href="/api/leads/export">Pobierz Excel</a></div></div>
            <form className="lead-filters" onSubmit={submitSearch}><label className="lead-search-label"><span>Szukaj firmy</span><input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Nazwa, NIP lub REGON" /></label><label><span>Status kontaktu</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">Wszystkie</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="lead-secondary" type="submit">Szukaj</button></form>
            {error && <p className="lead-feedback" role="alert">{error}</p>}
            {notice && <p className="lead-notice" role="status">{notice}</p>}
            {loading ? <div className="lead-loading" role="status">Wczytuję wyniki…</div> : items.length ? <div className="lead-table-scroll" role="region" aria-label="Wyniki firm" tabIndex={0}><table className="lead-table"><thead><tr><th>Firma</th><th>Identyfikatory</th><th>Kontakt</th><th>Przydział</th><th>Status rozmowy</th><th>Wynik automatyzacji</th><th aria-label="Szczegóły" /></tr></thead><tbody>{items.map((item) => { const detailPath = `/${isMine ? "my-results" : "leads"}/${item.id}`; return <tr key={item.id}><td><a className="lead-company-link" href={detailPath}>{item.company}</a><small>{item.address}{item.address && ", "}{item.city}</small></td><td><span className="lead-mono">NIP {item.nip || "—"}</span><small className="lead-mono">REGON {item.regon || "—"}</small></td><td>{item.contacts.length ? item.contacts.slice(0, 2).map((contact, index) => <small className="lead-contact-compact" key={`${contact.type}-${index}`}>{contact.type === "email" ? "✉" : "☎"} {contact.value}</small>) : <small>Brak w Excelu</small>}</td><td>{item.assignedTo ? <><span className="lead-assigned-tag">{item.assignedTo}</span><small>{item.assignedAt ? formatDate(item.assignedAt) : "Przydzielono"}</small></> : <span className="lead-unassigned-tag">W puli</span>}</td><td>{item.canEditContactStatus ? <select className="lead-status-select" aria-label={`Status kontaktu: ${item.company}`} disabled={busyLeadId === item.id} value={item.contactStatus} onChange={(event) => void saveStatus(item, event.target.value as ContactStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <span className={`lead-status-pill status-${item.contactStatus}`}>{statusLabels[item.contactStatus]}</span>}</td><td><span>{item.runCount} zadań firmowych</span><small>{item.policyCount} pozycji · {item.referenceDate} · ID {item.resultSetId.slice(0, 8)}</small></td><td><a className="lead-open-link" href={detailPath} aria-label={`Otwórz szczegóły: ${item.company}`}>→</a></td></tr>; })}</tbody></table></div> : <div className="lead-empty"><span>▤</span><h3>Brak wyników do wyświetlenia</h3><p>Po zakończeniu automatyzacji firmy pojawią się na tej liście.</p><a className="lead-inline-link" href="/tools/oc-policy-verification">Przejdź do automatyzacji →</a></div>}
            <div className="lead-pagination"><button className="lead-secondary" type="button" disabled={!cursorStack.length || loading} onClick={() => { const previous = cursorStack.at(-1) ?? null; setCursorStack((stack) => stack.slice(0, -1)); setCursor(previous); void loadList(previous); }}>Poprzednia</button><span>Wyniki są stronicowane po 25 firm</span><button className="lead-secondary" type="button" disabled={!nextCursor || loading} onClick={() => { setCursorStack((stack) => [...stack, cursor]); setCursor(nextCursor); void loadList(nextCursor); }}>Następna</button></div>
          </section>
          {error && !canAssign && <p className="lead-feedback" role="status">{error}</p>}
        </>}
      </div>
    </main>
  </div>;
}
