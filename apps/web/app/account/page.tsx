"use client";

import { useEffect, useState, type FormEvent } from "react";
import { GoldisLogo } from "../../components/brand/GoldisLogo";

type Account = { username: string; role: string; csrfToken: string; mustChangePassword: boolean };
type Session = { sessionId: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null; browserLabel: string; isCurrent: boolean };

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Żądanie nie powiodło się (${response.status})`);
  return payload;
}

export default function AccountPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const me = await readJson<Account>(await fetch("/api/auth/me", { credentials: "same-origin" }));
      setAccount(me);
      const page = await readJson<{ items: Session[] }>(await fetch("/api/auth/sessions", { credentials: "same-origin" }));
      setSessions(page.items);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się odczytać bezpieczeństwa konta."); }
  }

  useEffect(() => { void load(); }, []);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    if (newPassword !== confirmPassword) { setError("Nowe hasła nie są zgodne."); return; }
    if (newPassword.length < 14) { setError("Nowe hasło musi mieć co najmniej 14 znaków."); return; }
    if (!account?.csrfToken) { setError("Brak tokenu bezpieczeństwa. Odśwież stronę."); return; }
    setBusy(true);
    try {
      const result = await readJson<{ csrfToken: string; mustChangePassword: boolean }>(await fetch("/api/auth/change-password", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": account.csrfToken },
        body: JSON.stringify({ currentPassword, newPassword }),
      }));
      setAccount({ ...account, csrfToken: result.csrfToken, mustChangePassword: false });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      setNotice("Hasło zmienione. Pozostałe sesje zostały cofnięte.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zmienić hasła."); }
    finally { setBusy(false); }
  }

  async function revoke(session: Session) {
    if (!account || session.isCurrent || !window.confirm("Natychmiast cofnąć wybraną sesję?")) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      await readJson(await fetch(`/api/auth/sessions/${session.sessionId}`, {
        method: "DELETE", credentials: "same-origin", headers: { "X-CSRF-Token": account.csrfToken },
      }));
      setNotice("Sesja cofnięta. Nie może już odczytywać danych ani pobierać wyników.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się cofnąć sesji."); }
    finally { setBusy(false); }
  }

  return <main className="account-shell">
    <header className="account-header"><a href="/" className="account-brand"><GoldisLogo variant="header" /><span className="account-brand-name">GOLDIS</span></a><nav><a href="/">Narzędzia</a>{account?.role === "admin" && <a href="/admin">Administracja</a>}</nav></header>
    <div className="account-content">
      <p className="eyebrow">KONTO I BEZPIECZEŃSTWO</p><h1>Twoje sesje,<br /><em>Twoje hasło.</em></h1>
      {error && <p className="admin-alert" role="alert">{error}</p>}{notice && <p className="admin-notice" role="status">{notice}</p>}
      {account?.mustChangePassword && <div className="account-required" role="alert"><strong>Wymagana zmiana hasła</strong><span>To konto ma hasło tymczasowe. Zmień je, aby korzystać z narzędzi.</span></div>}
      <section className="account-card"><div className="admin-card-head"><div><h2>Zmień hasło</h2><p>Minimum 14 znaków. Po zmianie pozostałe sesje zostaną wylogowane.</p></div><span className="admin-counter">{account?.username ?? "Ładowanie konta…"}</span></div>
        <form className="admin-form" onSubmit={changePassword}><label className="admin-field">Obecne hasło<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><div className="account-password-row"><label className="admin-field">Nowe hasło<input type="password" autoComplete="new-password" minLength={14} maxLength={1024} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><label className="admin-field">Powtórz nowe hasło<input type="password" autoComplete="new-password" minLength={14} maxLength={1024} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label></div><button className="admin-button" disabled={busy || !account}>Zapisz nowe hasło</button></form>
      </section>
      <section className="account-card"><div className="admin-card-head"><div><h2>Aktywne sesje</h2><p>Każda sesja jest sprawdzana po stronie serwera. Cofnięcie działa od następnego żądania.</p></div><span className="admin-counter">{sessions.filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > Date.now()).length} aktywnych</span></div>
        <div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Sesje bieżącego konta; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Urządzenie i przeglądarka</th><th>Utworzona</th><th>Ostatnia aktywność</th><th>Wygasa</th><th>Status</th><th /></tr></thead><tbody>{sessions.map((item) => <tr key={item.sessionId}><td>{item.browserLabel}</td><td>{new Date(item.createdAt).toLocaleString("pl-PL")}</td><td>{new Date(item.lastSeenAt).toLocaleString("pl-PL")}</td><td>{new Date(item.expiresAt).toLocaleString("pl-PL")}</td><td>{item.revokedAt ? "Cofnięta" : Date.parse(item.expiresAt) <= Date.now() ? "Wygasła" : item.isCurrent ? "Bieżąca sesja" : "Aktywna"}</td><td>{!item.isCurrent && !item.revokedAt && Date.parse(item.expiresAt) > Date.now() && <button className="admin-quiet danger" disabled={busy} onClick={() => void revoke(item)}>Cofnij sesję</button>}</td></tr>)}</tbody></table>{sessions.length === 0 && <p className="admin-empty">Nie znaleziono sesji.</p>}</div>
      </section>
      <p className="account-back"><a href="/">← Powrót do platformy</a></p>
    </div>
  </main>;
}
