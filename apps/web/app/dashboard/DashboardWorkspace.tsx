"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import LeadSidebar from "../leads/LeadSidebar";
import "../leads/leads.css";
import "../leads/platform-pages.css";
import { useAutomationHealth } from "../lib/use-automation-health";

type Role = "admin" | "manager" | "operator" | "reviewer" | "auditor";
type Operation = {
  id: string; resultSetId: string; toolId: string; toolName: string; sourceType: string; sourceId: string;
  batchId: string; fileName: string | null; status: string; createdAt: string; updatedAt: string; finishedAt: string | null;
  leadCount: number; readyCount: number; failedCount: number;
};
type DashboardData = {
  role: Role;
  tools: { toolId: string; canExecute: boolean; canViewResults: boolean; canDownloadResults: boolean }[];
  metrics: {
    operations: { total: number; active: number; attention: number; completed: number };
    myLeads: { total: number; notContacted: number; accepted: number; notInterested: number };
    team: { unassigned: number; assigned: number; notContacted: number; accepted: number; notInterested: number } | null;
  };
  operations: Operation[];
  actionRequired: { id: string; toolName: string; fileName: string | null; createdAt: string; href: string }[];
  unreadNotifications: number;
};
type DashboardState =
  | { status: "loading" }
  | { status: "ready"; data: DashboardData }
  | { status: "error"; message: string };
type QuickLink = { href: string; title: string; description: string };

const operationStatus: Record<string, string> = {
  queued: "W kolejce", running: "W trakcie", waiting_attention: "Wymaga działania",
  completed: "Zakończona", cancelled: "Anulowana", failed: "Błąd",
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function getErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Nie udało się pobrać przeglądu.";
}

export default function DashboardWorkspace() {
  const pathname = usePathname();
  const [dashboardState, setDashboardState] = useState<DashboardState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  const [authenticated, setAuthenticated] = useState(true);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/dashboard", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (response.status === 401) { setAuthenticated(false); return; }
        if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "Nie udało się pobrać przeglądu.");
        setDashboardState({ status: "ready", data: payload as DashboardData });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setDashboardState({ status: "error", message: getErrorMessage(cause) });
      });

    return () => controller.abort();
  }, [refreshKey]);

  const data = dashboardState.status === "ready" ? dashboardState.data : null;
  const role = data?.role ?? null;
  const isManager = role === "manager" || role === "admin";
  const ocTool = data?.tools.find((tool) => tool.toolId === "oc-policy-verification");
  const canExecuteOc = (role === "admin" || role === "manager" || role === "operator") && ocTool?.canExecute === true;
  const canViewOc = role !== "auditor" && ocTool?.canViewResults === true;
  const primaryHref = canExecuteOc ? "/tools/oc-policy-verification" : canViewOc ? "/results/oc-policy-verification" : null;
  const primaryLabel = canExecuteOc ? "Przygotuj import OC" : canViewOc ? "Zobacz wyniki OC" : null;
  const automationHealth = useAutomationHealth(canExecuteOc);
  const metrics = data?.metrics;

  const quickLinks: QuickLink[] = data ? [
    ...(canViewOc ? [
      { href: "/results/oc-policy-verification", title: "Pula wyników OC", description: "Przeglądaj dostępne wyniki firm" },
      { href: "/imports", title: "Importy", description: "Sprawdź historię załadowanych plików" },
    ] : []),
    ...(role === "auditor"
      ? [{ href: "/audit", title: "Dziennik aktywności", description: "Sprawdź zdarzenia w platformie" }]
      : [{ href: "/my-results", title: "Moje wyniki", description: "Sprawdź przydzielone firmy i status rozmów" }]),
    { href: "/notifications", title: "Powiadomienia", description: `${data.unreadNotifications} nieprzeczytanych informacji` },
  ].filter((link) => link.href !== primaryHref) : [];

  if (!authenticated) return <main className="lead-auth-required"><h1>Zaloguj się, aby otworzyć przegląd</h1><a className="lead-primary" href="/">Przejdź do logowania</a></main>;

  return <div className={`lead-app-shell${sidebarExpanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={role} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <main className="lead-main">
      <header className="lead-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> PRZEGLĄD</span><span className="lead-topbar-name">Twoje miejsce pracy</span></div><div className="lead-topbar-actions"><a href="/notifications">Powiadomienia{data?.unreadNotifications ? ` · ${data.unreadNotifications}` : ""}</a><span className="lead-avatar">{role === "admin" ? "A" : role === "manager" ? "M" : "P"}</span></div></header>
      <div className="lead-content platform-content">
        <div className="lead-page-heading">
          <div><p className="lead-overline">CENTRUM OPERACYJNE <span>·</span> GOLDIS</p><h1>Przegląd</h1><p>Wróć do rozpoczętych operacji, sprawdź swoje zadania i przejdź prosto do dostępnych wyników.</p></div>
          {dashboardState.status === "loading" && <span className="platform-primary-placeholder" aria-hidden="true" />}
          {dashboardState.status === "ready" && primaryHref && primaryLabel && <div className="platform-primary-action">
            <a className="lead-primary" href={primaryHref}>{primaryLabel} <span aria-hidden="true">↗</span></a>
            {canExecuteOc && <p className={`platform-automation-status ${automationHealth.status === "checking" ? "is-checking" : automationHealth.status === "unknown" ? "is-unknown" : automationHealth.data?.automationReady ? "is-ready" : "is-waiting"}`} role="status" aria-live="polite">
              <span aria-hidden="true" />
              {automationHealth.status === "checking" ? "Sprawdzam gotowość automatyzacji…"
                : automationHealth.status === "unknown" ? automationHealth.message
                  : automationHealth.data?.automationReady ? "Automatyzacja gotowa."
                    : automationHealth.data?.message ?? "Automatyzacja jest niedostępna."}
            </p>}
          </div>}
          {dashboardState.status === "ready" && !primaryHref && <p className="platform-no-tool-access" role="status">Brak dostępu do weryfikacji OC. Skontaktuj się z administratorem organizacji.</p>}
        </div>

        {dashboardState.status === "loading" && <section className="platform-dashboard-loading" aria-busy="true" aria-label="Ładowanie przeglądu">
          <p role="status" aria-live="polite">Wczytuję dane przeglądu…</p>
          <div className="platform-loading-metrics" aria-hidden="true">{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>
          <div className="platform-loading-panels" aria-hidden="true"><span /><span /></div>
        </section>}

        {dashboardState.status === "error" && <section className="platform-dashboard-error" role="alert">
          <div><h2>Nie udało się pobrać przeglądu</h2><p>{dashboardState.message}</p></div>
          <button type="button" className="lead-secondary" onClick={() => {
            setDashboardState({ status: "loading" });
            setRefreshKey((current) => current + 1);
          }}>Spróbuj ponownie</button>
        </section>}

        {dashboardState.status === "ready" && data && metrics && <>
          <section className="lead-metrics platform-metrics" aria-label="Podsumowanie pracy">
            <article><span>Twoje operacje</span><strong>{metrics.operations.total}</strong><small>{metrics.operations.active} aktywnych teraz</small></article>
            <article className={metrics.operations.attention ? "metric-attention" : ""}><span>Wymagają działania</span><strong>{metrics.operations.attention}</strong><small>Operacje uruchomione przez Ciebie</small></article>
            <article><span>Moje leady</span><strong>{metrics.myLeads.total}</strong><small>{metrics.myLeads.notContacted} do kontaktu</small></article>
            {isManager ? <article><span>Wolna pula zespołu</span><strong>{metrics.team?.unassigned ?? 0}</strong><small>Gotowe leady do przydzielenia</small></article>
              : <article><span>Wyniki gotowe</span><strong>{metrics.operations.completed}</strong><small>Twoje zakończone operacje</small></article>}
          </section>

          <div className="platform-dashboard-grid">
            <div className="platform-dashboard-primary-column">
              <section className="lead-panel platform-action-panel">
                <div className="lead-section-heading"><div><p className="lead-overline">WYMAGA TWOJEJ UWAGI</p><h2>Do zrobienia</h2></div><a className="lead-inline-link" href="/runs">Wszystkie zadania →</a></div>
                {data.actionRequired.length ? <div className="platform-action-list">
                  {data.actionRequired.map((item) => <a key={item.id} className="platform-action-item" href={item.href}><span className="platform-alert-icon" aria-hidden="true">!</span><span><strong>{item.fileName || item.toolName}</strong><small>{item.toolName} · aktualizacja {formatDate(item.createdAt)}</small></span><b>Otwórz operację <i aria-hidden="true">→</i></b></a>)}
                </div> : <div className="platform-empty-line"><span className="platform-check" aria-hidden="true">✓</span><span><strong>Nie masz pilnych działań</strong><small>Gdy operacja będzie wymagała wznowienia, pojawi się tutaj.</small></span></div>}
              </section>

              <section className="lead-panel platform-operations-panel"><div className="lead-section-heading"><div><p className="lead-overline">OSTATNIE URUCHOMIENIA</p><h2>Twoje operacje</h2></div><a className="lead-inline-link" href="/runs">Historia zadań →</a></div>
                {data.operations.length ? <div className="platform-operation-list">{data.operations.map((operation) => <a key={operation.id} href={operation.status === "waiting_attention" ? "/runs" : `/results/oc-policy-verification?resultSetId=${encodeURIComponent(operation.resultSetId)}`} className="platform-operation-row"><span className={`platform-status-dot status-${operation.status}`} aria-hidden="true"/><span className="operation-primary"><strong>{operation.fileName || operation.toolName}</strong><small>{operation.toolName} · ID {operation.resultSetId.slice(0, 8)}</small></span><span className={`platform-status-text status-${operation.status}`}>{operationStatus[operation.status] ?? operation.status}</span><span className="operation-counts">{operation.readyCount} gotowych <small>· {operation.failedCount} z błędem</small></span><time>{formatDate(operation.createdAt)}</time><b aria-hidden="true">→</b></a>)}</div>
                  : <div className="platform-empty-line">Nie uruchomiono jeszcze żadnej automatyzacji. Dostępne działania znajdziesz powyżej.</div>}
              </section>
            </div>

            <section className="lead-panel platform-quick-panel"><div className="lead-section-heading"><div><p className="lead-overline">SZYBKIE PRZEJŚCIA</p><h2>Twoje narzędzia i wyniki</h2></div></div>
              <nav className="platform-shortcuts" aria-label="Szybkie przejścia">
                {quickLinks.map((link) => <a href={link.href} key={link.href}><span className="platform-shortcut-copy"><strong>{link.title}</strong><small>{link.description}</small></span><span aria-hidden="true">→</span></a>)}
              </nav>
            </section>
          </div>

          {isManager && metrics.team && <section className="lead-panel platform-team-panel"><div className="lead-section-heading"><div><p className="lead-overline">DYSTRYBUCJA LEADÓW</p><h2>Stan puli zespołu</h2></div><a className="lead-secondary" href="/results/oc-policy-verification">Otwórz pulę i przydziel →</a></div><div className="platform-team-stats"><article><span>W puli</span><strong>{metrics.team.unassigned}</strong></article><article><span>Przydzielone</span><strong>{metrics.team.assigned}</strong></article><article><span>Bez kontaktu</span><strong>{metrics.team.notContacted}</strong></article><article><span>Pozytywne</span><strong>{metrics.team.accepted}</strong></article><article><span>Brak zainteresowania</span><strong>{metrics.team.notInterested}</strong></article></div></section>}
        </>}
      </div>
    </main>
  </div>;
}
