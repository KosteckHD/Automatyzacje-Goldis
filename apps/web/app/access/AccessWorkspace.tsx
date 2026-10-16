"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { performPrivilegedMutation } from "../lib/privileged-action";
import LeadSidebar from "../leads/LeadSidebar";
import "../leads/leads.css";
import "../leads/platform-pages.css";
import "../team/team.css";
import "./access.css";

type Employee = { userId: string; username: string; status: string; canExecuteOc: boolean };
type Me = { role: string; csrfToken: string };
type Access = { canExecute: boolean; version: number; resultsShared: boolean; canDownloadResults: boolean };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || `Żądanie nie powiodło się (${response.status})`);
  return data;
}

export default function AccessWorkspace() {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accessByUser, setAccessByUser] = useState<Record<string, Access>>({});
  const [busyUser, setBusyUser] = useState("");
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const current = await readJson<Me>(await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }));
      setMe(current);
      if (current.role !== "manager" && current.role !== "admin") { setAccessDenied(true); return; }
      setAccessDenied(false);
      const { items } = await readJson<{ items: Employee[] }>(await fetch("/api/team/users", { credentials: "same-origin", cache: "no-store" }));
      setEmployees(items);
      const active = items.filter((item) => item.status === "active");
      const entries = await Promise.all(active.map(async (employee) => [employee.userId,
        await readJson<Access>(await fetch(`/api/team/users/${encodeURIComponent(employee.userId)}/access`, { credentials: "same-origin", cache: "no-store" }))] as const));
      setAccessByUser(Object.fromEntries(entries));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się odczytać dostępów."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function changeAccess(employee: Employee) {
    const current = accessByUser[employee.userId];
    if (!current || !me?.csrfToken || busyUser) return;
    setBusyUser(employee.userId); setError(""); setNotice("");
    try {
      const next = await performPrivilegedMutation<Access & { version: number }>({ csrfToken: me.csrfToken,
        action: "team.user.access", targetId: employee.userId,
        url: `/team/users/${encodeURIComponent(employee.userId)}/access`, method: "PUT",
        payload: { canExecute: !current.canExecute, expectedVersion: current.version } });
      setAccessByUser((items) => ({ ...items, [employee.userId]: next }));
      setNotice(`Zapisano uprawnienie uruchamiania dla ${employee.username}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zmienić dostępu."); void load(); }
    finally { setBusyUser(""); }
  }

  if (accessDenied) return <main className="lead-auth-required"><h1>Ta sekcja jest dostępna dla menedżera</h1><a className="lead-primary" href="/dashboard">Wróć do przeglądu</a></main>;

  return <div className={`lead-app-shell${sidebarExpanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={(me?.role as "admin" | "manager" | "operator" | "reviewer" | "auditor") ?? null} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <main className="lead-main">
      <header className="lead-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> ORGANIZACJA</span><span className="lead-topbar-name">Dostępy</span></div><a href="/account">Moje konto</a></header>
      <div className="lead-content platform-content team-page">
        <div className="lead-page-heading"><div><h1>Dostępy do narzędzi</h1><p>Przydzielaj pracownikom prawo do uruchomienia automatyzacji.</p></div><a className="lead-secondary" href="/team">Zarządzaj pracownikami</a></div>
        {error && <p className="lead-feedback" role="alert">{error}</p>}{notice && <p className="team-notice" role="status">{notice}</p>}
        <section className="lead-panel access-scope-note"><div><span className="access-note-label">WSPÓLNY ODCZYT</span><h2>Wyniki automatyzacji OC</h2><p>Aktywni pracownicy mogą przeglądać szczegółowe wyniki i pobierać pliki. To ustawienie jest niezależne od prawa uruchamiania automatyzacji.</p></div><span className="team-status active">Dostęp dla zespołu</span></section>
        <section className="lead-panel team-list-panel">
          <div className="lead-section-heading"><div><h2>Uruchamianie automatyzacji OC</h2><p>Zmiany dostępu zapisują się od razu i są przypisane do konkretnego konta.</p></div></div>
          <div className="access-list">{loading ? <p className="team-empty">Pobieram uprawnienia…</p> : employees.filter((employee) => employee.status === "active").map((employee) => {
            const access = accessByUser[employee.userId];
            return <article className="access-row" key={employee.userId}><div><strong>{employee.username}</strong><small>Pracownik · odczyt wyników i pobieranie pozostają włączone dla aktywnego konta</small></div>
              <label className="access-switch"><span>{access?.canExecute ? "Może uruchamiać" : "Bez prawa uruchamiania"}</span><input type="checkbox" checked={Boolean(access?.canExecute)} disabled={!access || busyUser === employee.userId} onChange={() => void changeAccess(employee)} /><span className="access-switch-track" aria-hidden="true" /></label>
            </article>;
          })}{!loading && employees.every((employee) => employee.status !== "active") && <p className="team-empty">Nie ma aktywnych kont pracowników.</p>}</div>
        </section>
      </div>
    </main>
  </div>;
}
