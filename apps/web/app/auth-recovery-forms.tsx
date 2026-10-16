"use client";

import { useEffect, useState, type FormEvent } from "react";
import { GoldisLogo } from "../components/brand/GoldisLogo";

type RecoveryMode = "request" | "reset" | "verify";
type RecoveryState = "checking" | "enabled" | "disabled" | "unavailable";

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || `Żądanie nie powiodło się (${response.status})`);
  return payload;
}

export default function AuthRecoveryForm({ mode }: { mode: RecoveryMode }) {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [serviceState, setServiceState] = useState<RecoveryState>(mode === "request" ? "checking" : "enabled");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (mode === "request") {
      let active = true;
      fetch("/api/auth/recovery-status", { cache: "no-store", credentials: "same-origin" })
        .then((response) => readJson<{ enabled: boolean }>(response))
        .then((result) => { if (active) setServiceState(result.enabled ? "enabled" : "disabled"); })
        .catch(() => { if (active) setServiceState("unavailable"); });
      return () => { active = false; };
    }
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const supplied = fragment.get("token");
    window.history.replaceState(window.history.state, "", window.location.pathname);
    setToken(supplied && /^[A-Za-z0-9_-]{43}$/.test(supplied) ? supplied : null);
  }, [mode]);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice(""); setBusy(true);
    try {
      await readJson(await fetch("/api/auth/forgot-password", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      }));
      setNotice("Jeśli istnieje aktywne konto z tym adresem, wyślemy link do ustawienia nowego hasła.");
      setEmail("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się przyjąć zgłoszenia."); }
    finally { setBusy(false); }
  }

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    if (!token) { setError("Nie znaleziono tokenu w tym otwarciu strony. Otwórz ponownie link z wiadomości."); return; }
    if (password !== confirmPassword) { setError("Hasła nie są takie same."); return; }
    if ([...password].length < 15) { setError("Hasło musi mieć co najmniej 15 znaków."); return; }
    setBusy(true);
    try {
      await readJson(await fetch("/api/auth/reset-password", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, newPassword: password }),
      }));
      setToken(null); setPassword(""); setConfirmPassword("");
      setNotice("Hasło zostało zmienione. Zaloguj się nowym hasłem; wcześniejsze sesje zostały wylogowane.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się zmienić hasła."); }
    finally { setBusy(false); }
  }

  async function verifyEmail() {
    setError(""); setNotice("");
    if (!token) { setError("Nie znaleziono tokenu w tym otwarciu strony. Otwórz ponownie link z wiadomości."); return; }
    setBusy(true);
    try {
      await readJson(await fetch("/api/auth/verify-recovery-email", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      }));
      setToken(null); setNotice("Adres odzyskiwania został potwierdzony.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się potwierdzić adresu."); }
    finally { setBusy(false); }
  }

  const title = mode === "request" ? "Odzyskaj dostęp" : mode === "reset" ? "Ustaw nowe hasło" : "Potwierdź adres";
  const description = mode === "request"
    ? "Podaj firmowy adres przypisany do Twojego konta. Wyślemy link, jeśli adres jest zweryfikowany."
    : mode === "reset" ? "Ustaw nowe hasło. Link jest jednorazowy i ważny przez 15 minut."
      : "Potwierdzenie aktywuje ten adres jako sposób odzyskiwania konta.";

  return <main className="auth-recovery-shell">
    <section className="auth-recovery-brand" aria-label="Goldis">
      <a className="auth-recovery-logo" href="/"><GoldisLogo variant="header" /><span>GOLDIS</span></a>
      <p className="eyebrow">KONTO I BEZPIECZEŃSTWO</p>
      <h1>{mode === "verify" ? <>Adres,<br /><em>który należy do Ciebie.</em></> : <>Bezpieczny powrót<br /><em>do Twojego konta.</em></>}</h1>
      <p>Link działa tylko raz. Po zmianie hasła trzeba zalogować się ponownie.</p>
      <div className="auth-recovery-rule"><span aria-hidden="true">G</span><small>GOLDIS · DOSTĘP DO PLATFORMY</small></div>
    </section>
    <section className="auth-recovery-panel">
      <p className="eyebrow">{mode === "request" ? "PRZYPOMNIENIE HASŁA" : mode === "reset" ? "NOWE HASŁO" : "WERYFIKACJA ADRESU"}</p>
      <h2>{title}</h2><p className="auth-recovery-description">{description}</p>
      {error && <p className="auth-recovery-alert" role="alert">{error}</p>}
      {notice && <p className="auth-recovery-notice" role="status" aria-live="polite">{notice}</p>}
      {mode === "request" && serviceState === "checking" && <p className="auth-recovery-muted" role="status">Sprawdzam dostępność tej funkcji…</p>}
      {mode === "request" && serviceState === "disabled" && <p className="auth-recovery-muted" role="status">Odzyskiwanie hasła nie jest jeszcze włączone. Skontaktuj się z administratorem organizacji.</p>}
      {mode === "request" && serviceState === "unavailable" && <p className="auth-recovery-muted" role="status">Nie mogę teraz sprawdzić dostępności. Spróbuj później lub skontaktuj się z administratorem.</p>}
      {mode === "request" && serviceState === "enabled" && <form className="auth-recovery-form" onSubmit={(event) => void submitRequest(event)}>
        <label>Adres e-mail<input type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <button type="submit" disabled={busy}>{busy ? "Wysyłam zgłoszenie…" : "Wyślij link"}</button>
      </form>}
      {mode === "reset" && token && <form className="auth-recovery-form" onSubmit={(event) => void submitReset(event)}>
        <label>Nowe hasło<input type="password" autoComplete="new-password" minLength={15} maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <label>Powtórz nowe hasło<input type="password" autoComplete="new-password" minLength={15} maxLength={1024} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
        <small>Minimum 15 znaków. Po zmianie zaloguj się ponownie.</small>
        <button type="submit" disabled={busy}>{busy ? "Zapisuję hasło…" : "Ustaw nowe hasło"}</button>
      </form>}
      {mode === "reset" && !token && !notice && <p className="auth-recovery-muted" role="status">Link nie zawiera tokenu albo strona została odświeżona. Otwórz ponownie oryginalny link z wiadomości.</p>}
      {mode === "verify" && token && <div className="auth-recovery-form"><button type="button" disabled={busy} onClick={() => void verifyEmail()}>{busy ? "Potwierdzam…" : "Potwierdź adres e-mail"}</button><small>Wiadomość została otwarta bez zmiany konta. Kliknij, aby potwierdzić adres.</small></div>}
      {mode === "verify" && !token && !notice && <p className="auth-recovery-muted" role="status">Link nie zawiera tokenu albo strona została odświeżona. Otwórz ponownie oryginalny link z wiadomości.</p>}
      <p className="auth-recovery-back"><a href={notice && mode === "reset" ? "/" : "/"}>Wróć do logowania <span aria-hidden="true">→</span></a></p>
    </section>
  </main>;
}
