"use client";

import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { usePathname } from "next/navigation";
import { performPrivilegedMutation } from "../lib/privileged-action";
import LeadSidebar from "../leads/LeadSidebar";
import "../leads/leads.css";
import "../leads/platform-pages.css";
import "./team.css";

type Employee = {
  userId: string; username: string; status: "active" | "disabled"; membershipStatus: string;
  createdAt: string; lastLoginAt: string | null; activeSessionCount: number; leadCount: number; canExecuteOc: boolean;
  hasVerifiedRecoveryEmail: boolean;
};
type Me = { role: string; csrfToken: string };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || `Żądanie nie powiodło się (${response.status})`);
  return data;
}

function dateLabel(value: string | null) {
  if (!value) return "Jeszcze się nie logował";
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium" }).format(new Date(value));
}

export default function TeamWorkspace() {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState({ username: "", temporaryPassword: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [recoveryEmailDraft, setRecoveryEmailDraft] = useState("");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  const load = useCallback(async (search: string) => {
    setLoading(true); setError("");
    try {
      const user = await readJson<Me>(await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }));
      setMe(user);
      if (user.role !== "manager" && user.role !== "admin") { setAccessDenied(true); return; }
      setAccessDenied(false);
      const params = new URLSearchParams(); if (search.trim()) params.set("q", search.trim());
      const result = await readJson<{ items: Employee[] }>(await fetch(`/api/team/users${params.size ? `?${params}` : ""}`, { credentials: "same-origin", cache: "no-store" }));
      setItems(result.items);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać pracowników."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(""); }, [load]);

  async function createEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!me?.csrfToken) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await performPrivilegedMutation({ csrfToken: me.csrfToken, action: "team.user.create", targetId: null,
        url: "/team/users", method: "POST", payload: draft });
      setDraft({ username: "", temporaryPassword: "" }); setNotice("Konto pracownika zostało utworzone. Przy pierwszym logowaniu zmieni hasło."); await load("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się utworzyć pracownika."); }
    finally { setBusy(false); }
  }

  async function updateStatus(employee: Employee) {
    if (!me?.csrfToken) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await performPrivilegedMutation({ csrfToken: me.csrfToken, action: "team.user.status", targetId: employee.userId,
        url: `/team/users/${encodeURIComponent(employee.userId)}/status`, method: "PATCH",
        payload: { status: employee.status === "active" ? "disabled" : "active" } });
      setNotice(employee.status === "active" ? "Konto wyłączone, aktywne sesje zostały cofnięte." : "Konto pracownika zostało aktywowane."); await load(query);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zmienić statusu konta."); }
    finally { setBusy(false); }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>, employee: Employee) {
    event.preventDefault(); if (!me?.csrfToken) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await performPrivilegedMutation<{ revokedSessions: number }>({ csrfToken: me.csrfToken,
        action: "team.user.password", targetId: employee.userId,
        url: `/team/users/${encodeURIComponent(employee.userId)}/password`, method: "POST",
        payload: { temporaryPassword: passwordDraft } });
      setPasswordDraft(""); setNotice(`Ustawiono hasło tymczasowe i cofnięto ${result.revokedSessions} sesji.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zresetować hasła."); }
    finally { setBusy(false); }
  }

  async function setRecoveryEmail(event: FormEvent<HTMLFormElement>, employee: Employee) {
    event.preventDefault(); if (!me?.csrfToken) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await performPrivilegedMutation({ csrfToken: me.csrfToken, action: "team.user.recovery-email", targetId: employee.userId,
        url: `/team/users/${encodeURIComponent(employee.userId)}/recovery-email`, method: "POST", payload: { email: recoveryEmailDraft } });
      setRecoveryEmailDraft(""); setNotice("Link potwierdzający został zlecony. Dotychczasowy adres pozostaje aktywny do potwierdzenia nowego."); await load(query);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zlecić zmiany adresu."); }
    finally { setBusy(false); }
  }

  async function sendResetLink(employee: Employee) {
    if (!me?.csrfToken) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await performPrivilegedMutation({ csrfToken: me.csrfToken, action: "team.user.recovery-link", targetId: employee.userId,
        url: `/team/users/${encodeURIComponent(employee.userId)}/password-reset-link`, method: "POST", payload: {} });
      setNotice("Link do ustawienia hasła został zlecony. Status nie oznacza jeszcze dostarczenia wiadomości.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zlecić linku."); }
    finally { setBusy(false); }
  }

  if (accessDenied) return <main className="lead-auth-required"><h1>Ta sekcja jest dostępna dla menedżera</h1><a className="lead-primary" href="/dashboard">Wróć do przeglądu</a></main>;

  return <div className={`lead-app-shell${sidebarExpanded ? "" : " is-collapsed"}`}>
    <LeadSidebar role={(me?.role as "admin" | "manager" | "operator" | "reviewer" | "auditor") ?? null} pathname={pathname} onExpandedChange={setSidebarExpanded} />
    <main className="lead-main">
      <header className="lead-topbar"><div><span className="lead-overline">GOLDIS <i>/</i> ORGANIZACJA</span><span className="lead-topbar-name">Pracownicy</span></div><a href="/account">Moje konto</a></header>
      <div className="lead-content platform-content team-page">
        <div className="lead-page-heading"><div><h1>Pracownicy</h1><p>Twórz konta pracowników i zarządzaj ich dostępem do uruchamiania automatyzacji.</p></div><a className="lead-secondary" href="/access">Otwórz dostęp do narzędzi</a></div>
        {error && <p className="lead-feedback" role="alert">{error}</p>}{notice && <p className="team-notice" role="status">{notice}</p>}

        <section className="lead-panel team-create-panel">
          <div className="lead-section-heading"><div><h2>Dodaj pracownika</h2><p>Nowe konto otrzyma rolę pracownika i będzie wymagać zmiany hasła przy pierwszym logowaniu.</p></div></div>
          <form className="team-create-form" onSubmit={(event) => void createEmployee(event)}>
            <label className="admin-field">Login<input autoComplete="off" maxLength={128} value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} required /></label>
            <label className="admin-field">Hasło tymczasowe<input type="password" autoComplete="new-password" minLength={15} maxLength={1024} value={draft.temporaryPassword} onChange={(event) => setDraft({ ...draft, temporaryPassword: event.target.value })} required /><small>Minimum 15 znaków.</small></label>
            <button className="lead-primary" disabled={busy || !me}>Utwórz konto</button>
          </form>
        </section>

        <section className="lead-panel team-list-panel">
          <div className="lead-section-heading"><div><h2>Lista pracowników</h2><p>{items.length} kont · zarządzanie dotyczy wyłącznie kont o roli pracownika.</p></div></div>
          <form className="team-search" onSubmit={(event) => { event.preventDefault(); void load(query); }}><label className="admin-field">Szukaj pracownika<input type="search" maxLength={128} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Wpisz login" /></label><button className="lead-secondary" disabled={loading}>Szukaj</button></form>
          <div className="team-table-wrap" role="region" aria-label="Pracownicy; przewiń poziomo, aby zobaczyć pełną tabelę" tabIndex={0}>
            <table className="team-table"><thead><tr><th>Pracownik</th><th>Status konta</th><th>Adres odzyskiwania</th><th>Ostatnie logowanie</th><th>Przydzielone leady</th><th>Uruchamianie OC</th><th /></tr></thead>
              <tbody>{items.map((employee) => <Fragment key={employee.userId}><tr>
                <td><strong>{employee.username}</strong><small>Utworzono {dateLabel(employee.createdAt)} · {employee.activeSessionCount} aktywnych sesji</small></td>
                <td><span className={`team-status ${employee.status}`}>{employee.status === "active" ? "Aktywne" : "Wyłączone"}</span></td>
                <td>{employee.hasVerifiedRecoveryEmail ? "Zweryfikowany" : "Brak"}</td>
                <td>{dateLabel(employee.lastLoginAt)}</td><td>{employee.leadCount}</td><td>{employee.canExecuteOc ? "Dozwolone" : "Brak dostępu"}</td>
                <td><button type="button" className="lead-secondary team-manage-button" aria-expanded={expandedId === employee.userId} onClick={() => { setExpandedId(expandedId === employee.userId ? null : employee.userId); setPasswordDraft(""); }}>Zarządzaj</button></td>
              </tr>{expandedId === employee.userId && <tr><td className="team-edit-cell" colSpan={7}>
                <div className="team-edit-panel"><div><strong>{employee.username}</strong><p>Zmiany konta nie przenoszą przypisanych leadów.</p></div>
                  <button type="button" className="lead-secondary" disabled={busy} onClick={() => void updateStatus(employee)}>{employee.status === "active" ? "Wyłącz konto" : "Aktywuj konto"}</button>
                  <button type="button" className="lead-secondary" disabled={busy || !employee.hasVerifiedRecoveryEmail} onClick={() => void sendResetLink(employee)}>Wyślij link do resetu</button>
                  <form className="team-password-form" onSubmit={(event) => void setRecoveryEmail(event, employee)}><label className="admin-field">Adres odzyskiwania<input type="email" autoComplete="email" maxLength={254} value={recoveryEmailDraft} onChange={(event) => setRecoveryEmailDraft(event.target.value)} required /></label><button className="lead-secondary" disabled={busy}>Ustaw adres i wyślij weryfikację</button></form>
                  <form className="team-password-form" onSubmit={(event) => void resetPassword(event, employee)}><label className="admin-field">Nowe hasło tymczasowe<input type="password" autoComplete="new-password" minLength={15} maxLength={1024} value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} required /></label><button className="lead-secondary" disabled={busy}>Resetuj hasło</button></form>
                </div>
              </td></tr>}</Fragment>)}
              {!loading && items.length === 0 && <tr><td colSpan={7}><div className="team-empty">Nie znaleziono pracowników. Dodaj konto lub zmień wyszukiwaną frazę.</div></td></tr>}
              {loading && <tr><td colSpan={7}><div className="team-empty">Pobieram listę pracowników…</div></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  </div>;
}
