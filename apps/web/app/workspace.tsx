"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import EnrichmentReviewPanel from "./enrichment-review";
import RunSubmissionLauncher from "./run-submission-launcher";
import { GoldisLogo } from "../components/brand/GoldisLogo";
import SpotlightCard from "../components/react-bits/SpotlightCard";
import { RunStepper } from "../components/tools/RunStepper";

type ImportResult = { id: string; totalRows: number; invalidRows: number; readyRows: number; sha256: string };
type ImportRow = { rowNumber: number; companyName: string; decisionMakerName: string | null; regon: string; issues: string[] };
type Run = { id: string; batchId?: string; rowNumber: number; status: string; currentStep: string; referenceDate: string; errorCode: string | null; manualDataVersion?: number; createdAt: string; incident?: { kind: string; portal: string | null; reasonCode: string | null; fieldCode?: string | null; createdAt: string; retryAllowed?: boolean; canResumeAuth?: boolean; canResumeReview?: boolean } | null; policyCounts?: { totalOcCount: number; currentOcCount: number } | null; artifactAvailable?: boolean; events?: { status: string; step: string; errorCode: string | null; createdAt: string }[] };
type AuthChallenge = { challengeId: string; runId: string; portal: "pzu" | "compensa"; status: "active" | "claimed" | "submitted"; expiresAt: string; serverNow?: string; attemptCount: number; attemptLimit: number; reasonCode?: string };
type Intervention = {
  interventionId: string; runId: string; batchId: string; rowNumber: number; kind: string; portal: "pzu" | "compensa" | null;
  reasonCode: string | null; fieldCode: string | null; status: string; revision: number; createdAt: string; updatedAt: string;
  challenge: AuthChallenge | null; isUnread: boolean; canSubmitSms: boolean; canResumeReview: boolean;
  assigneeUserId?: string | null; isAssignedToMe?: boolean; runStatus?: string;
  canResumeAuth?: boolean;
};
type InterventionSummary = { openCount: number; unreadCount: number; smsCount: number };
type AutomationHealth = { automationReady: boolean; servicesReady: boolean; worker: string; portalMode: string; portalConfig: string; message: string };
type ToolAccess = { toolId: string; canDiscover: boolean; canExecute: boolean; canViewResults: boolean; canDownloadResults: boolean };
type CatalogTool = { toolId: string; displayName: string; description: string; status: "available" | "maintenance" | "disabled"; access: ToolAccess };
const runLabels: Record<string, string> = {
  queued: "W kolejce", validating: "Sprawdzanie danych", awaiting_portal_adapter: "Oczekuje na adapter portali",
  pzu_login: "Logowanie do Everest", waiting_for_sms: "Oczekuje na kod SMS", everest_search: "Wyszukiwanie w Everest",
  identity_review: "Wymaga potwierdzenia osoby", compensa_login: "Logowanie do Compensy", compensa_form: "Uzupełnianie formularza Compensy",
  waiting_for_manual_data: "Wstrzymano: wymaga interwencji", ufg_verification: "Weryfikacja UFG", reading_oc: "Odczyt polis OC",
  export_ready: "Przygotowywanie pliku", no_matching_policies: "Brak aktualnych polis OC", completed: "Zakończono",
  cancelled: "Anulowano", failed: "Błąd",
};
const roleLabels = { admin: "Administrator", operator: "Operator", reviewer: "Recenzent", auditor: "Audytor" } as const;
const interventionLabels: Record<string, string> = {
  sms: "Kod SMS", identity_review: "Weryfikacja tożsamości", portal_error: "Błąd portalu",
  SMS_TIMEOUT: "Kod wygasł", SMS_DELIVERY_UNCERTAIN: "Niepewne przekazanie kodu", PORTAL_FAILURE: "Błąd automatyzacji",
  SMS_REQUIRED: "Potwierdź logowanie kodem SMS", SMS_CODE_REJECTED: "Portal odrzucił kod SMS",
  SMS_ATTEMPT_LIMIT: "Limit prób kodu SMS został wykorzystany", PORTAL_SESSION_EXPIRED: "Sesja portalu wymaga sprawdzenia",
  MANUAL_DATA_REQUIRED: "Brakujące dane", IDENTITY_AMBIGUOUS: "Niejednoznaczna osoba", IDENTITY_NOT_FOUND: "Nie znaleziono osoby",
};
const manualFieldLabels: Record<string, string> = {
  ADDRESS: "Adres", POSTAL_CODE: "Kod pocztowy", CITY: "Miejscowość", COUNTY: "Kod opcji powiatu z portalu", EXPECTED_PERSON: "Oczekiwana osoba (imię i nazwisko)",
};

function SmsChallengePanel({
  challenge,
  runId,
  csrfToken,
  onAccepted,
  onRefresh,
  onUnauthorized,
  reasonCode, canResend, resending, onResend,
}: {
  challenge: AuthChallenge | null;
  runId: string;
  csrfToken: string;
  onAccepted: (attemptCount: number) => void;
  onRefresh: () => void;
  onUnauthorized: () => void;
  reasonCode?: string | null; canResend?: boolean; resending?: boolean; onResend?: () => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [deliveryUncertain, setDeliveryUncertain] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expiryRefreshed = useRef<string | null>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const expiredNow = Boolean(challenge && Date.parse(challenge.expiresAt) <= now);
  useEffect(() => {
    if (!expiredNow || !challenge || challenge.status !== "active") return;
    setCode("");
    if (expiryRefreshed.current !== challenge.challengeId) {
      expiryRefreshed.current = challenge.challengeId;
      refreshRef.current();
    }
  }, [expiredNow, challenge?.challengeId, challenge?.status]);

  useEffect(() => {
    if (!challenge || challenge.status !== "active") return;
    const parsedServerNow = challenge.serverNow ? Date.parse(challenge.serverNow) : Number.NaN;
    const clockOffset = Number.isFinite(parsedServerNow) ? parsedServerNow - Date.now() : 0;
    const timer = window.setInterval(() => setNow(Date.now() + clockOffset), 1000);
    return () => window.clearInterval(timer);
  }, [challenge?.challengeId, challenge?.status, challenge?.serverNow]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || !csrfToken || submitting || Date.parse(challenge.expiresAt) <= now) return;
    let codeForRequest = code.trim();
    setCode("");
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch(`/api/auth-challenges/${challenge.challengeId}/code`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ runId, code: codeForRequest }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string; attemptCount?: number };
      if (!response.ok) {
        if (response.status === 401) { onUnauthorized(); return; }
        if (response.status === 403) { setError("Nie masz uprawnienia do przekazania kodu."); return; }
        setError(payload.message || (response.status === 410 ? "Kod wygasł. Odśwież zadanie, aby sprawdzić stan logowania." : "Nie udało się przekazać kodu."));
        if (response.status === 503) setDeliveryUncertain(true);
        if (response.status === 410 || response.status === 503 || response.status === 409) onRefresh();
        return;
      }
      onAccepted(payload.attemptCount ?? challenge.attemptCount + 1);
    } catch {
      setError("Nie potwierdzono dostarczenia kodu. Sprawdzam stan zadania; nie wysyłaj ponownie tego samego kodu.");
      setDeliveryUncertain(true);
      onRefresh();
    } finally {
      codeForRequest = "";
      setCode("");
      setSubmitting(false);
    }
  }

  const resendAction = canResend && onResend ? <button type="button" disabled={resending || submitting} onClick={onResend}>{resending ? "Oczekiwanie na ponowienie…" : "Wyślij jeden dodatkowy kod SMS"}</button> : null;
  if (!challenge) return <div className="sms-challenge" role="status">
    <p>{reasonCode === "SMS_TIMEOUT" ? "Kod wygasł. Automatyzacja jest wstrzymana." : reasonCode === "SMS_DELIVERY_UNCERTAIN" ? "Nie potwierdzono dostarczenia kodu. Administrator musi sprawdzić sesję; nie wysyłaj tego samego kodu ponownie." : reasonCode === "SMS_ATTEMPT_LIMIT" ? "Limit prób został wykorzystany. Potrzebna jest kontrola administratora." : "Oczekiwanie na aktywne wyzwanie SMS workera…"}</p>
    {resendAction}
    {reasonCode === "SMS_TIMEOUT" && !canResend && <p>Ponowienie wymaga uprawnienia i dostępnego limitu dodatkowej próby.</p>}
  </div>;
  const expired = Date.parse(challenge.expiresAt) <= now;
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000));
  const countdown = `${Math.floor(remainingSeconds / 60).toString().padStart(2, "0")}:${(remainingSeconds % 60).toString().padStart(2, "0")}`;
  const portalName = challenge.portal === "pzu" ? "PZU Everest" : "Compensa";

  return <section className="sms-challenge" aria-labelledby="sms-title" aria-live="polite">
    <div className="sms-heading"><div><p className="eyebrow">POTWIERDZENIE LOGOWANIA</p><h3 id="sms-title">Kod SMS · {portalName}</h3></div><span className="pill warn">Próba {challenge.attemptCount + 1}/{challenge.attemptLimit}</span></div>
    {(challenge.reasonCode ?? reasonCode) === "SMS_CODE_REJECTED" ? <p role="alert">Portal odrzucił poprzedni kod. Sprawdź aktualny SMS i wpisz kod ponownie w pozostałym czasie albo poproś o jeden dodatkowy SMS.</p> : challenge.portal === "pzu" && <p>PZU wymaga potwierdzenia logowania. Sesja mogła wygasnąć lub urządzenie wymaga ponownego uwierzytelnienia.</p>}
    {deliveryUncertain ? <p role="alert">Przekazanie kodu wymaga sprawdzenia. <button type="button" onClick={onRefresh}>Sprawdź zgłoszenie</button></p> : challenge.status === "submitted" || challenge.status === "claimed" ? <p role="status">Kod przekazano do sesji przeglądarki. Oczekiwanie na odpowiedź portalu…</p> : expired ? <p className="error" role="alert">Kod wygasł. <button type="button" onClick={onRefresh}>Sprawdź zgłoszenie</button></p> : <>
      <p>Wpisz kod otrzymany od portalu. Czas na wpisanie: <strong aria-live="off">{countdown}</strong>. Pozostało prób wpisania: {Math.max(0, challenge.attemptLimit - challenge.attemptCount)}.</p>
      <form className="sms-form" onSubmit={submit}>
        <label htmlFor="sms-code">Kod weryfikacyjny</label>
        <input id="sms-code" name="sms-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4,10}" maxLength={10} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 10))} required disabled={submitting || expired} aria-describedby="sms-help" autoFocus />
        <small id="sms-help">Kod jest wysyłany jednorazowo i po wysłaniu pole zostanie wyczyszczone.</small>
        <button type="submit" disabled={submitting || !csrfToken || code.length < 4}>{submitting ? "Przekazywanie…" : "Przekaż kod"}</button>
      </form>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {challenge.status === "active" && !deliveryUncertain && resendAction}
    {resendAction && <small>To jawna próba. Worker zaczeka do 25 sekund na dostępność RESEND; nowy formularz ma nowy termin ważności. SMS nie jest wysyłany automatycznie.</small>}
  </section>;
}

function SmsDialog({ challenge, runId, csrfToken, onAccepted, onRefresh, onUnauthorized, onClose, reasonCode, canResend, resending, onResend }: {
  challenge: AuthChallenge | null; runId: string; csrfToken: string;
  onAccepted: (attemptCount: number) => void; onRefresh: () => void; onUnauthorized: () => void; onClose: () => void;
  reasonCode?: string | null; canResend?: boolean; resending?: boolean; onResend?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const input = dialogRef.current?.querySelector<HTMLElement>("input:not([disabled])");
      const close = dialogRef.current?.querySelector<HTMLElement>("button[aria-label='Zamknij okno kodu']");
      (input ?? close)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [challenge?.challengeId, challenge?.status]);
  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), a[href]") ?? [])];
    if (!nodes.length) { event.preventDefault(); return; }
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="sms-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="sms-modal" role="dialog" aria-modal="true" aria-label="Wprowadź kod SMS" onKeyDown={trapFocus}>
      <button className="sms-modal-close" type="button" onClick={onClose} aria-label="Zamknij okno kodu">×</button>
      <SmsChallengePanel key={challenge?.challengeId ?? "waiting"} challenge={challenge} runId={runId} csrfToken={csrfToken} onAccepted={onAccepted}
        onRefresh={onRefresh} onUnauthorized={onUnauthorized} reasonCode={reasonCode} canResend={canResend} resending={resending} onResend={onResend} />
    </div>
  </div>;
}

export default function Workspace() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [userRole, setUserRole] = useState<"admin" | "operator" | "reviewer" | "auditor" | null>(null);
  const [toolAccess, setToolAccess] = useState<ToolAccess[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogTool[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [isCatalogLanding, setIsCatalogLanding] = useState(false);
  const [resourceLocationVersion, setResourceLocationVersion] = useState(0);
  const [csrfToken, setCsrfToken] = useState("");
  const [username, setUsername] = useState("");
  const [activeNav, setActiveNav] = useState("workspace-start");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [rowPage, setRowPage] = useState(1);
  const [rowState, setRowState] = useState<"all" | "ready" | "review">("all");
  const [runNumber, setRunNumber] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [activeChallenge, setActiveChallenge] = useState<AuthChallenge | null>(null);
  const [smsModalRunId, setSmsModalRunId] = useState<string | null>(null);
  const [authResuming, setAuthResuming] = useState(false);
  const [authRetryPendingRunId, setAuthRetryPendingRunId] = useState<string | null>(null);
  const authResumeLock = useRef(false);
  const [assignedSmsRunId, setAssignedSmsRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState("");
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [interventionSummary, setInterventionSummary] = useState<InterventionSummary>({ openCount: 0, unreadCount: 0, smsCount: 0 });
  const [interventionError, setInterventionError] = useState("");
  const [interventionCursor, setInterventionCursor] = useState<string | null>(null);
  const [loadingMoreInterventions, setLoadingMoreInterventions] = useState(false);
  const [interventionRefreshToken, setInterventionRefreshToken] = useState(0);
  const [automationHealth, setAutomationHealth] = useState<AutomationHealth | null>(null);
  const [manualValue, setManualValue] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [manualSaving, setManualSaving] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileDrawerRef = useRef<HTMLDivElement | null>(null);
  const smsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeToolAccess = toolAccess.find((item) => item.toolId === "oc-policy-verification") ?? null;
  const canDiscoverTool = activeToolAccess?.canDiscover === true;
  const canOperate = activeToolAccess?.canExecute === true;
  const canViewResults = activeToolAccess?.canViewResults === true;
  const canDownloadResults = activeToolAccess?.canDownloadResults === true;
  const canSeeInterventions = Boolean(activeToolAccess && (canOperate || canViewResults));

  useEffect(() => {
    if (!authRetryPendingRunId) return;
    if (activeChallenge?.runId === authRetryPendingRunId || !authenticated
      || (selectedRun?.id === authRetryPendingRunId && ["waiting_for_manual_data", "cancelled", "failed"].includes(selectedRun.status))) {
      setAuthRetryPendingRunId(null);
    }
  }, [authRetryPendingRunId, activeChallenge?.runId, authenticated, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    const syncActiveSection = () => {
      const section = window.location.hash.slice(1);
      setActiveNav(["workspace-start", "workspace-import", "workspace-runs", "workspace-result"].includes(section) ? section : "workspace-start");
    };
    syncActiveSection();
    window.addEventListener("hashchange", syncActiveSection);
    return () => window.removeEventListener("hashchange", syncActiveSection);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsCatalogLanding(window.location.pathname === "/" && !params.has("import") && !params.has("run"));
  }, []);

  useEffect(() => {
    if (!authenticated || !isCatalogLanding) return;
    const controller = new AbortController();
    fetch("/api/tools", { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { setAuthenticated(false); return; }
      const payload = await response.json().catch(() => ({})) as { items?: CatalogTool[]; message?: string };
      if (!response.ok) throw new Error(payload.message || "Nie udało się pobrać katalogu narzędzi.");
      setCatalogItems(Array.isArray(payload.items) ? payload.items : []);
      setCatalogError("");
    }).catch((cause) => { if (!controller.signal.aborted) setCatalogError(cause instanceof Error ? cause.message : "Katalog jest chwilowo niedostępny."); });
    return () => controller.abort();
  }, [authenticated, isCatalogLanding]);

  useEffect(() => {
    if (!authenticated || !isCatalogLanding) return;
    const target = new URLSearchParams(window.location.search).get("returnTo");
    if (!target || !target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return;
    let parsed: URL;
    try { parsed = new URL(target, window.location.origin); } catch { return; }
    const validReturn = parsed.origin === window.location.origin && (
      ["/imports", "/runs", "/results", "/audit", "/tools/oc-policy-verification"].includes(parsed.pathname)
      || parsed.pathname.startsWith("/imports/") || parsed.pathname.startsWith("/runs/")
    );
    if (!validReturn) return;
    window.location.replace(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  }, [authenticated, isCatalogLanding]);

  useEffect(() => {
    const onPopState = () => {
      setResourceLocationVersion((current) => current + 1);
      const section = window.location.hash.slice(1);
      setActiveNav(["workspace-start", "workspace-import", "workspace-runs", "workspace-result"].includes(section) ? section : "workspace-start");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function closeSmsDialog() {
    setSmsModalRunId(null);
    setAssignedSmsRunId(null);
    setActiveChallenge(null);
    window.requestAnimationFrame(() => smsTriggerRef.current?.focus());
  }

  function closeMobileNav(restoreFocus = true) {
    setMobileNavOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  }

  function trapMobileNavFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); closeMobileNav(); return; }
    if (event.key !== "Tab") return;
    const nodes = [...(mobileDrawerRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [])];
    if (!nodes.length) { event.preventDefault(); return; }
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => mobileDrawerRef.current?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { credentials: "same-origin" }).then(async (response) => {
      if (!active) return;
      if (!response.ok) {
        setAuthenticated(false);
        return;
      }
      const session = await response.json() as { csrfToken?: string; role?: "admin" | "operator" | "reviewer" | "auditor"; mustChangePassword?: boolean; tools?: ToolAccess[] };
      if (active) {
        if (session.mustChangePassword) { window.location.assign("/account?required=1"); return; }
        setCsrfToken(typeof session.csrfToken === "string" ? session.csrfToken : "");
        setUserRole(session.role ?? null);
        setToolAccess(Array.isArray(session.tools) ? session.tools : []);
        setAuthenticated(true);
      }
    }).catch(() => { if (active) setAuthenticated(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authenticated || !userRole || !canSeeInterventions) return;
    let active = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let failures = 0;
    let running = false;
    const schedule = (delay: number) => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void refresh(); }, delay);
    };
    const refresh = async () => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      running = true;
      controller = new AbortController();
      try {
        const signal = controller.signal;
        const [summaryResponse, listResponse] = await Promise.all([
          fetch("/api/interventions/summary", { credentials: "same-origin", signal }),
          fetch("/api/interventions?status=open&limit=20", { credentials: "same-origin", signal }),
        ]);
        if (summaryResponse.status === 401 || listResponse.status === 401) {
          setAuthenticated(false); setMobileNavOpen(false); setCsrfToken(""); setActiveChallenge(null); setSmsModalRunId(null);
          return;
        }
        if (summaryResponse.status === 403 || listResponse.status === 403) throw new Error("Brak uprawnienia do centrum zgłoszeń.");
        if (!summaryResponse.ok || !listResponse.ok) throw new Error("Centrum zgłoszeń jest chwilowo niedostępne.");
        const [summary, page] = await Promise.all([summaryResponse.json(), listResponse.json()]) as [InterventionSummary, { items: Intervention[]; nextCursor?: string | null }];
        if (!active || signal.aborted) return;
        setInterventionSummary(summary);
        setInterventions(Array.isArray(page.items) ? page.items : []);
        setInterventionCursor(page.nextCursor ?? null);
        setInterventionError("");
        failures = 0;
      } catch (cause) {
        if (active && !controller?.signal.aborted) {
          setInterventionError(cause instanceof Error ? cause.message : "Nie udało się odświeżyć zgłoszeń.");
          failures += 1;
        }
      } finally {
        running = false;
        controller = null;
        const delay = failures === 0 ? 20_000 : Math.min(failures, 3) * 20_000;
        schedule(delay);
      }
    };
    const onResume = () => schedule(0);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    void refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [authenticated, userRole, interventionRefreshToken, canSeeInterventions]);

  useEffect(() => {
    if (!authenticated || !canDiscoverTool) { setAutomationHealth(null); return; }
    let active = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let running = false;
    const poll = async () => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/health/automation", { credentials: "same-origin", signal: controller.signal });
        const payload = await response.json().catch(() => null) as AutomationHealth | null;
        if (active && payload && typeof payload.message === "string") setAutomationHealth(payload);
        else if (active) setAutomationHealth({ automationReady: false, servicesReady: false, worker: "unknown", portalMode: "unknown", portalConfig: "unavailable", message: "Nie udało się odczytać gotowości usług." });
      } catch {
        if (active && !controller.signal.aborted) setAutomationHealth({ automationReady: false, servicesReady: false, worker: "unknown", portalMode: "unknown", portalConfig: "unavailable", message: "API nie odpowiada." });
      } finally {
        running = false;
        controller = null;
        if (active && document.visibilityState === "visible" && navigator.onLine) timer = window.setTimeout(() => void poll(), 15_000);
      }
    };
    const resume = () => { if (timer !== null) window.clearTimeout(timer); timer = null; void poll(); };
    void poll();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [authenticated, canDiscoverTool]);

  useEffect(() => {
    if (!authenticated || !canViewResults) return;
    const id = new URLSearchParams(window.location.search).get("import");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    let active = true;
    Promise.all([
      fetch(`/api/imports/${id}`, { credentials: "same-origin" }),
      fetch(`/api/imports/${id}/rows`, { credentials: "same-origin" }),
    ]).then(async ([summary, preview]) => {
      if (!active) return;
      if (summary.status === 401 || preview.status === 401) { setAuthenticated(false); return; }
      if (!summary.ok) throw new Error(summary.status === 404 ? "Import nie istnieje lub nie jest dostępny dla tego konta." : "Nie udało się otworzyć importu.");
      if (!preview.ok) throw new Error("Nie udało się wczytać wierszy importu.");
      setResult(await summary.json());
      setRows(await preview.json());
      setError("");
      setRunError("");
    }).catch((cause) => { if (active) setRunError(cause instanceof Error ? cause.message : "Nie udało się otworzyć importu."); });
    return () => { active = false; };
  }, [authenticated, canViewResults, resourceLocationVersion]);

  useEffect(() => {
    if (!authenticated || !canViewResults) return;
    const runId = new URLSearchParams(window.location.search).get("run");
    if (!runId) { setSelectedRun(null); return; }
    if (!/^[0-9a-f-]{36}$/i.test(runId)) { setRunError("Nieprawidłowy identyfikator zadania."); return; }
    let active = true;
    const controller = new AbortController();
    const loadLinkedRun = async () => {
      try {
        const runResponse = await fetch(`/api/runs/${runId}`, { credentials: "same-origin", signal: controller.signal });
        const runPayload = await runResponse.json().catch(() => ({})) as Run & { message?: string };
        if (!runResponse.ok) throw new Error(runPayload.message || (runResponse.status === 404 ? "Zadanie nie istnieje lub nie jest dostępne dla tego konta." : "Nie udało się odczytać zadania."));
        if (!active) return;
        setSelectedRun(runPayload);
        setRuns((current) => [runPayload, ...current.filter((item) => item.id !== runPayload.id)]);
        setRunError("");
        if (!runPayload.batchId) return;
        const [summaryResponse, rowsResponse] = await Promise.all([
          fetch(`/api/imports/${runPayload.batchId}`, { credentials: "same-origin", signal: controller.signal }),
          fetch(`/api/imports/${runPayload.batchId}/rows`, { credentials: "same-origin", signal: controller.signal }),
        ]);
        if (!summaryResponse.ok || !rowsResponse.ok) throw new Error("Import powiązany z zadaniem nie jest dostępny dla tego konta.");
        if (!active) return;
        setResult(await summaryResponse.json());
        setRows(await rowsResponse.json());
      } catch (cause) {
        if (active && !controller.signal.aborted) setRunError(cause instanceof Error ? cause.message : "Nie udało się pobrać zadania.");
      }
    };
    void loadLinkedRun();
    return () => { active = false; controller.abort(); };
  }, [authenticated, canViewResults, resourceLocationVersion]);

  useEffect(() => {
    if (!authenticated || !canViewResults || !result?.id) return;
    let active = true;
    fetch(`/api/imports/${result.id}/rows?page=${rowPage}&state=${rowState}`, { credentials: "same-origin" })
      .then(async (response) => { if (active && response.ok) setRows(await response.json()); })
      .catch(() => { if (active) setRows([]); });
    return () => { active = false; };
  }, [authenticated, canViewResults, result?.id, rowPage, rowState]);

  useEffect(() => {
    if (!authenticated || !canViewResults || !result?.id) return;
    let active = true;
    fetch(`/api/runs?batchId=${result.id}`, { credentials: "same-origin" })
      .then(async (response) => { if (active && response.ok) setRuns(await response.json()); })
      .catch(() => {});
    return () => { active = false; };
  }, [authenticated, canViewResults, result?.id]);

  const hasRunningJob = runs.some((run) => ["queued", "validating", "awaiting_portal_adapter", "pzu_login", "everest_search",
    "waiting_for_sms", "compensa_login", "compensa_form", "ufg_verification", "reading_oc", "export_ready"].includes(run.status));
  const selectedRunId = selectedRun?.id ?? null;
  const selectedRunStatus = selectedRun?.status ?? null;
  useEffect(() => {
    if (!authenticated || !canViewResults || !result?.id || !hasRunningJob) return;
    let active = true;
    let running = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let failures = 0;
    const batchId = result.id;
    const schedule = (delay: number) => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void refresh(); }, delay);
    };
    const refresh = async () => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/runs?batchId=${batchId}`, { credentials: "same-origin", signal: controller.signal });
        if (response.status === 401) { setAuthenticated(false); setMobileNavOpen(false); setCsrfToken(""); setActiveChallenge(null); setSmsModalRunId(null); return; }
        if (!response.ok) throw new Error("Nie udało się odświeżyć zadań.");
        const updated = await response.json() as Run[];
        if (!active || controller.signal.aborted) return;
        setRuns(updated);
        setSelectedRun((current) => current?.batchId === batchId ? updated.find((run) => run.id === current.id) ?? current : current);
        failures = 0;
      } catch {
        if (active && !controller?.signal.aborted) failures += 1;
      } finally {
        running = false;
        controller = null;
        schedule(failures === 0 ? 20_000 : Math.min(failures, 3) * 20_000);
      }
    };
    const onResume = () => schedule(0);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    void refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [authenticated, canViewResults, result?.id, hasRunningJob]);

  useEffect(() => {
    if (!authenticated || !canViewResults || !selectedRunId || !["queued", "validating", "awaiting_portal_adapter", "pzu_login", "everest_search", "waiting_for_sms", "compensa_login", "compensa_form", "ufg_verification", "reading_oc", "export_ready"].includes(selectedRunStatus ?? "")) return;
    let active = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let running = false;
    let failures = 0;
    const schedule = (delay: number) => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void refresh(); }, delay);
    };
    const refresh = async () => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/runs/${selectedRunId}`, { credentials: "same-origin", signal: controller.signal });
        if (response.status === 401) { setAuthenticated(false); setMobileNavOpen(false); setCsrfToken(""); setActiveChallenge(null); setSmsModalRunId(null); return; }
        if (!active || !response.ok) throw new Error("Nie udało się odświeżyć zadania.");
        const updated = await response.json() as Run;
        setSelectedRun(updated);
        setRuns((current) => current.map((run) => run.id === updated.id ? updated : run));
        failures = 0;
      } catch {
        if (active && !controller?.signal.aborted) failures += 1;
      } finally {
        running = false;
        controller = null;
        schedule(failures === 0 ? 10_000 : Math.min(failures, 6) * 10_000);
      }
    };
    const onResume = () => schedule(0);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    schedule(10_000);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [authenticated, canViewResults, selectedRunId, selectedRunStatus]);

  useEffect(() => {
    const targetRunId = assignedSmsRunId ?? selectedRun?.id;
    if (!targetRunId || (!assignedSmsRunId && selectedRun?.status !== "waiting_for_sms")) {
      setActiveChallenge(null);
      return;
    }
    let active = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let running = false;
    let failures = 0;
    const runId = targetRunId;
    const schedule = (delay: number) => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void refresh(); }, delay);
    };
    const refresh = async () => {
      if (!active || running || document.visibilityState !== "visible" || !navigator.onLine) return;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/auth-challenges?runId=${encodeURIComponent(runId)}`, { credentials: "same-origin", signal: controller.signal });
        if (response.status === 401) { setAuthenticated(false); setMobileNavOpen(false); setCsrfToken(""); setActiveChallenge(null); setSmsModalRunId(null); return; }
        if (response.status === 403) { closeSmsDialog(); setActiveChallenge(null); setAssignedSmsRunId(null); setInterventionError("Uprawnienie do wpisania SMS zostało cofnięte."); return; }
        if (!response.ok) throw new Error("Challenge status unavailable");
        const challenge = await response.json() as AuthChallenge | null;
        if (!active || controller.signal.aborted) return;
        setActiveChallenge(challenge);
        failures = 0;
      } catch {
        if (active && !controller?.signal.aborted) failures += 1;
      } finally {
        running = false;
        controller = null;
        schedule(failures === 0 ? 5_000 : Math.min(failures, 3) * 10_000);
      }
    };
    const onResume = () => schedule(0);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    void refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [assignedSmsRunId, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!assignedSmsRunId && smsModalRunId && selectedRun?.id === smsModalRunId
      && ["completed", "cancelled", "failed", "no_matching_policies"].includes(selectedRun.status)) closeSmsDialog();
  }, [smsModalRunId, assignedSmsRunId, selectedRun?.id, selectedRun?.status]);

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!result) return;
    setWorking(true);
    setRunError("");
    try {
      const response = await fetch("/api/runs", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ batchId: result.id, rowNumber: Number(runNumber) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Nie udało się utworzyć zadania.");
      const run = payload as Run;
      setSelectedRun(run);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : "Nie udało się utworzyć zadania.");
    } finally { setWorking(false); }
  }

  async function showRun(id: string): Promise<Run | null> {
    try {
      const response = await fetch(`/api/runs/${id}`, { credentials: "same-origin" });
      if (response.ok) {
        const run = await response.json() as Run;
        setSelectedRun(run);
        const params = new URLSearchParams(window.location.search);
        params.set("run", id);
        if (run.batchId) params.set("import", run.batchId);
        window.history.pushState({}, "", `${window.location.pathname}?${params}`);
        setResourceLocationVersion((current) => current + 1);
        return run;
      }
    } catch { setRunError("Nie udało się odczytać historii zadania."); }
    return null;
  }

  async function openIntervention(item: Intervention) {
    setInterventionError("");
    smsTriggerRef.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    try {
      const readResponse = await fetch(`/api/interventions/${item.interventionId}/read`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: "{}",
      });
      if (readResponse.status === 401) { await logout(); return; }
      if (readResponse.status === 403) throw new Error("Nie masz uprawnienia do tego zgłoszenia.");
      if (!readResponse.ok) throw new Error("Nie udało się oznaczyć zgłoszenia jako przeczytanego.");
      setInterventions((current) => current.map((entry) => entry.interventionId === item.interventionId ? { ...entry, isUnread: false } : entry));
      setInterventionSummary((current) => ({ ...current, unreadCount: Math.max(0, current.unreadCount - (item.isUnread ? 1 : 0)) }));

      if ((item.isAssignedToMe || !canViewResults) && item.kind === "sms" && (item.canSubmitSms || item.canResumeAuth)) {
        const challengeResponse = await fetch(`/api/auth-challenges?runId=${encodeURIComponent(item.runId)}`, { credentials: "same-origin" });
        if (challengeResponse.status === 401) { await logout(); return; }
        if (!challengeResponse.ok) throw new Error("Nie udało się odczytać aktywnego kodu do przypisanego zgłoszenia.");
        setSelectedRun(null);
        setActiveChallenge(await challengeResponse.json() as AuthChallenge | null);
        setAssignedSmsRunId(item.runId);
        setSmsModalRunId(item.runId);
        return;
      }

      const runResponse = await fetch(`/api/runs/${item.runId}`, { credentials: "same-origin" });
      if (runResponse.status === 401) { await logout(); return; }
      if (!runResponse.ok) throw new Error("Nie udało się odczytać aktualnego stanu zadania.");
      const run = await runResponse.json() as Run;
      setSelectedRun(run);
      if ((run.status === "waiting_for_sms" && item.canSubmitSms) || (item.kind === "sms" && item.canResumeAuth)) {
        setSmsModalRunId(run.id);
      } else {
        setActiveChallenge(null);
        setSmsModalRunId(null);
        window.requestAnimationFrame(() => document.getElementById("run-detail")?.scrollIntoView({ behavior: "smooth" }));
      }
    } catch (cause) {
      setInterventionError(cause instanceof Error ? cause.message : "Nie udało się otworzyć zgłoszenia.");
    }
  }

  async function loadMoreInterventions() {
    if (!interventionCursor || loadingMoreInterventions) return;
    setLoadingMoreInterventions(true);
    setInterventionError("");
    try {
      const response = await fetch(`/api/interventions?status=open&limit=20&cursor=${encodeURIComponent(interventionCursor)}`, { credentials: "same-origin" });
      if (response.status === 401) { await logout(); return; }
      if (response.status === 403) throw new Error("Nie masz uprawnienia do centrum zgłoszeń.");
      if (!response.ok) throw new Error("Nie udało się pobrać kolejnych zgłoszeń.");
      const page = await response.json() as { items: Intervention[]; nextCursor?: string | null };
      setInterventions((current) => {
        const seen = new Set(current.map((item) => item.interventionId));
        return [...current, ...(page.items ?? []).filter((item) => !seen.has(item.interventionId))];
      });
      setInterventionCursor(page.nextCursor ?? null);
    } catch (cause) {
      setInterventionError(cause instanceof Error ? cause.message : "Nie udało się pobrać kolejnych zgłoszeń.");
    } finally {
      setLoadingMoreInterventions(false);
    }
  }

  async function refreshSmsRun(id: string) {
    try {
      if (assignedSmsRunId === id) {
        const challengeResponse = await fetch(`/api/auth-challenges?runId=${encodeURIComponent(id)}`, { credentials: "same-origin" });
        if (challengeResponse.status === 401) { await logout(); return; }
        if (!challengeResponse.ok) throw new Error("Nie udało się odczytać aktualnego stanu kodu SMS.");
        setActiveChallenge(await challengeResponse.json() as AuthChallenge | null);
        return;
      }
      const [runResponse, challengeResponse] = await Promise.all([
        fetch(`/api/runs/${id}`, { credentials: "same-origin" }),
        fetch(`/api/auth-challenges?runId=${encodeURIComponent(id)}`, { credentials: "same-origin" }),
      ]);
      if (runResponse.status === 401 || challengeResponse.status === 401) { await logout(); return; }
      if (!runResponse.ok || !challengeResponse.ok) throw new Error("Nie udało się odczytać aktualnego stanu kodu SMS.");
      const [run, challenge] = await Promise.all([runResponse.json(), challengeResponse.json()]) as [Run, AuthChallenge | null];
      setSelectedRun(run);
      setRuns((current) => current.map((entry) => entry.id === run.id ? run : entry));
      setActiveChallenge(challenge);
      setInterventionRefreshToken((current) => current + 1);
      if (["completed", "cancelled", "failed", "no_matching_policies"].includes(run.status)) closeSmsDialog();
    } catch (cause) {
      setInterventionError(cause instanceof Error ? cause.message : "Nie udało się sprawdzić statusu kodu SMS.");
    }
  }

  async function cancelRun() {
    if (!selectedRun) return;
    setRunError("");
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/cancel`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Nie udało się anulować zadania.");
      await showRun(selectedRun.id);
      setRuns((current) => current.map((run) => run.id === selectedRun.id ? payload as Run : run));
    } catch (cause) { setRunError(cause instanceof Error ? cause.message : "Nie udało się anulować zadania."); }
  }

  async function resumeAuth(targetRunId = selectedRun?.id) {
    if (!targetRunId || authResumeLock.current || authRetryPendingRunId === targetRunId) return;
    authResumeLock.current = true;
    setAuthResuming(true);
    setRunError("");
    try {
      const response = await fetch(`/api/runs/${targetRunId}/resume-auth`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken } });
      const payload = await response.json();
      if (response.status === 401) { await logout(); return; }
      if (!response.ok) throw new Error(payload.message || "Nie udało się wznowić logowania.");
      setActiveChallenge(null);
      setAuthRetryPendingRunId(targetRunId);
      setSelectedRun(payload as Run);
      setInterventionRefreshToken((current) => current + 1);
      await showRun(targetRunId);
    } catch (cause) { setRunError(cause instanceof Error ? cause.message : "Nie udało się wznowić logowania."); setInterventionError("Nie potwierdzono ponowienia SMS. Sprawdź aktualny stan zgłoszenia przed kolejną próbą.");
      setInterventionRefreshToken((current) => current + 1);
    } finally { authResumeLock.current = false; setAuthResuming(false); }
  }

  async function saveManualData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRun?.incident?.fieldCode || userRole !== "admin") return;
    const fieldByCode: Record<string, string> = {
      ADDRESS: "address", POSTAL_CODE: "postalCode", CITY: "city", COUNTY: "countyCode", EXPECTED_PERSON: "expectedPersonName",
    };
    const field = fieldByCode[selectedRun.incident.fieldCode];
    if (!field) return;
    setManualSaving(true);
    setRunError("");
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/manual-data`, {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: selectedRun.manualDataVersion ?? 0, fields: { [field]: manualValue }, reason: manualReason }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (response.status === 401) { await logout(); return; }
      if (!response.ok) throw new Error(payload.message || "Nie udało się zapisać poprawki.");
      setManualValue("");
      setManualReason("");
      await showRun(selectedRun.id);
      setInterventionRefreshToken((current) => current + 1);
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : "Nie udało się zapisać poprawki.");
    } finally { setManualSaving(false); }
  }

  async function resumeReview() {
    if (!selectedRun || userRole !== "admin") return;
    setRunError("");
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/resume-review`, {
        method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken },
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (response.status === 401) { await logout(); return; }
      if (!response.ok) throw new Error(payload.message || "Nie udało się wznowić zadania.");
      await showRun(selectedRun.id);
      setInterventionRefreshToken((current) => current + 1);
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : "Nie udało się wznowić zadania.");
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const session = await response.json().catch(() => ({})) as { csrfToken?: string; role?: "admin" | "operator" | "reviewer" | "auditor"; mustChangePassword?: boolean };
      if (!response.ok) throw new Error("Sprawdź login i hasło.");
      if (session.mustChangePassword) { window.location.assign("/account?required=1"); return; }
      const meResponse = await fetch("/api/auth/me", { credentials: "same-origin" });
      const me = await meResponse.json().catch(() => ({})) as { csrfToken?: string; role?: "admin" | "operator" | "reviewer" | "auditor"; tools?: ToolAccess[] };
      if (!meResponse.ok) throw new Error("Nie udało się odczytać uprawnień konta.");
      setPassword("");
      setCsrfToken(typeof me.csrfToken === "string" ? me.csrfToken : typeof session.csrfToken === "string" ? session.csrfToken : "");
      setUserRole(me.role ?? session.role ?? null);
      setToolAccess(Array.isArray(me.tools) ? me.tools : []);
      setAuthenticated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zalogować.");
    } finally {
      setWorking(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setWorking(true);
    setError("");
    setRows([]);
    setRuns([]);
    setSelectedRun(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/imports", { method: "POST", body, credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Nie udało się odczytać pliku.");
      setResult(payload as ImportResult);
      setRowPage(1);
      setRowState("all");
      window.history.replaceState(null, "", `/tools/oc-policy-verification?import=${payload.id}`);
      if (canViewResults) {
        const preview = await fetch(`/api/imports/${payload.id}/rows`, { credentials: "same-origin" });
        if (preview.ok) setRows(await preview.json());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import nie powiódł się.");
    } finally {
      setWorking(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: csrfToken ? { "X-CSRF-Token": csrfToken } : {} }).catch(() => undefined);
    setAuthenticated(false);
    setMobileNavOpen(false);
    setUserRole(null);
    setToolAccess([]);
    setCsrfToken("");
    setResult(null);
    setRows([]);
    setRuns([]);
    setSelectedRun(null);
    setActiveChallenge(null);
    setSmsModalRunId(null);
    setAssignedSmsRunId(null);
    window.history.replaceState(null, "", "/");
  }

  if (authenticated === null) return <main className="loading"><span className="loader" /> Ładowanie panelu…</main>;
  if (!authenticated) return <main className="login-shell"><section className="login-intro"><GoldisLogo variant="login" priority /><p className="eyebrow">GOLDIS UBEZPIECZENIA</p><h1>Narzędzia dla pracy z danymi.</h1><p>Jedno miejsce do uruchamiania i kontroli automatyzacji.</p><div className="login-rail"><span>01 · Import</span><span>02 · Weryfikacja</span><span>03 · Wynik</span></div></section><section className="login-card"><p className="eyebrow">DOSTĘP DO PANELU</p><h2>Zaloguj się</h2><form onSubmit={login}><label>Użytkownik<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label>Hasło<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="error" role="alert">{error}</p>}<button type="submit" disabled={working}>{working ? "Logowanie…" : "Przejdź do panelu"}</button></form></section></main>;
  if (authenticated && isCatalogLanding) return <main className="platform-home">
    <header><a className="platform-home-brand" href="/"><GoldisLogo variant="header" /><span>Goldis · Platforma automatyzacji</span></a><nav><a href="/account">Moje konto</a>{userRole && ["admin", "reviewer", "auditor"].includes(userRole) && <a href="/audit">Audyt</a>}{userRole === "admin" && <a href="/admin">Administracja</a>}<span className="topbar-user">{userRole ? roleLabels[userRole] : "Użytkownik"}</span><button type="button" onClick={() => void logout()}>Wyloguj</button></nav></header>
    <div className="platform-home-content"><p className="eyebrow">GOLDIS / KATALOG</p><h1>Wybierz obszar pracy</h1><p>Narzędzia i historie dostępne dla Twojego konta. Zakres dalszych działań zależy od przydzielonych uprawnień.</p>
      {catalogError && <p className="history-error" role="alert">{catalogError}</p>}
      <div className="platform-tool-grid">{catalogItems.map((tool) => {
        const workspacePath = tool.toolId === "oc-policy-verification" ? "/tools/oc-policy-verification" : null;
        const statusText = tool.status === "maintenance" ? "Przerwa techniczna · historia pozostaje dostępna" : "Dostępne";
        return workspacePath ? <a className="platform-tool-card" href={workspacePath} key={tool.toolId}>
          <span className="eyebrow">NARZĘDZIE / OC</span><strong>{tool.displayName}</strong><span>{tool.description}</span><small>{tool.access.canExecute ? statusText : tool.access.canViewResults ? "Podgląd historii · bez prawa uruchomienia" : statusText} →</small>
        </a> : <article className="platform-tool-card is-disabled" key={tool.toolId} aria-disabled="true">
          <span className="eyebrow">MODUŁ {tool.toolId}</span><strong>{tool.displayName}</strong><span>{tool.description}</span><small>Moduł nie jest jeszcze dostępny w platformie</small>
        </article>;
      })}</div>
      {!catalogItems.length && !catalogError && <p className="history-empty">Brak narzędzi z dostępem. Skontaktuj się z administratorem organizacji.</p>}
      {catalogItems.some((tool) => tool.access.canViewResults) && <nav className="platform-history-links" aria-label="Historie"><a href="/imports">Historia importów</a><a href="/runs">Historia zadań</a><a href="/results">Wyniki OC</a></nav>}
      {userRole && ["admin", "reviewer", "auditor"].includes(userRole) && <nav className="platform-history-links" aria-label="Bezpieczeństwo"><a href="/audit">Dziennik audytu</a></nav>}
    </div>
  </main>;
  if (!canDiscoverTool && !canOperate && !canViewResults) return <main className="no-tool-access"><section className="no-tool-card"><GoldisLogo variant="header" /><p className="eyebrow">DOSTĘP DO PLATFORMY</p><h1>Brak dostępu do narzędzia</h1><p>Administrator nie przyznał temu kontu dostępu do narzędzia ani wcześniejszych wyników. Skontaktuj się z administratorem organizacji.</p><div><a href="/account">Moje konto</a><button type="button" onClick={() => void logout()}>Wyloguj</button></div></section></main>;

  const finalRunStep = selectedRun && (selectedRun.status === "completed" || selectedRun.status === "no_matching_policies");
  const currentStep: 1 | 2 | 3 = !result ? 1 : finalRunStep ? 3 : 2;
  const smsIntervention = interventions.find((item) => item.runId === smsModalRunId && item.kind === "sms" && item.status === "open");
  const smsDialog = smsModalRunId && canSeeInterventions && (assignedSmsRunId === smsModalRunId || selectedRun?.id === smsModalRunId)
    ? <SmsDialog
        challenge={activeChallenge?.runId === smsModalRunId ? activeChallenge : null}
        runId={smsModalRunId}
        csrfToken={csrfToken}
        reasonCode={smsIntervention?.reasonCode ?? selectedRun?.incident?.reasonCode}
        canResend={(!activeChallenge || activeChallenge.reasonCode === "SMS_CODE_REJECTED")
          && (smsIntervention?.canResumeAuth ?? (canOperate && selectedRun?.incident?.canResumeAuth) ?? false)}
        resending={authResuming || authRetryPendingRunId === smsModalRunId}
        onResend={() => void resumeAuth(smsModalRunId)}
        onAccepted={(attemptCount) => setActiveChallenge((current) => current ? { ...current, status: "submitted", attemptCount } : current)}
        onRefresh={() => void refreshSmsRun(smsModalRunId)}
        onUnauthorized={() => void logout()}
        onClose={closeSmsDialog}
      />
    : null;

  return <div className="shell">
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand"><GoldisLogo variant="sidebar" /><span><strong>Goldis</strong><small>panel narzędzi</small></span></div>
        <button ref={mobileMenuButtonRef} className="mobile-menu-toggle" type="button" aria-label="Otwórz menu nawigacji" aria-expanded={mobileNavOpen} aria-controls="mobile-navigation" onClick={() => setMobileNavOpen(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      </div>
      <nav className="desktop-workspace-nav" aria-label="Główna nawigacja"><a className={activeNav === "workspace-start" ? "nav-active" : ""} href="#workspace-start" aria-current={activeNav === "workspace-start" ? "page" : undefined}>Przegląd</a><a className={activeNav === "workspace-import" ? "nav-active" : ""} href="#workspace-import" aria-current={activeNav === "workspace-import" ? "page" : undefined}>Importy</a><a className={activeNav === "workspace-runs" ? "nav-active" : ""} href={result ? "#workspace-runs" : "#workspace-import"} aria-current={activeNav === "workspace-runs" ? "page" : undefined}>Zadania</a><a className={activeNav === "workspace-result" ? "nav-active" : ""} href={result ? "#workspace-result" : "#workspace-import"} aria-current={activeNav === "workspace-result" ? "page" : undefined}>Wyniki</a></nav>
      <div className="sidebar-foot"><span>Środowisko robocze</span><button type="button" onClick={() => void logout()}>Wyloguj</button></div>
      <div className="mobile-nav-layer" hidden={!mobileNavOpen} onMouseDown={(event) => { if (event.target === event.currentTarget) closeMobileNav(); }}>
        <div ref={mobileDrawerRef} className="mobile-nav-drawer" role="dialog" aria-modal="true" aria-labelledby="mobile-nav-title" onKeyDown={trapMobileNavFocus}>
          <div className="mobile-nav-head"><h2 id="mobile-nav-title">Nawigacja</h2><button type="button" className="mobile-nav-close" onClick={() => closeMobileNav()} aria-label="Zamknij menu nawigacji"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
          <nav aria-label="Główna nawigacja">
            <a className={activeNav === "workspace-start" ? "nav-active" : ""} href="#workspace-start" aria-current={activeNav === "workspace-start" ? "page" : undefined} onClick={() => { closeMobileNav(false); window.requestAnimationFrame(() => document.getElementById("workspace-start")?.focus({ preventScroll: true })); }}>Przegląd</a>
            <a className={activeNav === "workspace-import" ? "nav-active" : ""} href="#workspace-import" aria-current={activeNav === "workspace-import" ? "page" : undefined} onClick={() => { closeMobileNav(false); window.requestAnimationFrame(() => document.getElementById("workspace-import")?.focus({ preventScroll: true })); }}>Importy</a>
            <a className={activeNav === "workspace-runs" ? "nav-active" : ""} href={result ? "#workspace-runs" : "#workspace-import"} aria-current={activeNav === "workspace-runs" ? "page" : undefined} onClick={() => { closeMobileNav(false); const target = result ? "workspace-runs" : "workspace-import"; window.requestAnimationFrame(() => document.getElementById(target)?.focus({ preventScroll: true })); }}>Zadania</a>
            <a className={activeNav === "workspace-result" ? "nav-active" : ""} href={result ? "#workspace-result" : "#workspace-import"} aria-current={activeNav === "workspace-result" ? "page" : undefined} onClick={() => { closeMobileNav(false); const target = result ? "workspace-result" : "workspace-import"; window.requestAnimationFrame(() => document.getElementById(target)?.focus({ preventScroll: true })); }}>Wyniki</a>
            <a href="/">Katalog platformy</a><a href="/imports">Historia importów</a><a href="/runs">Historia zadań</a><a href="/results">Wyniki OC</a>
          </nav>
          <div className="mobile-nav-foot"><a href="/account">Moje konto</a>{userRole && ["admin", "reviewer", "auditor"].includes(userRole) && <a href="/audit">Audyt</a>}{userRole === "admin" && <a href="/admin">Administracja</a>}<span>{userRole ? roleLabels[userRole] : "Użytkownik"}</span><button type="button" onClick={() => void logout()}>Wyloguj</button></div>
        </div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><span>GOLDIS / NARZĘDZIA</span><nav className="workspace-links"><a href="/">Katalog</a><a href="/imports">Importy</a><a href="/runs">Zadania</a><a href="/results">Wyniki</a>{userRole && ["admin", "reviewer", "auditor"].includes(userRole) && <a href="/audit">Audyt</a>}<a href="/account">Moje konto</a>{userRole === "admin" && <a href="/admin">Administracja</a>}<span className="topbar-user">{userRole ? roleLabels[userRole] : "Użytkownik"}</span></nav></header>
      <div className="content">
        <section className="intro" id="workspace-start" tabIndex={-1}><p className="eyebrow">NARZĘDZIE 01 / POLISY OC</p><h1>Weryfikacja danych transportowych</h1><p>Przygotuj bazę firm do sprawdzenia w Everest i Compensie. Po imporcie zobaczysz wiersze wymagające poprawy.</p></section>
        {runError && <p className="error" role="alert">{runError}</p>}
        <section className="automation-health" aria-live="polite" aria-label="Gotowość usług">
          <span className={`status-dot ${automationHealth?.automationReady ? "" : "health-warn"}`} aria-hidden="true" />
          <div><strong>{automationHealth?.message ?? "Sprawdzanie gotowości usług…"}</strong><span>{automationHealth ? `Usługi: ${automationHealth.servicesReady ? "gotowe" : "niedostępne"} · Worker: ${automationHealth.worker} · Tryb portali: ${automationHealth.portalMode === "off" ? "wyłączone" : automationHealth.portalMode === "live" ? "live" : "nieznany"}` : ""}</span></div>
        </section>
        <RunStepper currentStep={currentStep} />

        {canSeeInterventions && <section className="result-section intervention-center" aria-labelledby="intervention-title" aria-live="polite">
          <div className="section-head"><div><p className="eyebrow">CENTRUM ZGŁOSZEŃ</p><h2 id="intervention-title">Sprawy wymagające uwagi</h2></div><div className="intervention-counts"><span>{interventionSummary.openCount} otwartych</span><span>{interventionSummary.unreadCount} nieprzeczytanych</span><span>{interventionSummary.smsCount} kodów SMS</span></div></div>
          {interventionError && <p className="error" role="alert">{interventionError}</p>}
          {interventions.length === 0 ? <p className="intervention-empty">Brak otwartych zgłoszeń.</p> : <ul className="intervention-list">
            {interventions.map((item) => <li key={item.interventionId} className={item.isUnread ? "intervention-item unread" : "intervention-item"}>
              <div className="intervention-copy">
                <strong>{interventionLabels[item.reasonCode ?? ""] ?? interventionLabels[item.kind] ?? "Wymaga sprawdzenia"}</strong>
                <span>Wiersz {item.rowNumber} · {item.portal === "pzu" ? "PZU Everest" : item.portal === "compensa" ? "Compensa" : "platforma"}</span>
                {item.kind === "sms" && <small>{item.reasonCode === "SMS_CODE_REJECTED" ? "Poprzedni kod odrzucony — wpisz aktualny kod lub jawnie ponów SMS." : item.reasonCode === "SMS_TIMEOUT" ? "Kod wygasł — zadanie czeka na kontrolowane ponowienie." : item.reasonCode === "SMS_DELIVERY_UNCERTAIN" ? "Nie wysyłaj kodu ponownie; wymagane sprawdzenie sesji." : item.reasonCode === "SMS_ATTEMPT_LIMIT" ? "Dalsze próby zablokowane; skontaktuj się z administratorem." : "Wymagane potwierdzenie sesji portalu kodem SMS."}</small>}
                <small>{item.isUnread ? "Nowa zmiana" : "Przeczytane"} · aktualizacja {new Date(item.updatedAt).toLocaleString("pl-PL")}</small>
              </div>
              <button type="button" aria-label={item.canSubmitSms ? "Wpisz kod SMS dla wiersza " + item.rowNumber : "Otwórz zgłoszenie dla wiersza " + item.rowNumber} onClick={() => void openIntervention(item)}>{item.canSubmitSms ? "Wpisz kod" : "Otwórz zgłoszenie"}</button>
            </li>)}
          </ul>}
          {interventionCursor && <div className="intervention-more"><button type="button" onClick={() => void loadMoreInterventions()} disabled={loadingMoreInterventions}>{loadingMoreInterventions ? "Pobieranie…" : "Pokaż starsze zgłoszenia"}</button></div>}
        </section>}

        <section className="workspace-grid" id="workspace-import" tabIndex={-1}>
          {canOperate && <SpotlightCard className="card upload-card" spotlightColor="rgba(217, 182, 95, 0.12)"><div className="section-head"><div><p className="eyebrow">KROK 01</p><h2>Dodaj bazę transportową</h2></div><span className="file-mark">.xlsx</span></div><p>Arkusz „Realizacja” musi zawierać kolumny „Nazwa” i „REGON”. Kolumna „Osoba Decyzyjna” jest opcjonalna. Oryginalny plik pozostaje bez zmian.</p><form onSubmit={upload}><label className="file-input">{file ? file.name : "Wybierz plik Excel"}<input type="file" accept=".xlsx" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label><button type="submit" disabled={!file || working}>{working ? "Sprawdzanie pliku…" : "Sprawdź i zaimportuj"}</button></form>{error && <p className="error" role="alert">{error}</p>}</SpotlightCard>}
          <div className="card status-card"><p className="eyebrow">STAN NARZĘDZIA</p><h2>{canOperate ? "Import gotowy do użycia" : "Tryb podglądu"}</h2><p>Sprawdzanie portali wymaga lokalnego workera Playwright i potwierdzonych selektorów ekranów.</p><div className="status-line"><span className="status-dot" /> Import i walidacja</div><div className="status-line muted"><span className="status-dot" /> Logowanie i UFG</div></div>
        </section>

        {result && canViewResults && <section id="workspace-result" tabIndex={-1} className="result-section"><div className="section-head"><div><p className="eyebrow">WYNIK IMPORTU</p><h2>Przegląd bazy</h2></div><span className="result-id">{result.id.slice(0, 8)}</span></div><div className="metrics"><div><strong>{result.totalRows.toLocaleString("pl-PL")}</strong><span>wierszy</span></div><div><strong>{result.readyRows.toLocaleString("pl-PL")}</strong><span>gotowych</span></div><div><strong>{result.invalidRows.toLocaleString("pl-PL")}</strong><span>do sprawdzenia</span></div></div><div className="row-tools"><label>Filtr <select value={rowState} onChange={(event) => { setRowState(event.target.value as "all" | "ready" | "review"); setRowPage(1); }}><option value="all">Wszystkie</option><option value="ready">Gotowe</option><option value="review">Do sprawdzenia</option></select></label><span>Strona {rowPage}</span><button type="button" disabled={rowPage === 1} onClick={() => setRowPage((page) => page - 1)}>Poprzednia</button><button type="button" disabled={rows.length < 50} onClick={() => setRowPage((page) => page + 1)}>Następna</button></div><div className="table-wrap" tabIndex={0} role="region" aria-label="Tabela wyników; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Wiersz</th><th>Nazwa</th><th>Osoba decyzyjna</th><th>REGON</th><th>Stan</th></tr></thead><tbody>{rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.companyName}</td><td>{row.decisionMakerName ?? "—"}</td><td className="mono">{row.regon}</td><td>{row.issues.length ? <span className="pill warn">Do sprawdzenia</span> : <span className="pill good">Gotowy</span>}</td></tr>)}</tbody></table></div><p className="table-note">Podgląd 50 wierszy na stronę. Import nie uruchamia zapytań do portali.</p></section>}
        {result && canViewResults && <EnrichmentReviewPanel key={result.id} batchId={result.id} csrfToken={csrfToken} canStart={canOperate} />}

        {result && (canOperate || canViewResults) && <section id="workspace-runs" tabIndex={-1} className="result-section run-section"><div className="section-head"><div><p className="eyebrow">KROK 02 / ZADANIA</p><h2>Kontrola pojedynczego wiersza</h2></div></div><p>Ten etap zapisuje zadanie, sprawdza dane wejściowe i pokazuje historię. Status „Oczekuje na adapter portali” oznacza, że worker portali nie jest aktywny.</p>
          {canOperate && <form className="run-form" onSubmit={startRun}><label>Numer wiersza w Excelu<input type="number" min="2" step="1" placeholder="np. 18001" value={runNumber} onChange={(event) => setRunNumber(event.target.value)} required /></label><button type="submit" disabled={working || !runNumber}>Sprawdź gotowość wiersza</button></form>}
          {canOperate && <RunSubmissionLauncher batchId={result.id} csrfToken={csrfToken} />}
          {runError && <p className="error" role="alert">{runError}</p>}
          {canViewResults && runs.length > 0 && <div className="run-list"><h3>Ostatnie zadania</h3>{runs.map((run) => <button key={run.id} type="button" onClick={() => void showRun(run.id)}><span>Wiersz {run.rowNumber}</span><strong>{runLabels[run.status] ?? run.status}</strong><small>{run.referenceDate}</small></button>)}</div>}
          {selectedRun && canViewResults && <div className="run-detail" id="run-detail"><h3>Wiersz {selectedRun.rowNumber}: {runLabels[selectedRun.status] ?? selectedRun.status}</h3><p>Data odniesienia: {selectedRun.referenceDate}{selectedRun.errorCode ? " · " + selectedRun.errorCode : ""}</p>
            {selectedRun.incident && <div className="sms-challenge" role="status">
              <strong>Zadanie wstrzymane — zgłoszenie dla administratora</strong>
              <p>Portal: {selectedRun.incident.portal === "pzu" ? "PZU" : "Compensa"} · Powód: {selectedRun.incident.reasonCode}{selectedRun.incident.fieldCode ? " · Pole: " + (manualFieldLabels[selectedRun.incident.fieldCode] ?? "wymaga uzgodnienia") : ""}</p>
              {selectedRun.incident.canResumeAuth && canOperate && (userRole === "admin" || userRole === "operator") ? <button type="button" disabled={authResuming || authRetryPendingRunId === selectedRun.id} onClick={() => void resumeAuth()}>{authResuming || authRetryPendingRunId === selectedRun.id ? "Oczekiwanie na ponowienie…" : "Wyślij jeden dodatkowy kod SMS"}</button>
                : selectedRun.incident.reasonCode === "SMS_TIMEOUT" && selectedRun.incident.portal === "pzu" ? <p>Limit dodatkowej próby SMS PZU został wykorzystany.</p>
                  : <p>Poprawka nie rozwiązuje automatycznie zgłoszenia; wznowienie wymaga ponownego odczytu i kontroli.</p>}
              {userRole === "admin" && selectedRun.incident.fieldCode && manualFieldLabels[selectedRun.incident.fieldCode] &&
                <form className="manual-data-form" onSubmit={saveManualData}>
                  <label>{manualFieldLabels[selectedRun.incident.fieldCode]}<input value={manualValue} onChange={(event) => setManualValue(event.target.value)} maxLength={selectedRun.incident.fieldCode === "ADDRESS" ? 200 : selectedRun.incident.fieldCode === "CITY" ? 100 : selectedRun.incident.fieldCode === "EXPECTED_PERSON" ? 150 : 80} required /></label>
                  {selectedRun.incident.fieldCode === "COUNTY" && <small>Wpisz dokładną wartość opcji z istniejącej listy Compensy. Nie zgaduj powiatu; worker sprawdzi, czy opcja istnieje.</small>}
                  <label>Powód poprawki<textarea value={manualReason} onChange={(event) => setManualReason(event.target.value)} minLength={10} maxLength={300} required /></label>
                  <button type="submit" disabled={manualSaving || !manualValue.trim() || manualReason.trim().length < 10}>{manualSaving ? "Zapisywanie…" : "Zapisz wersjonowaną poprawkę"}</button>
                </form>}
              {userRole === "admin" && selectedRun.incident.canResumeReview && <button type="button" onClick={() => void resumeReview()}>Wznów to samo zadanie</button>}
              {selectedRun.incident.fieldCode && !manualFieldLabels[selectedRun.incident.fieldCode] && <p>To zgłoszenie wymaga uzgodnienia z portalem; samo wpisanie numeru sprawy nie odblokowuje kolejnego kliknięcia.</p>}
            </div>}
            {selectedRun.policyCounts && <div className="run-policy-counts" aria-label="Liczba polis"><div><strong>{selectedRun.policyCounts.totalOcCount.toLocaleString("pl-PL")}</strong><span>polis w danych UFG</span></div><div><strong>{selectedRun.policyCounts.currentOcCount.toLocaleString("pl-PL")}</strong><span>aktualnych na {selectedRun.referenceDate}</span></div></div>}
            {selectedRun.status === "no_matching_policies" && <p className="table-note">W zapisanym snapshotcie nie ma polis OC z datą końca obejmującą dzień sprawdzenia.</p>}
            {selectedRun.artifactAvailable && selectedRun.status === "completed" && canDownloadResults && <a className="download-link" href={"/api/runs/" + selectedRun.id + "/artifact"}>Pobierz wynik Excel</a>}
            {canOperate && (selectedRun.status === "queued" || selectedRun.status === "awaiting_portal_adapter" || selectedRun.status === "waiting_for_sms") && <button className="cancel-run" type="button" onClick={() => void cancelRun()}>Anuluj zadanie</button>}
            {selectedRun.events && <ol>{selectedRun.events.map((item, index) => <li key={item.createdAt + "-" + index}>{runLabels[item.status] ?? item.status} · {new Date(item.createdAt).toLocaleString("pl-PL")}</li>)}</ol>}
          </div>}
        </section>}
      </div>
    </main>
    {smsDialog}
  </div>;
}
