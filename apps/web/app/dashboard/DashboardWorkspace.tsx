"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import LeadSidebar from "../leads/LeadSidebar";
import SessionRequired from "../../components/ui/SessionRequired";
import "../leads/leads.css";
import "../leads/platform-pages.css";
import "./dashboard.css";

type Role = "admin" | "manager" | "operator" | "reviewer" | "auditor";
type Operation = { id: string; resultSetId: string; toolName: string; fileName: string | null; status: string; createdAt: string; updatedAt: string; finishedAt: string | null; readyCount: number; failedCount: number };
type Dashboard = { role: Role; tools: { toolId: string; canExecute: boolean; canViewResults: boolean; canDownloadResults: boolean }[]; metrics: { operations: { total: number; active: number; attention: number; completed: number }; myLeads: { notContacted: number }; team: { unassigned: number } | null }; operations: Operation[]; actionRequired: { id: string; href: string }[]; unreadNotifications: number };
type Notification = { id: string; title: string; message: string; href: string; createdAt: string; readAt: string | null; eventType: string };
const statuses: Record<string, string> = { queued: "W kolejce", running: "W trakcie", waiting_attention: "Wymaga działania", completed: "Zakończona", cancelled: "Anulowana", failed: "Błąd" };
function date(value: string) { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(d); }

export default function DashboardWorkspace() {
  const pathname = usePathname();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [authenticated, setAuthenticated] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("all");
  const [availability, setAvailability] = useState<number | null>(null);
  const [availabilityError, setAvailabilityError] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [notificationError, setNotificationError] = useState("");
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch("/api/dashboard", { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async response => {
      if (response.status === 401) { setAuthenticated(false); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Nie udało się pobrać przeglądu.");
      setData(payload); setUnread(payload.unreadNotifications); setSelectedId(payload.operations[0]?.id ?? "");
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać przeglądu."); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    const update = (event: Event) => { const count = (event as CustomEvent<unknown>).detail; if (typeof count === "number") setUnread(count); };
    window.addEventListener("goldis:notifications-count", update); return () => window.removeEventListener("goldis:notifications-count", update);
  }, []);
  const manager = data?.role === "admin" || data?.role === "manager";
  const oc = data?.tools.find(tool => tool.toolId === "oc-policy-verification");
  const canView = data?.role !== "auditor" && oc?.canViewResults === true;
  const canRun = ["admin", "manager", "operator"].includes(data?.role ?? "") && oc?.canExecute === true;
  const selected = data?.operations.find(operation => operation.id === selectedId) ?? null;
  useEffect(() => {
    setAvailability(null); setAvailabilityError("");
    if (!manager || !canView || !selected || selected.status !== "completed") return;
    const controller = new AbortController();
    fetch(`/api/leads/allocation-summary?resultSetId=${encodeURIComponent(selected.resultSetId)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async response => {
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw new Error("Nie udało się pobrać stanu przydziału.");
      const payload = await response.json();
      if (!Number.isSafeInteger(payload.availableCount) || payload.availableCount < 0) throw new Error("Nie udało się pobrać stanu przydziału.");
      setAvailability(payload.availableCount);
    }).catch(cause => { if (!controller.signal.aborted) setAvailabilityError(cause instanceof Error ? cause.message : "Nie udało się pobrać stanu przydziału."); });
    return () => controller.abort();
  }, [manager, canView, selected?.resultSetId, selected?.status]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setNotificationLoading(true); setNotificationError("");
    fetch("/api/notifications?limit=50", { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async response => {
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw new Error("Nie udało się pobrać powiadomień.");
      const payload = await response.json(); setItems(payload.items); setUnread(payload.unreadCount);
      window.dispatchEvent(new CustomEvent("goldis:notifications-count", { detail: payload.unreadCount }));
    }).catch(cause => { if (!controller.signal.aborted) setNotificationError(cause instanceof Error ? cause.message : "Nie udało się pobrać powiadomień."); }).finally(() => { if (!controller.signal.aborted) setNotificationLoading(false); });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    const outside = (event: MouseEvent) => { if (!popover.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", key); document.addEventListener("mousedown", outside);
    return () => { controller.abort(); document.removeEventListener("keydown", key); document.removeEventListener("mousedown", outside); };
  }, [open]);
  async function markRead(item: Notification) {
    if (item.readAt || busy) return;
    setBusy(item.id); setNotificationError("");
    try {
      const session = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      if (session.status === 401) { setAuthenticated(false); return; }
      if (!session.ok) throw new Error("Nie udało się sprawdzić sesji.");
      const { csrfToken } = await session.json();
      const response = await fetch(`/api/notifications/${encodeURIComponent(item.id)}/read`, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "X-CSRF-Token": csrfToken } });
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw new Error("Nie udało się oznaczyć powiadomienia.");
      const result = await response.json();
      setItems(current => current.map(entry => entry.id === item.id ? { ...entry, readAt: result.readAt } : entry));
      const count = Math.max(0, unread - 1); setUnread(count); window.dispatchEvent(new CustomEvent("goldis:notifications-count", { detail: count }));
    } catch (cause) { setNotificationError(cause instanceof Error ? cause.message : "Nie udało się oznaczyć powiadomienia."); }
    finally { setBusy(""); }
  }
  if (!authenticated) return <SessionRequired returnTo="/dashboard" title="Sesja wygasła" description="Zaloguj się ponownie, aby wrócić do przeglądu." />;
  const visible = data?.operations.filter(operation => filter === "all" || (filter === "active" ? ["running", "queued"].includes(operation.status) : operation.status === filter)) ?? [];
  const operationHref = selected && (data?.actionRequired.find(item => item.id === selected.resultSetId)?.href ?? `/tools/oc-policy-verification?resultSetId=${encodeURIComponent(selected.resultSetId)}&step=results`);
  return <div className={`lead-app-shell${expanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={data?.role ?? null} pathname={pathname} onExpandedChange={setExpanded} canViewResults={Boolean(data?.tools.some(tool => tool.canViewResults))} canDiscoverTools={Boolean(data?.tools.length)} />
    <main className="gold-dashboard">
      <header className="gold-toolbar"><div className="gold-notifications" ref={popover}><button ref={trigger} type="button" className="gold-bell" aria-expanded={open} aria-controls="dashboard-notifications" onClick={() => setOpen(value => !value)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4" /></svg><span>Powiadomienia</span>{unread > 0 && <b aria-label={`${unread} nieprzeczytanych`}>{unread > 99 ? "99+" : unread}</b>}</button>{open && <section id="dashboard-notifications" className="gold-notification-panel" aria-label="Powiadomienia"><h2>Powiadomienia</h2><div className="gold-notification-scroll" tabIndex={0}>{notificationLoading ? <p>Wczytuję powiadomienia…</p> : notificationError ? <p role="alert">{notificationError}</p> : items.length ? items.map(item => <article className={item.readAt ? "" : "unread"} key={item.id}><strong>{item.title}</strong><p>{item.message}</p><time>{date(item.createdAt)}</time><div><a href={item.href} onClick={() => { if (!item.readAt) void markRead(item); }}>Otwórz</a>{!item.readAt && <button type="button" disabled={Boolean(busy)} onClick={() => void markRead(item)}>Oznacz jako przeczytane</button>}</div></article>) : <p>Nie masz jeszcze powiadomień.</p>}</div><a className="gold-notification-footer" href="/notifications">Wszystkie powiadomienia →</a></section>}</div><a className="gold-avatar" href="/account" aria-label="Moje konto">{data?.role === "admin" ? "A" : manager ? "M" : "P"}</a></header>
      <div className="gold-content"><div className="gold-heading"><div><h1>Przegląd operacji</h1><p>Uruchamiaj automatyzacje, analizuj wyniki i zarządzaj firmami.</p></div>{canRun && <a className="gold-button" href="/tools/oc-policy-verification">＋ Nowe sprawdzenie OC</a>}</div>
      {error ? <div role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Spróbuj ponownie</button></div> : !data ? <p role="status">Wczytuję dane przeglądu…</p> : <>
        <nav className="gold-flow" aria-label="Etapy pracy">{data.tools.length > 0 && <a href="/tools"><strong>⚙ Automatyzacje</strong><span>Uruchom narzędzie</span></a>}{canView && <a href="/results/oc-policy-verification"><strong>▤ Wyniki OC</strong><span>Przejrzyj gotowe zestawy</span></a>}{manager && canView ? <a href="/results/oc-policy-verification"><strong>♙ Przydział firm</strong><span>{data.metrics.team?.unassigned ?? 0} firm do przydzielenia w puli</span></a> : canView && <a href="/my-results"><strong>♙ Moje firmy</strong><span>{data.metrics.myLeads.notContacted} do kontaktu</span></a>}</nav>
        {canView && <section className="gold-operations"><div className="gold-section-heading"><h2>Ostatnie sprawdzenia OC</h2><a href="/runs">Wszystkie zadania firmowe →</a></div><div className="gold-workspace"><div className="gold-list"><div className="gold-filters" aria-label="Filtr statusu">{[["all", "Wszystkie"], ["waiting_attention", "Wymagają działania"], ["active", "W trakcie"], ["completed", "Zakończone"]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{value === "all" ? data.operations.length : data.operations.filter(operation => value === "active" ? ["running", "queued"].includes(operation.status) : operation.status === value).length}</span></button>)}</div><div className="gold-table-scroll"><table><thead><tr><th>Plik</th><th>Status</th><th>Gotowe wyniki</th></tr></thead><tbody>{visible.map(operation => <tr key={operation.id} className={selectedId === operation.id ? "selected" : ""}><td><button type="button" onClick={() => setSelectedId(operation.id)} aria-pressed={selectedId === operation.id}><strong>{operation.fileName || operation.toolName}</strong><small>{date(operation.updatedAt)}</small></button></td><td><span className={`gold-status ${operation.status}`}>● {statuses[operation.status] ?? operation.status}</span></td><td>{operation.readyCount}</td></tr>)}</tbody></table></div>{!visible.length && <p className="gold-empty">Brak sprawdzeń w tym widoku.</p>}</div><section className="gold-details" aria-label="Szczegóły sprawdzenia">{selected ? <><p>Wybrane sprawdzenie</p><h3>{selected.fileName || selected.toolName}</h3><small>{statuses[selected.status] ?? selected.status} · {date(selected.updatedAt)}</small><div className="gold-summary"><span>{selected.readyCount} gotowych wyników</span><span>{selected.failedCount} z błędem</span></div>{manager && selected.status === "completed" && <div className="gold-allocation"><strong>Przydział firm z tego zestawu</strong><p>{availabilityError || (availability === null ? "Sprawdzam dostępność…" : `${availability} firm do przydzielenia`)}</p></div>}<div className="gold-actions">{operationHref && <a className="gold-button" href={operationHref}>{selected.status === "waiting_attention" ? "Dokończ sprawdzanie" : "Otwórz wyniki"}</a>}{manager && selected.status === "completed" && <a className="gold-button primary" href={`/results/oc-policy-verification?resultSetId=${encodeURIComponent(selected.resultSetId)}`}>Przydziel firmy →</a>}</div></> : <p>Wybierz sprawdzenie, aby zobaczyć szczegóły.</p>}</section></div></section>}
        <section className="gold-tools"><h2>Narzędzia i sekcje</h2><nav>{data.tools.some(tool => tool.toolId === "commission-comparison" && (tool.canExecute || tool.canViewResults || tool.canDownloadResults)) && <a href="/tools/commission-comparison">Porównywarka prowizji →</a>}{canView && <a href="/imports">Historia importów →</a>}{manager && <a href="/reports">Raporty →</a>}{data.role === "reviewer" && <a href="/review">Weryfikacja danych →</a>}{data.role === "auditor" && <a href="/audit">Dziennik aktywności →</a>}</nav></section>
      </>}</div>
    </main>
  </div>;
}
