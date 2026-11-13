"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import LeadSidebar from "../leads/LeadSidebar";
import SessionRequired from "../../components/ui/SessionRequired";
import "../leads/leads.css";
import "../leads/platform-pages.css";

type Role = "admin" | "manager" | "operator" | "reviewer" | "auditor" | null;
type Notification = { id: string; eventType: "result_ready" | "action_required"; title: string; message: string; href: string; resultSetId: string; createdAt: string; readAt: string | null };
type Payload = { unreadCount: number; items: Notification[] };

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pl-PL", { dateStyle: "long", timeStyle: "short" }).format(date);
}

export default function NotificationWorkspace() {
  const pathname = usePathname();
  const [role, setRole] = useState<Role>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [payload, setPayload] = useState<Payload>({ unreadCount: 0, items: [] });
  const payloadRef = useRef(payload);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [sessionRetry, setSessionRetry] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const pendingReads = useRef(new Set<string>());
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    let requestSignal = signal;
    if (!requestSignal) {
      loadController.current?.abort();
      loadController.current = new AbortController();
      requestSignal = loadController.current.signal;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/notifications?limit=50", { credentials: "same-origin", cache: "no-store", signal: requestSignal });
      const next = await response.json().catch(() => ({}));
      if (requestSignal.aborted) return;
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw new Error(typeof next.message === "string" ? next.message : "Nie udało się pobrać powiadomień.");
      payloadRef.current = next as Payload;
      setPayload(payloadRef.current);
      window.dispatchEvent(new CustomEvent("goldis:notifications-count", { detail: Number(next.unreadCount) || 0 }));
    } catch (cause) { if (!requestSignal.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać powiadomień."); }
    finally { if (!requestSignal.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setSessionError("");
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { if (active) { setAuthenticated(false); setLoading(false); } return; }
      if (!response.ok) { if (active) { setSessionError("Nie udało się sprawdzić sesji. Spróbuj ponownie."); setLoading(false); } return; }
      const session = await response.json() as { role?: Role; csrfToken?: string };
      if (!active) return;
      setRole(session.role ?? null); setCsrfToken(session.csrfToken ?? ""); setAuthenticated(true); void load(controller.signal);
    }).catch(() => { if (active && !controller.signal.aborted) { setSessionError("Nie udało się połączyć, aby sprawdzić sesję. Spróbuj ponownie."); setLoading(false); } });
    return () => { active = false; controller.abort(); loadController.current?.abort(); };
  }, [load, sessionRetry]);

  async function markRead(item: Notification, quiet = false): Promise<boolean> {
    if (item.readAt || pendingReads.current.has(item.id)) return true;
    if (!csrfToken) return false;
    pendingReads.current.add(item.id);
    setBusyId(item.id); setError("");
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(item.id)}/read`, {
        method: "POST", credentials: "same-origin", keepalive: true, headers: { "X-CSRF-Token": csrfToken },
      });
      if (response.status === 401) { setAuthenticated(false); return false; }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : "Nie udało się zapisać powiadomienia.");
      const readAt = typeof result.readAt === "string" ? result.readAt : new Date().toISOString();
      const current = payloadRef.current;
      const wasUnread = current.items.some((candidate) => candidate.id === item.id && !candidate.readAt);
      const unreadCount = Math.max(0, current.unreadCount - Number(wasUnread));
      payloadRef.current = { unreadCount, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, readAt } : candidate) };
      setPayload(payloadRef.current);
      window.dispatchEvent(new CustomEvent("goldis:notifications-count", { detail: unreadCount }));
      return true;
    } catch (cause) { if (!quiet) setError(cause instanceof Error ? cause.message : "Nie udało się zapisać powiadomienia."); }
    finally { pendingReads.current.delete(item.id); setBusyId(""); }
    return false;
  }

  if (authenticated === false) return <SessionRequired returnTo={pathname} title="Sesja wygasła" description="Zaloguj się ponownie, aby wrócić do powiadomień." />;
  if (sessionError) return <main className="lead-auth-required"><h1>Nie udało się sprawdzić sesji</h1><p>{sessionError}</p><button className="lead-primary" type="button" onClick={() => setSessionRetry((value) => value + 1)}>Spróbuj ponownie</button></main>;
  if (authenticated === null) return <main className="lead-loading" role="status">Sprawdzam sesję…</main>;
  return <div className={`lead-app-shell${sidebarExpanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={role} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <main className="lead-main">
      <header className="lead-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> POWIADOMIENIA</span><span className="lead-topbar-name">Aktualności Twoich operacji</span></div><div className="lead-topbar-actions"><a href="/dashboard">Przegląd</a><span className="lead-avatar">{role === "admin" ? "A" : role === "manager" ? "M" : "P"}</span></div></header>
      <div className="lead-content platform-content">
        <div className="lead-page-heading"><div><p className="lead-overline">TWOJE KONTO <span>·</span> ALERTY OPERACYJNE</p><h1>Powiadomienia</h1><p>Informacje o uruchomionych przez Ciebie automatyzacjach. Inne osoby nie otrzymują Twoich alertów.</p></div><span className="lead-count-tag">{payload.unreadCount} nieprzeczytanych</span></div>
        {error && <p className="lead-feedback" role="alert">{error}</p>}
        <section className="lead-panel platform-notifications-panel">
          <div className="lead-section-heading"><div><p className="lead-overline">CENTRUM POWIADOMIEŃ</p><h2>Ostatnie informacje</h2></div><button type="button" className="lead-secondary" disabled={loading} onClick={() => void load()}>Odśwież</button></div>
          {loading ? <div className="platform-empty-line">Pobieram powiadomienia…</div> : payload.items.length ? <div className="platform-notification-list">{payload.items.map((item) => <article key={item.id} className={`platform-notification-item${item.readAt ? " is-read" : " is-unread"}`}>
            <span className={`notification-mark ${item.eventType}`} aria-hidden="true">{item.eventType === "result_ready" ? "✓" : "!"}</span>
            <div className="notification-copy"><div className="notification-title-row"><h3>{item.title}</h3>{!item.readAt && <span>NOWE</span>}</div><p>{item.message}</p><small>{formatDate(item.createdAt)} · operacja {item.resultSetId.slice(0, 8)}</small></div>
            <div className="notification-actions"><a className="lead-secondary" href={item.href} onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || item.readAt) return;
              void markRead(item, true);
            }}>Otwórz</a>{!item.readAt && <button type="button" className="notification-read-button" disabled={busyId === item.id} onClick={() => void markRead(item)}>{busyId === item.id ? "Zapisuję…" : "Oznacz jako przeczytane"}</button>}</div>
          </article>)}</div> : <div className="platform-empty-state"><span aria-hidden="true">◉</span><h2>Na razie jest spokojnie</h2><p>Gdy wynik będzie gotowy albo operacja będzie wymagała działania, powiadomienie pojawi się tutaj.</p><a className="lead-inline-link" href="/dashboard">Wróć do przeglądu →</a></div>}
        </section>
      </div>
    </main>
  </div>;
}
