"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import LeadAllocationPanel from "./LeadAllocationPanel";
import LeadSidebar from "./LeadSidebar";
import { buildLeadExportHref, buildLeadListHref, parseLeadViewQuery, sanitizeLeadReturnTo, serializeLeadViewQuery, type ContactStatus, type LeadViewQuery } from "./lead-query";
import { readLeadViewMemory, writeLeadViewMemory } from "./lead-view-memory";
import { sanitizeAppReturnTo } from "../lib/return-to";
import SessionRequired from "../../components/ui/SessionRequired";
import "./leads.css";
import "./platform-pages.css";

type Role = "admin" | "manager" | "operator" | "reviewer" | "auditor";
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
type Summary = { scopeTotal: number; matchingTotal: number; byContactStatus: Record<ContactStatus, number>; checkedAt: string };
type ListData = { key: string; items: Lead[]; nextCursor: string | null; previousCursor: string | null; summary: Summary };
type Props = { mode: "pool" | "mine" | "detail"; leadId?: string };
type ApiError = Error & { status?: number; code?: string };

const statusLabels: Record<ContactStatus, string> = {
  not_contacted: "Nie kontaktowano",
  offer_accepted: "Klient zgadza się na ofertę",
  not_interested: "Klient nie jest zainteresowany",
};

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
async function readApiError(response: Response): Promise<ApiError> {
  const payload = await response.json().catch(() => ({})) as { message?: unknown; code?: unknown };
  const message = typeof payload.message === "string" ? payload.message : Array.isArray(payload.message)
    ? payload.message.filter((part): part is string => typeof part === "string").join(" · ") : "Żądanie nie powiodło się (" + response.status + ").";
  return Object.assign(new Error(message), { status: response.status, code: typeof payload.code === "string" ? payload.code : undefined });
}
function phoneHref(value: string) {
  const normalized = value.replaceAll(" ", "").replaceAll("(", "").replaceAll(")", "").replaceAll("-", "").replaceAll(".", "");
  const digits = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  if (!digits || digits.length < 5 || digits.length > 20 || ![...digits].every((char) => char >= "0" && char <= "9")) return null;
  return "tel:" + normalized;
}
function ContactLinks({ contacts, compact = false }: { contacts: Contact[]; compact?: boolean }) {
  const visible = contacts.slice(0, compact ? 2 : contacts.length);
  if (!visible.length) return <span className="lead-muted">Brak danych kontaktowych</span>;
  return <div className={compact ? "lead-contact-compact-list" : "lead-contact-list"}>{visible.map((contact, index) => {
    const label = contact.type === "mobile" ? "Komórka" : contact.type === "phone" ? "Telefon" : "E-mail";
    const href = contact.type === "email" ? "mailto:" + contact.value : phoneHref(contact.value);
    return <span className="lead-contact-link" key={contact.type + contact.value + index}><span>{label}</span>{href ? <a href={href}>{contact.value}</a> : <span>{contact.value}</span>}</span>;
  })}</div>;
}
function LeadMobileCard({ lead, detailHref, busy, onStatusChange }: { lead: Lead; detailHref: string; busy: boolean; onStatusChange: (status: ContactStatus) => void }) {
  return <article className="lead-mobile-card" data-lead-id={lead.id}>
    <div className="lead-mobile-card-head"><div><Link className="lead-company-link" href={detailHref}>{lead.company}</Link><small>{[lead.address, lead.city].filter(Boolean).join(", ") || "Brak adresu"}</small></div><Link className="lead-open-link" href={detailHref} aria-label={"Otwórz szczegóły: " + lead.company}>→</Link></div>
    <ContactLinks contacts={lead.contacts} />
    <div className="lead-mobile-card-footer"><div><span>Status kontaktu</span>{lead.canEditContactStatus
      ? <select aria-label={"Status kontaktu: " + lead.company} disabled={busy} value={lead.contactStatus} onChange={(event) => onStatusChange(event.target.value as ContactStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      : <strong>{statusLabels[lead.contactStatus]}</strong>}</div><div><span>Wynik OC</span><strong>{lead.runCount} zadań · {lead.policyCount} pozycji</strong><small>Data odniesienia: {lead.referenceDate}</small></div></div>
  </article>;
}

export default function LeadWorkspace({ mode, leadId }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawSearchParams = searchParams.toString();
  const isMine = mode === "mine" || mode === "detail" && pathname.startsWith("/my-results/");
  const parsedView = useMemo(() => {
    try { return { query: parseLeadViewQuery(rawSearchParams, isMine ? "mine" : "pool"), error: "" }; }
    catch (cause) { return { query: { scope: isMine ? "mine" as const : "pool" as const, search: "", contactStatus: "" as const, resultSetId: null, cursor: null, direction: "next" as const }, error: cause instanceof Error ? cause.message : "Nieprawidłowy adres listy firm." }; }
  }, [rawSearchParams, isMine]);
  const viewQuery = parsedView.query;
  const listUrl = buildLeadListHref(isMine ? "/my-results" : "/results/oc-policy-verification", viewQuery);
  const detailFromMine = mode === "detail" && pathname.startsWith("/my-results/");
  const safeReturn = mode === "detail" ? sanitizeLeadReturnTo(searchParams.get("returnTo")) : null;
  const defaultReturn = detailFromMine ? "/my-results" : "/results/oc-policy-verification";
  const returnTo = safeReturn ?? defaultReturn;
  const queueQuery = useMemo(() => {
    try { return parseLeadViewQuery(new URL(returnTo, "https://goldis.invalid").search, detailFromMine ? "mine" : "pool"); }
    catch { return { scope: detailFromMine ? "mine" as const : "pool" as const, search: "", contactStatus: "" as const, resultSetId: null, cursor: null, direction: "next" as const }; }
  }, [returnTo, detailFromMine]);

  const [role, setRole] = useState<Role | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [sessionRetry, setSessionRetry] = useState(0);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [itemsData, setItemsData] = useState<ListData | null>(null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [actorKey, setActorKey] = useState("");
  const [canDownloadResults, setCanDownloadResults] = useState(false);
  const [canExecute, setCanExecute] = useState(false);
  const [searchDraft, setSearchDraft] = useState(viewQuery.search);
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyLeadId, setBusyLeadId] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [queue, setQueue] = useState<{ previousLeadId: string | null; nextLeadId: string | null } | null>(null);
  const [releaseConfirmation, setReleaseConfirmation] = useState(false);
  const restoredKey = useRef("");
  const canAssign = role === "manager" || role === "admin";
  const listData = itemsData?.key === listUrl ? itemsData : null;
  const items = listData?.items ?? [];
  const markUnauthorized = useCallback(() => setAuthenticated(false), []);

  useEffect(() => {
    let active = true;
    setSessionError("");
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!active) return;
      if (response.status === 401) { setAuthenticated(false); setLoading(false); return; }
      if (!response.ok) { setSessionError("Nie udało się sprawdzić sesji. Połączenie nie oznacza wylogowania."); setLoading(false); return; }
      const session = await response.json() as { role?: Role; csrfToken?: string; tenantId?: string; userId?: string; tools?: Array<{ toolId: string; canExecute?: boolean; canDownloadResults?: boolean }> };
      if (!active) return;
      setAuthenticated(true); setRole(session.role ?? null); setCsrfToken(session.csrfToken ?? "");
      if (session.tenantId && session.userId) setActorKey(session.tenantId + ":" + session.userId);
      const access = session.tools?.find((tool) => tool.toolId === "oc-policy-verification");
      setCanDownloadResults(access?.canDownloadResults === true); setCanExecute(access?.canExecute === true);
      if ((mode === "detail" || mode === "pool") && (session.role === "manager" || session.role === "admin")) {
        const response = await fetch("/api/leads/recipients", { credentials: "same-origin", cache: "no-store" });
        if (response.ok && active) { const payload = await response.json() as { items?: Recipient[] }; setRecipients(Array.isArray(payload.items) ? payload.items : []); }
      }
    }).catch(() => { if (active) { setSessionError("Nie udało się połączyć, aby sprawdzić sesję. Spróbuj ponownie."); setLoading(false); } });
    return () => { active = false; };
  }, [sessionRetry, mode]);

  useEffect(() => { setSearchDraft(viewQuery.search); }, [viewQuery.search, rawSearchParams]);
  useEffect(() => {
    if (!authenticated || !role || mode === "detail") return;
    if (parsedView.error) { setError(parsedView.error); setLoading(false); return; }
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError("");
    const params = new URLSearchParams();
    params.set("scope", viewQuery.scope); params.set("limit", "25"); params.set("includeSummary", "1");
    if (viewQuery.search) params.set("search", viewQuery.search);
    if (viewQuery.contactStatus) params.set("contactStatus", viewQuery.contactStatus);
    if (viewQuery.resultSetId) params.set("resultSetId", viewQuery.resultSetId);
    if (viewQuery.cursor) params.set("cursor", viewQuery.cursor);
    if (viewQuery.direction === "previous") params.set("direction", "previous");
    fetch("/api/leads?" + params.toString(), { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { if (active) setAuthenticated(false); return null; }
      if (!response.ok) throw await readApiError(response);
      return await response.json() as { items?: Lead[]; nextCursor?: string | null; previousCursor?: string | null; summary?: Summary };
    }).then((payload) => {
      if (!active || !payload) return;
      const summary = payload.summary;
      if (!summary || !Number.isFinite(summary.scopeTotal) || !Number.isFinite(summary.matchingTotal)) throw new Error("Odpowiedź nie zawiera podsumowania tego widoku.");
      setItemsData({ key: listUrl, items: Array.isArray(payload.items) ? payload.items : [], nextCursor: payload.nextCursor ?? null, previousCursor: payload.previousCursor ?? null, summary });
    }).catch((cause) => { if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać firm."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [authenticated, role, mode, parsedView.error, viewQuery, listUrl, refreshVersion]);

  const loadLead = useCallback(async () => {
    if (!leadId) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/leads/" + encodeURIComponent(leadId), { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw await readApiError(response);
      setLead(await response.json() as Lead);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać szczegółów firmy."); }
    finally { setLoading(false); }
  }, [leadId]);
  useEffect(() => { if (authenticated && mode === "detail") void loadLead(); }, [authenticated, mode, loadLead]);

  useEffect(() => {
    if (!authenticated || mode !== "detail" || !leadId) return;
    const controller = new AbortController();
    const params = new URLSearchParams(serializeLeadViewQuery(queueQuery, false));
    fetch("/api/leads/" + encodeURIComponent(leadId) + "/navigation?" + params.toString(), { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) { setAuthenticated(false); return null; }
        if (!response.ok) throw await readApiError(response);
        return await response.json() as { previousLeadId: string | null; nextLeadId: string | null };
      }).then((value) => { if (value) setQueue(value); }).catch(() => { if (!controller.signal.aborted) setQueue(null); });
    return () => controller.abort();
  }, [authenticated, mode, leadId, queueQuery, refreshVersion]);

  useEffect(() => {
    if (!listData || !actorKey || typeof window === "undefined" || restoredKey.current === listUrl) return;
    restoredKey.current = listUrl;
    const identity = actorKey.split(":");
    const memory = readLeadViewMemory(identity[0], identity[1], listUrl);
    if (!memory) return;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: memory.scrollY, behavior: "instant" as ScrollBehavior });
      if (memory.leadId && !items.some((item) => item.id === memory.leadId)) setNotice("Ta firma nie pasuje już do tego widoku. Zachowano filtry i bieżącą stronę.");
    });
  }, [listData, actorKey, listUrl, items]);

  function navigateWithQuery(next: LeadViewQuery, replace = false) {
    const reset = { ...next, cursor: null, direction: "next" as const };
    const href = buildLeadListHref(pathname, reset);
    if (replace) router.replace(href, { scroll: false }); else router.push(href, { scroll: false });
  }
  function detailHref(target: Lead) {
    const route = "/" + (isMine ? "my-results" : "leads") + "/" + encodeURIComponent(target.id);
    return route + "?returnTo=" + encodeURIComponent(listUrl);
  }
  function rememberListPosition(target: Lead) {
    if (!actorKey) return;
    const identity = actorKey.split(":");
    writeLeadViewMemory(identity[0], identity[1], listUrl, { scrollY: window.scrollY, leadId: target.id });
  }
  async function saveStatus(target: Lead, status: ContactStatus) {
    if (!csrfToken || !target.canEditContactStatus || status === target.contactStatus) return;
    setBusyLeadId(target.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/leads/" + encodeURIComponent(target.id) + "/contact-status", {
        method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ status, expectedVersion: target.contactStatusVersion }),
      });
      if (response.status === 401) { setAuthenticated(false); return; }
      if (response.status === 409) {
        if (mode === "detail") await loadLead();
        setRefreshVersion((value) => value + 1);
        throw new Error("Ktoś zmienił już ten status. Załadowano najnowszą wersję; sprawdź ją przed kolejnym zapisem.");
      }
      if (!response.ok) throw await readApiError(response);
      const payload = await response.json() as { contactStatusVersion: number; contactStatusUpdatedAt: string | null };
      if (mode === "detail") await loadLead();
      else setItemsData((current) => current?.key === listUrl ? { ...current, items: current.items.map((item) => item.id === target.id ? { ...item, contactStatus: status, contactStatusVersion: payload.contactStatusVersion, contactStatusUpdatedAt: payload.contactStatusUpdatedAt } : item) } : current);
      setNotice("Zapisano status kontaktu."); setRefreshVersion((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zmienić statusu kontaktu."); }
    finally { setBusyLeadId(""); }
  }
  async function releaseAssignment() {
    if (!lead || !csrfToken || !lead.canReleaseAssignment) return;
    setBusyLeadId(lead.id); setError("");
    try {
      const response = await fetch("/api/leads/" + encodeURIComponent(lead.id) + "/release-assignment", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: lead.assignmentVersion }),
      });
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw await readApiError(response);
      router.push(returnTo);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zwolnić przydziału."); }
    finally { setBusyLeadId(""); setReleaseConfirmation(false); }
  }
  async function exportCurrentView() {
    if (!canDownloadResults || exportBusy) return;
    setExportBusy(true); setExportMessage(""); setError("");
    try {
      const response = await fetch(buildLeadExportHref(viewQuery), { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) {
        const apiError = await readApiError(response);
        if (apiError.code === "LEAD_EXPORT_LIMIT_EXCEEDED") throw new Error("Zakres obejmuje ponad 50 000 firm. Zawęź wyszukiwanie, status lub zestaw i spróbuj ponownie.");
        if (apiError.status === 403) throw new Error("Nie masz prawa pobierania wyników OC.");
        throw apiError;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const encodedName = disposition.split(";").map((part) => part.trim()).find((part) => part.toLowerCase().startsWith("filename*=utf-8''"))?.slice("filename*=UTF-8''".length);
      const quotedName = disposition.split(";").map((part) => part.trim()).find((part) => part.toLowerCase().startsWith("filename="))?.slice("filename=".length).replaceAll('"', "");
      let fileName = "wyniki-oc.xlsx";
      try { if (encodedName) fileName = decodeURIComponent(encodedName); else if (quotedName) fileName = quotedName; } catch { /* Keep safe fallback name. */ }
      fileName = fileName.replaceAll("/", "_").replaceAll("\\", "_");
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl; anchor.download = fileName; document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setExportMessage("Pobrano " + fileName + ".");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać pliku Excel."); }
    finally { setExportBusy(false); }
  }

  if (authenticated === false) {
    const currentUrl = pathname + (rawSearchParams ? "?" + rawSearchParams : "");
    const origin = typeof window === "undefined" ? "https://goldis.invalid" : window.location.origin;
    const safeCurrentUrl = sanitizeAppReturnTo(currentUrl, origin) ?? defaultReturn;
    return <SessionRequired returnTo={safeCurrentUrl} title="Sesja wygasła" description="Zaloguj się ponownie, aby wrócić do tego widoku firm." />;
  }
  if (sessionError) return <main className="lead-auth-required"><h1>Nie udało się sprawdzić sesji</h1><p>{sessionError}</p><button className="lead-primary" type="button" onClick={() => setSessionRetry((value) => value + 1)}>Spróbuj ponownie</button></main>;
  if (authenticated === null) return <main className="lead-loading" role="status">Sprawdzam sesję…</main>;

  const pageTitle = mode === "detail" ? lead?.company ?? "Szczegóły firmy" : isMine ? "Moje firmy" : "Pula firm";
  const emptyState = listData?.summary.scopeTotal === 0
    ? isMine
      ? <div className="lead-empty"><h2>Nie masz jeszcze przydzielonych firm</h2><p>Gdy menedżer przydzieli Ci firmy, pojawią się tutaj.</p>{canAssign && <Link className="lead-inline-link" href="/results/oc-policy-verification">Otwórz pulę firm →</Link>}</div>
      : <div className="lead-empty"><h2>W puli nie ma jeszcze gotowych firm</h2><p>Firmy pojawią się po zakończeniu sprawdzania OC.</p>{canExecute && <Link className="lead-inline-link" href="/tools/oc-policy-verification">Rozpocznij sprawdzanie OC →</Link>}</div>
    : listData && listData.summary.matchingTotal === 0
      ? <div className="lead-empty"><h2>Brak firm pasujących do filtrów</h2><p>Zmień status lub frazę wyszukiwania.</p><button className="lead-inline-link" type="button" onClick={() => navigateWithQuery({ ...viewQuery, search: "", contactStatus: "" })}>Wyczyść filtry</button></div>
      : listData && listData.summary.matchingTotal > 0
        ? <div className="lead-empty"><h2>Lista zmieniła się od ostatniego odczytu</h2><p>Ten kursor nie wskazuje już firm. Zachowaj filtry i zacznij od pierwszej strony.</p><button className="lead-inline-link" type="button" onClick={() => navigateWithQuery(viewQuery, true)}>Przejdź do początku tego widoku</button></div>
        : null;

  return <div className={"lead-app-shell" + (sidebarExpanded ? "" : " is-collapsed")}>
    <LeadSidebar role={role} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <main className="lead-main">
      <header className="lead-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> PRACA</span><span className="lead-topbar-name">Przestrzeń operacyjna</span></div><div className="lead-topbar-actions"><Link href="/account">Moje konto</Link><span className="lead-avatar">{role === "admin" ? "A" : role === "manager" ? "M" : "P"}</span></div></header>
      <div className="lead-content">
        {mode === "detail" ? <>
          <Link className="lead-back-link" href={returnTo}>← Wróć do {detailFromMine ? "moich firm" : "puli firm"}</Link>
          {loading && !lead ? <div className="lead-loading" role="status">Wczytuję szczegóły firmy…</div> : lead ? <>
            <div className="lead-page-heading"><div><h1>{pageTitle}</h1><p>{lead.address}{lead.address && ", "}{lead.postalCode} {lead.city}</p></div><span className="lead-ready-tag">{lead.resultStatus === "ready" ? "Wynik OC gotowy" : lead.resultStatus}</span></div>
            <nav className="lead-queue-navigation" aria-label="Przejście między firmami">
              {queue?.previousLeadId ? <Link href={"/" + (detailFromMine ? "my-results" : "leads") + "/" + encodeURIComponent(queue.previousLeadId) + "?returnTo=" + encodeURIComponent(returnTo)}>← Poprzednia firma</Link> : <span aria-disabled="true">← Poprzednia firma</span>}
              <span>Przeglądasz kolejkę z tego widoku</span>
              {queue?.nextLeadId ? <Link href={"/" + (detailFromMine ? "my-results" : "leads") + "/" + encodeURIComponent(queue.nextLeadId) + "?returnTo=" + encodeURIComponent(returnTo)}>Następna firma →</Link> : <span aria-disabled="true">To ostatnia firma w tym widoku</span>}
            </nav>
            <section className="lead-detail-grid">
              <article className="lead-panel lead-contact-panel"><h2>Kontakt z firmą</h2><ContactLinks contacts={lead.contacts} />
                {lead.decisionMakers.length > 0 && <p className="lead-decision-maker"><span>Osoba decyzyjna</span><strong>{lead.decisionMakers.join(", ")}</strong></p>}
                <div className="lead-contact-decision"><h3>Status rozmowy</h3>{lead.canEditContactStatus
                  ? <label className="lead-field-label">Decyzja po kontakcie<select disabled={busyLeadId === lead.id} value={lead.contactStatus} onChange={(event) => void saveStatus(lead, event.target.value as ContactStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  : <p className="lead-status-readonly">{statusLabels[lead.contactStatus]}{lead.assignedTo ? " · przydzielono " + lead.assignedTo : " · wynik oczekuje na przydział"}</p>}
                  {busyLeadId === lead.id && <small role="status">Zapisuję status…</small>}{lead.contactStatusUpdatedAt && <small>Ostatnia zmiana: {dateLabel(lead.contactStatusUpdatedAt)}</small>}</div>
              </article>
              <article className="lead-panel"><h2>Wynik OC</h2><dl><div><dt>Data odniesienia</dt><dd>{lead.referenceDate}</dd></div><div><dt>Zadania firmowe</dt><dd>{lead.runCount}</dd></div><div><dt>Pozycje wyniku</dt><dd>{lead.policyCount}</dd></div></dl>
                {lead.sourceImportDeleted ? <p className="lead-muted">Import źródłowy został usunięty. Zachowano wynik firmy.</p> : lead.sourceImportId && <Link className="lead-inline-link" href={"/tools/oc-policy-verification?import=" + encodeURIComponent(lead.sourceImportId)}>Otwórz źródłowy import →</Link>}
                <div className="lead-run-links"><strong>{lead.sourceImportDeleted ? "Pobierz zachowany wynik Excel" : "Szczegółowe raporty"}</strong>{lead.sourceImportDeleted ? lead.snapshots.map((snapshot) => <a key={snapshot.runId} href={"/api/leads/" + encodeURIComponent(lead.id) + "/snapshots/" + encodeURIComponent(snapshot.runId) + "/workbook"}>Wynik {snapshot.referenceDate} · {snapshot.policyCount} pozycji →</a>) : lead.runs.length ? lead.runs.map((runId, index) => <Link key={runId} href={"/runs/" + encodeURIComponent(runId)}>Zadanie firmowe {index + 1} · {runId.slice(0, 8)} →</Link>) : <small>Raport pojawi się po przyjęciu zadania firmowego.</small>}</div>
              </article>
              <article className="lead-panel lead-identity"><h2>Dane firmy</h2><dl><div><dt>NIP</dt><dd>{lead.nip || "—"}</dd></div><div><dt>REGON</dt><dd>{lead.regon || "—"}</dd></div><div><dt>Przydzielono</dt><dd>{lead.assignedTo ?? "Oczekuje na przydział"}</dd></div><div><dt>Identyfikator wyników</dt><dd className="lead-mono">{lead.resultSetId}</dd></div></dl></article>
              {!lead.sourceImportDeleted && <article className="lead-panel lead-source-panel"><div className="lead-section-heading"><div><h2>Wiersze źródłowe</h2><p>Informacje pochodzą z zaimportowanego pliku.</p></div>{lead.sourceImportId && <Link className="lead-secondary" href={"/tools/oc-policy-verification?import=" + encodeURIComponent(lead.sourceImportId)}>Otwórz import</Link>}</div>
                {lead.sourceRows?.length ? <div className="lead-source-list">{lead.sourceRows.map((source) => <article key={source.rowNumber}><span className="lead-row-number">Wiersz {source.rowNumber}</span><strong>{source.companyName}</strong><p>{source.decisionMakerName || "Brak osoby decyzyjnej"} · NIP {source.nip || "—"} · REGON {source.regon || "—"}</p><small>{source.mobile && "Komórka " + source.mobile}{source.mobile && source.phone && " · "}{source.phone && "Telefon " + source.phone}{(source.mobile || source.phone) && source.email && " · "}{source.email}</small></article>)}</div> : <p className="lead-muted">Brak szczegółowych wierszy źródłowych dla tego wyniku.</p>}
              </article>}
            </section>
            {canAssign && detailFromMine && lead.canReleaseAssignment && <section className="lead-release-action" aria-label="Zarządzanie przydziałem">
              {releaseConfirmation ? <div className="lead-release-confirm" role="group" aria-label="Potwierdź zwolnienie przydziału"><p>Firma wróci do wspólnej puli. Po zwolnieniu przydziału nie możesz odzyskać go samodzielnie.</p><button className="lead-secondary" type="button" onClick={() => setReleaseConfirmation(false)}>Zachowaj przydział</button><button className="lead-danger-button" type="button" disabled={busyLeadId === lead.id} onClick={() => void releaseAssignment()}>{busyLeadId === lead.id ? "Zwalniam…" : "Potwierdź zwolnienie"}</button></div>
                : <button className="lead-secondary" type="button" onClick={() => setReleaseConfirmation(true)}>Zwolnij mój przydział</button>}
            </section>}
          </> : <div className="lead-empty"><h1>Nie udało się otworzyć firmy</h1><p>{error || "Firma może być już niedostępna w Twoim zakresie."}</p><Link className="lead-secondary" href={returnTo}>Wróć do listy firm</Link></div>}
          {error && lead && <p className="lead-feedback" role="alert">{error}</p>}{notice && <p className="lead-notice" role="status">{notice}</p>}
        </> : <>
          <div className="lead-page-heading"><div><h1>{pageTitle}</h1><p>{isMine ? "Firmy przydzielone Tobie. Po rozmowie zapisz decyzję i przejdź dalej." : "Gotowe wyniki OC, które możesz przeglądać lub przydzielać zespołowi."}</p></div>
            <div className="lead-read-state" role="status" aria-live="polite">{loading && listData ? "Odświeżam…" : listData ? "Odczytano: " + dateLabel(listData.summary.checkedAt) : ""}</div></div>
          {listData && <section className="lead-metrics" aria-label="Podsumowanie firm w tym widoku"><article><span>Firmy w tym widoku</span><strong>{listData.summary.matchingTotal}</strong><small>{listData.summary.scopeTotal} w wybranym zakresie</small></article><article><span>Do kontaktu w tym widoku</span><strong>{listData.summary.byContactStatus.not_contacted}</strong><small>Nie kontaktowano</small></article><article><span>Zainteresowane w tym widoku</span><strong>{listData.summary.byContactStatus.offer_accepted}</strong><small>Zaakceptowano ofertę</small></article></section>}
          {canAssign && !isMine && <LeadAllocationPanel key={actorKey + ":" + (viewQuery.resultSetId ?? "pool")} recipients={recipients} csrfToken={csrfToken} actorKey={actorKey} resultSetId={viewQuery.resultSetId} onUnauthorized={markUnauthorized} onAllocated={() => setRefreshVersion((value) => value + 1)} />}
          <section className="lead-panel lead-table-panel" aria-busy={loading}>
            <div className="lead-section-heading"><div><h2>{isMine ? "Firmy przydzielone do mnie" : "Firmy z puli OC"}</h2><p>Excel obejmie wszystkie firmy pasujące do aktywnych filtrów.</p></div>
              <div className="lead-table-actions">{canDownloadResults ? <button className="lead-secondary" type="button" disabled={exportBusy} onClick={() => void exportCurrentView()}>{exportBusy ? "Przygotowuję Excel…" : isMine ? "Eksportuj moje firmy" : "Eksportuj firmy z tego widoku"}</button> : <span className="lead-muted">Nie masz prawa pobierania wyników OC.</span>}
                <button className="lead-icon-button" type="button" aria-label="Odśwież listę firm" disabled={loading} onClick={() => setRefreshVersion((value) => value + 1)}>↻</button>
              </div></div>
            {exportMessage && <p className="lead-notice" role="status">{exportMessage}</p>}
            <form className="lead-filters" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); navigateWithQuery({ ...viewQuery, search: searchDraft.trim() }); }}>
              <label className="lead-search-label"><span>Szukaj firmy</span><input value={searchDraft} maxLength={120} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Nazwa, NIP lub REGON" /></label>
              <label><span>Status kontaktu</span><select value={viewQuery.contactStatus} onChange={(event) => navigateWithQuery({ ...viewQuery, contactStatus: event.target.value as LeadViewQuery["contactStatus"] })}><option value="">Wszystkie statusy</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <button className="lead-secondary" type="submit">Szukaj</button>
            </form>
            {error && <div className="lead-feedback" role="alert"><span>{error}</span>{!loading && <button type="button" className="lead-inline-link" onClick={() => setRefreshVersion((value) => value + 1)}>Spróbuj ponownie</button>}</div>}
            {loading && !listData ? <div className="lead-loading" role="status">Pobieram firmy…</div> : items.length ? <>
              <p className="lead-result-count" aria-live="polite">Pokazano {items.length} z {listData?.summary.matchingTotal ?? items.length} firm pasujących do filtrów.</p>
              <div className="lead-table-scroll" role="region" aria-label="Tabela firm" tabIndex={0}><table className="lead-table"><thead><tr><th>Firma</th><th>Kontakt</th>{!isMine && <th>Przydział</th>}<th>Status kontaktu</th><th>Wynik OC</th><th aria-label="Szczegóły" /></tr></thead><tbody>
                {items.map((item) => { const href = detailHref(item); return <tr key={item.id} data-lead-id={item.id}><td><Link className="lead-company-link" href={href} onClick={() => rememberListPosition(item)}>{item.company}</Link><small>{[item.address, item.city].filter(Boolean).join(", ") || "Brak adresu"}</small></td>
                  <td><ContactLinks contacts={item.contacts} compact /></td>{!isMine && <td>{item.assignedTo ? <><span className="lead-assigned-tag">{item.assignedTo}</span><small>{item.assignedAt ? dateLabel(item.assignedAt) : "Przydzielono"}</small></> : <span className="lead-unassigned-tag">W puli</span>}</td>}
                  <td>{item.canEditContactStatus ? <select className="lead-status-select" aria-label={"Status kontaktu: " + item.company} disabled={busyLeadId === item.id} value={item.contactStatus} onChange={(event) => void saveStatus(item, event.target.value as ContactStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <span className={"lead-status-pill status-" + item.contactStatus}>{statusLabels[item.contactStatus]}</span>}</td>
                  <td><span>{item.runCount} zadań firmowych</span><small>{item.policyCount} pozycji · data odniesienia {item.referenceDate}</small></td><td><Link className="lead-open-link" href={href} aria-label={"Otwórz szczegóły: " + item.company} onClick={() => rememberListPosition(item)}>→</Link></td></tr>; })}
              </tbody></table></div>
              <div className="lead-mobile-list">{items.map((item) => <LeadMobileCard key={item.id} lead={item} detailHref={detailHref(item)} busy={busyLeadId === item.id} onStatusChange={(status) => void saveStatus(item, status)} />)}</div>
            </> : loading ? <div className="lead-loading" role="status">Odświeżam listę firm…</div> : emptyState ?? (error
              ? <div className="lead-empty"><h2>Nie udało się wczytać firm</h2><p>Sprawdź połączenie i ponów odczyt tego samego widoku.</p></div>
              : <div className="lead-loading" role="status">Ładuję podsumowanie widoku…</div>)}
            {!error && listData && (listData.previousCursor || listData.nextCursor) && <nav className="lead-pagination" aria-label="Strony listy firm">
              {listData.previousCursor ? <button className="lead-secondary" type="button" disabled={loading} onClick={() => router.push(buildLeadListHref(pathname, { ...viewQuery, cursor: listData.previousCursor, direction: "previous" }), { scroll: false })}>Poprzednia</button> : <span />}
              <span>25 firm na stronie · {listData.summary.matchingTotal} w tym widoku</span>
              {listData.nextCursor ? <button className="lead-secondary" type="button" disabled={loading} onClick={() => router.push(buildLeadListHref(pathname, { ...viewQuery, cursor: listData.nextCursor, direction: "next" }), { scroll: false })}>Następna</button> : <span />}
            </nav>}
          </section>
        </>}
      </div>
    </main>
  </div>;
}
