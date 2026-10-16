"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { usePathname } from "next/navigation";
import LeadSidebar from "../leads/LeadSidebar";
import "../leads/leads.css";
import "../leads/platform-pages.css";
import "../team/team.css";
import "./reports.css";

type Me = { role: string };
type ContactReport = {
  period: { from: string; to: string; description: string };
  summary: { total: number; unassigned: number; assigned: number; notContacted: number; accepted: number; notInterested: number };
  employees: { userId: string; username: string; membershipStatus: string; assigned: number; notContacted: number; accepted: number; notInterested: number }[];
};
type OperationsReport = {
  counts: { sourceRows: number; canonicalGroups: number; submissions: number; actualRuns: number; created: number; completed: number; noPolicies: number; failed: number; inProgress: number; downloads: number; generated: number; openInterventions: number };
  completionRate: number | null; durationSeconds: { median: number | null; p90: number | null }; medianResolvedInterventionSeconds: number | null;
};
type MeWithRole = Me & { role: "admin" | "manager" | "operator" | "reviewer" | "auditor" };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || `Żądanie nie powiodło się (${response.status})`);
  return data;
}
function dateInput(date: Date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
function instantAtLocalMidnight(value: string) { return new Date(`${value}T00:00:00`).toISOString(); }

export default function ReportsWorkspace() {
  const pathname = usePathname();
  const today = new Date();
  const [from, setFrom] = useState(dateInput(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(dateInput(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)));
  const [me, setMe] = useState<MeWithRole | null>(null);
  const [contacts, setContacts] = useState<ContactReport | null>(null);
  const [operations, setOperations] = useState<OperationsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState("");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  const load = useCallback(async (rangeFrom = from, rangeTo = to) => {
    setLoading(true); setError("");
    try {
      const current = await readJson<MeWithRole>(await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }));
      setMe(current);
      if (current.role !== "manager" && current.role !== "admin") { setAccessDenied(true); return; }
      setAccessDenied(false);
      const params = new URLSearchParams({ from: instantAtLocalMidnight(rangeFrom), to: instantAtLocalMidnight(rangeTo) });
      const [contactData, operationsData] = await Promise.all([
        readJson<ContactReport>(await fetch(`/api/contact-reports/overview?${params}`, { credentials: "same-origin", cache: "no-store" })),
        readJson<OperationsReport>(await fetch(`/api/admin/reports/overview?${params}`, { credentials: "same-origin", cache: "no-store" })),
      ]);
      setContacts(contactData); setOperations(operationsData);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać raportów."); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { void load(); }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (from >= to) { setError("Data końcowa musi być późniejsza od początkowej."); return; }
    void load(from, to);
  }

  const summary = contacts?.summary;
  if (accessDenied) return <main className="lead-auth-required"><h1>Ta sekcja jest dostępna dla menedżera</h1><a className="lead-primary" href="/dashboard">Wróć do przeglądu</a></main>;

  return <div className={`lead-app-shell${sidebarExpanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={me?.role ?? null} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <main className="lead-main">
      <header className="lead-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> ORGANIZACJA</span><span className="lead-topbar-name">Raporty</span></div><a href="/account">Moje konto</a></header>
      <div className="lead-content platform-content reports-page">
        <div className="lead-page-heading"><div><h1>Raporty</h1><p>Stan obsługi leadów oraz przebieg automatyzacji w wybranym okresie.</p></div></div>
        {error && <p className="lead-feedback" role="alert">{error}</p>}
        <form className="lead-panel reports-filter" onSubmit={submit}><label className="admin-field">Utworzono od<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label><label className="admin-field">Do (wyłącznie)<input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></label><button className="lead-primary" disabled={loading}>Pokaż raport</button><p>Okres wybiera leady według daty utworzenia. Statusy pokazują ich bieżący stan, a nie historię liczby telefonów.</p></form>
        <section className="reports-section"><div className="lead-section-heading"><div><span className="access-note-label">OBSŁUGA KLIENTÓW</span><h2>Wyniki kontaktu</h2></div><a className="lead-inline-link" href="/results/oc-policy-verification">Otwórz wspólną pulę</a></div>
          <div className="reports-kpis"><article><span>Leadów w okresie</span><strong>{loading ? "—" : summary?.total ?? 0}</strong><small>{summary?.unassigned ?? 0} wolnych w puli</small></article><article><span>Przydzielone</span><strong>{loading ? "—" : summary?.assigned ?? 0}</strong><small>Aktualny przydział</small></article><article><span>Bez kontaktu</span><strong>{loading ? "—" : summary?.notContacted ?? 0}</strong><small>Wśród leadów z okresu</small></article><article><span>Zainteresowani</span><strong>{loading ? "—" : summary?.accepted ?? 0}</strong><small>Zgadzają się na ofertę</small></article><article><span>Niezainteresowani</span><strong>{loading ? "—" : summary?.notInterested ?? 0}</strong><small>Według bieżącego statusu</small></article></div>
          <div className="lead-panel reports-table-panel"><div className="lead-section-heading"><div><h3>Podsumowanie według osoby</h3><p>Przydziały osób, które obsługują leady.</p></div></div><div className="team-table-wrap" role="region" aria-label="Raport kontaktów według pracownika" tabIndex={0}><table className="team-table"><thead><tr><th>Osoba</th><th>Przydzielone</th><th>Nie kontaktowano</th><th>Zainteresowany</th><th>Niezainteresowany</th><th>Status konta</th></tr></thead><tbody>{contacts?.employees.map((employee) => <tr key={employee.userId}><td><strong>{employee.username}</strong></td><td>{employee.assigned}</td><td>{employee.notContacted}</td><td>{employee.accepted}</td><td>{employee.notInterested}</td><td>{employee.membershipStatus === "active" ? "Aktywne" : "Wyłączone"}</td></tr>)}{!loading && !contacts?.employees.length && <tr><td colSpan={6}><div className="team-empty">Brak przydzielonych leadów w wybranym okresie.</div></td></tr>}</tbody></table></div></div>
        </section>
        <section className="reports-section"><div className="lead-section-heading"><div><span className="access-note-label">AUTOMATYZACJA</span><h2>Raport operacyjny</h2></div><a className="lead-inline-link" href="/admin#reports">Szczegóły administracyjne</a></div>
          <div className="reports-kpis reports-operational-kpis"><article><span>Operacje utworzone</span><strong>{loading ? "—" : operations?.counts.created ?? 0}</strong></article><article><span>Ukończone</span><strong>{loading ? "—" : operations?.counts.completed ?? 0}</strong></article><article><span>Brak pasujących polis</span><strong>{loading ? "—" : operations?.counts.noPolicies ?? 0}</strong></article><article><span>Błędy</span><strong>{loading ? "—" : operations?.counts.failed ?? 0}</strong></article><article><span>Wymaga działania</span><strong>{loading ? "—" : operations?.counts.openInterventions ?? 0}</strong></article><article><span>Wygenerowane pliki</span><strong>{loading ? "—" : operations?.counts.generated ?? 0}</strong></article></div>
          <p className="reports-footnote">Raport operacyjny liczy uruchomienia i zakończenia według ich właściwych dat. „Brak pasujących polis” nie jest błędem.</p>
        </section>
      </div>
    </main>
  </div>;
}
