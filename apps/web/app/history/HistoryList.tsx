"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { GoldisLogo } from "../../components/brand/GoldisLogo";

type HistoryKind = "imports" | "runs" | "results";
type HistoryItem = {
  id: string; batchId?: string; toolId: string; fileName?: string; totalRows?: number; reviewCount?: number;
  ownerLabel?: string | null; rowNumber?: number; status?: string; referenceDate?: string; errorCode?: string | null;
  createdAt: string; policyCounts?: { totalOcCount: number; currentOcCount: number } | null;
  artifactAvailable?: boolean; artifactId?: string | null; deletionTargetType?: "run" | "artifact" | "import"; deletionTargetId?: string;
};
type Session = { role?: string; csrfToken?: string; canDeleteData?: boolean; tools?: { toolId: string; canViewResults: boolean; canDownloadResults: boolean }[] };
type Page = { items: HistoryItem[]; nextCursor: string | null };
type DeletionPreview = {
  previewId: string; expiresAt: string; targetType: string;
  summary: { counts: Record<string, number>; blockers: string[] };
};
type DeletionJob = {
  jobId: string; targetType: string; targetId: string; status: string; attemptCount: number;
  fileCount: number; filesRemoved: number; errorCode: string | null; createdAt?: string;
};
type DeletionJobRequest = { previewId: string; stepUpToken: string; idempotencyKey: string };
type DeletionFlow =
  | { type: "previewing"; item: HistoryItem }
  | { type: "review"; item: HistoryItem; preview: DeletionPreview }
  | { type: "step-up"; item: HistoryItem; preview: DeletionPreview }
  | { type: "submitting"; item: HistoryItem; preview: DeletionPreview; request: DeletionJobRequest }
  | { type: "job"; item: HistoryItem; preview: DeletionPreview; job: DeletionJob; pollError?: string }
  | { type: "done"; item: HistoryItem; job: DeletionJob }
  | { type: "error"; item: HistoryItem; message: string; preview?: DeletionPreview; retryRequest?: DeletionJobRequest };

const deletionCountLabels: Record<string, string> = {
  sourceRows: "wiersze w wyniku", runs: "przebiegi", submissions: "zgłoszenia", artifacts: "pliki wynikowe",
  files: "pliki do usunięcia", activeRuns: "aktywne przebiegi", pendingArtifacts: "oczekujące pliki",
  sharedRunReferences: "współdzielone odwołania", activeOutbox: "oczekujące dostarczenia", stagedFiles: "pliki tymczasowe",
  deletingArtifacts: "pliki w trakcie usuwania", deletingRuns: "przebiegi w trakcie usuwania",
  activePreparations: "aktywne przygotowania", activeWorkflows: "aktywne procesy przygotowania",
  activeEnrichmentJobs: "aktywne wzbogacenia REGON", activePreparedExecutions: "aktywne wykonania zestawu",
  activeSubmissions: "aktywne zgłoszenia", imports: "importy",
  resultSets: "wyniki automatyzacji", businessLeads: "leadów firmowych",
  retainedAssignedLeads: "leadów zachowanych dla innych pracowników", removedLeads: "leadów usuwanych z importem",
  missingLeadSnapshots: "niekompletnych zapisów zachowywanych leadów",
  leadAllocations: "przydziałów leadów", notifications: "powiadomień",
};
const deletionBlockerLabels: Record<string, string> = {
  RUN_ACTIVE: "Zadanie nadal działa.", RUN_REFERENCED_BY_SUBMISSION: "Zadanie jest używane przez zgłoszenie.",
  RUN_SHARED_WITH_OTHER_IMPORT: "Zadanie współdzieli dane z innym importem.", RUN_HAS_PENDING_DELIVERY: "Trwa przekazywanie zadania do workera.",
  RUN_HAS_STAGED_RESULT: "Istnieje tymczasowy wynik workera.", RUN_HAS_PENDING_EXPORT: "Plik wynikowy nie jest jeszcze gotowy.",
  RUN_HAS_PENDING_ARTIFACT_DELETION: "Usuwanie pliku Excel dla tego wyniku już trwa.", ARTIFACT_DELETION_PENDING: "Usuwanie tego pliku już trwa.",
  IMPORT_HAS_ACTIVE_RUNS: "Import ma aktywne przebiegi.", IMPORT_REFERENCED_BY_SUBMISSION: "Import jest powiązany ze zgłoszeniem.",
  IMPORT_HAS_ACTIVE_PREPARATION: "Trwa przygotowanie importu.", IMPORT_HAS_ACTIVE_PREPARATION_WORKFLOW: "Trwa proces przygotowania importu.",
  IMPORT_HAS_ACTIVE_ENRICHMENT: "Trwa pobieranie lub zapis danych REGON.", IMPORT_HAS_ACTIVE_SET_EXECUTION: "Trwa wykonywanie zestawu.",
  IMPORT_HAS_ACTIVE_SUBMISSION: "Trwa wysyłanie zgłoszenia.", IMPORT_HAS_PENDING_DELIVERY: "Trwa przekazanie przebiegu do workera.",
  IMPORT_HAS_PENDING_EXPORT: "Jeden z plików wynikowych nie jest gotowy.", IMPORT_HAS_STAGED_RESULT: "Istnieje niezatwierdzony plik tymczasowy.",
  IMPORT_HAS_SHARED_RUN_REFERENCES: "Wiersze importu są używane w innym przebiegu.", IMPORT_DELETION_PENDING: "Usuwanie tego importu już trwa.",
  IMPORT_HAS_PENDING_RUN_DELETION: "Usuwanie przebiegu z tego importu już trwa.",
  IMPORT_HAS_PENDING_ARTIFACT_DELETION: "Usuwanie pliku wynikowego z tego importu już trwa.",
  IMPORT_LEAD_SNAPSHOT_INCOMPLETE: "Nie wszystkie przypisane wyniki mają kompletny zapis do zachowania. Import pozostaje dostępny.",
};

const runLabels: Record<string, string> = {
  queued: "W kolejce", validating: "Sprawdzanie danych", awaiting_portal_adapter: "Oczekuje na adapter portali",
  pzu_login: "Logowanie w Everest", waiting_for_sms: "Oczekuje na SMS", everest_search: "Wyszukiwanie w Everest",
  identity_review: "Weryfikacja tożsamości", compensa_login: "Logowanie do Compensy", compensa_form: "Formularz Compensy",
  waiting_for_manual_data: "Wymaga uzupełnienia", ufg_verification: "Weryfikacja UFG", reading_oc: "Odczyt polis OC",
  export_ready: "Przygotowanie wyniku", no_matching_policies: "Brak aktualnych polis OC", completed: "Zakończono",
  cancelled: "Anulowano", failed: "Błąd",
};

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function dayBoundary(value: string, end: boolean): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + (end ? 1 : 0)));
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const adjustment = target - represented;
    guess += adjustment;
    if (!adjustment) break;
  }
  return new Date(end ? guess - 1 : guess).toISOString();
}

function queryFromUrl(): { toolId: string; dataState: string; status: string; fromDay: string; toDay: string; cursor: string | null } {
  const params = new URLSearchParams(window.location.search);
  return {
    toolId: params.get("toolId") ?? "",
    dataState: params.get("dataState") ?? "all",
    status: params.get("status") ?? "",
    fromDay: params.get("fromDay") ?? "",
    toDay: params.get("toDay") ?? "",
    cursor: params.get("cursor"),
  };
}

export default function HistoryList({ kind }: { kind: HistoryKind }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [toolId, setToolId] = useState("");
  const [dataState, setDataState] = useState("all");
  const [status, setStatus] = useState("");
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  const [deletionFlow, setDeletionFlow] = useState<DeletionFlow | null>(null);
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionJobs, setDeletionJobs] = useState<DeletionJob[]>([]);
  const cursorStackRef = useRef<Array<string | null>>([null]);

  useEffect(() => {
    const params = queryFromUrl();
    setToolId(params.toolId);
    setDataState(params.dataState);
    setStatus(params.status);
    setFromDay(params.fromDay);
    setToDay(params.toDay);
    setCursor(params.cursor);
    setCursorStack(params.cursor ? [null, params.cursor] : [null]);
    cursorStackRef.current = params.cursor ? [null, params.cursor] : [null];
    setPageIndex(params.cursor ? 1 : 0);
    window.history.replaceState({ goldisHistory: true, cursorStack: params.cursor ? [null, params.cursor] : [null], pageIndex: params.cursor ? 1 : 0 }, "", window.location.href);
    const abort = new AbortController();
    fetch("/api/auth/me", { credentials: "same-origin", signal: abort.signal }).then(async (response) => {
      if (response.status === 401) { setSessionState("signed-out"); return; }
      if (!response.ok) throw new Error("Nie można odczytać uprawnień konta.");
      setSession(await response.json() as Session);
      setSessionState("ready");
    }).catch(() => { if (!abort.signal.aborted) setSessionState("error"); });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const params = queryFromUrl();
      setToolId(params.toolId); setDataState(params.dataState); setStatus(params.status);
      setFromDay(params.fromDay); setToDay(params.toDay); setCursor(params.cursor);
      const state = window.history.state as { cursorStack?: unknown; pageIndex?: unknown } | null;
      if (Array.isArray(state?.cursorStack) && state.cursorStack.every((item) => item === null || typeof item === "string")
        && Number.isInteger(state?.pageIndex) && (state?.pageIndex as number) >= 0) {
        const restored = state.cursorStack as Array<string | null>;
        cursorStackRef.current = restored;
        setCursorStack(restored);
        setPageIndex(state.pageIndex as number);
        return;
      }
      const found = cursorStackRef.current.indexOf(params.cursor);
      if (found >= 0) setPageIndex(found);
      else { setPageIndex(0); setCursorStack([null]); cursorStackRef.current = [null]; }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (sessionState !== "ready") return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (toolId) params.set("toolId", toolId);
    const from = dayBoundary(fromDay, false);
    const to = dayBoundary(toDay, true);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (kind === "imports") params.set("dataState", dataState);
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    params.set("limit", "50");
    const endpoint = kind === "imports" ? "/api/imports" : kind === "runs" ? "/api/history/runs" : "/api/history/results";
    setLoading(true); setError("");
    fetch(`${endpoint}?${params}`, { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { setSessionState("signed-out"); return; }
      const payload = await response.json().catch(() => ({})) as Page & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? `Historia jest niedostępna (${response.status}).`);
      const page = payload as Page;
      setItems(Array.isArray(page.items) ? page.items : []);
      setNextCursor(page.nextCursor ?? null);
      setEmpty(Array.isArray(page.items) && page.items.length === 0);
    }).catch((cause) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać historii."); setItems([]); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionState, kind, toolId, dataState, status, fromDay, toDay, cursor]);

  const activeDeletionJobId = deletionFlow?.type === "job" ? deletionFlow.job.jobId : null;
  useEffect(() => {
    if (!activeDeletionJobId) return;
    const jobId = activeDeletionJobId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/deletions/jobs/${jobId}`, {
          credentials: "same-origin", signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as DeletionJob & { message?: string };
        if (response.status === 401) { setSessionState("signed-out"); return; }
        if (!response.ok) throw new Error(payload.message ?? `Nie można odczytać zadania usuwania (${response.status}).`);
        if (payload.status === "completed") {
          const targetItem = deletionFlow?.type === "job" ? deletionFlow.item : null;
          setItems((current) => targetItem?.deletionTargetType === "artifact"
            ? current.map((item) => item.id === targetItem.id ? { ...item, artifactAvailable: false, artifactId: null } : item)
            : current.filter((item) => item.id !== targetItem?.id));
          setDeletionFlow((current) => current?.type === "job" && current.job.jobId === jobId
            ? { type: "done", item: current.item, job: payload } : current);
          return;
        }
        setDeletionFlow((current) => current?.type === "job" && current.job.jobId === jobId
          ? { ...current, job: payload, pollError: undefined } : current);
        if (payload.status !== "manual_required") timer = setTimeout(() => void poll(), 1_500);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setDeletionFlow((current) => current?.type === "job" && current.job.jobId === jobId
          ? { ...current, pollError: cause instanceof Error ? cause.message : "Nie udało się odczytać stanu usuwania." } : current);
        timer = setTimeout(() => void poll(), 2_500);
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [activeDeletionJobId]);

  useEffect(() => {
    if (sessionState !== "ready" || kind !== "results" || !session?.canDeleteData) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetch("/api/deletions/jobs", { credentials: "same-origin", signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as { items?: DeletionJob[]; message?: string };
        if (response.status === 401) { setSessionState("signed-out"); return; }
        if (!response.ok) throw new Error(payload.message ?? `Nie można odczytać zleceń (${response.status}).`);
        const jobs = Array.isArray(payload.items) ? payload.items : [];
        setDeletionJobs(jobs);
        const hasActive = jobs.some((job) => ["queued", "processing", "verifying", "failed_retryable"].includes(job.status));
        timer = setTimeout(() => void refresh(), hasActive ? 3_000 : 15_000);
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 8_000);
      }
    };
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionState, kind, session?.canDeleteData]);

  function writeUrl(next: { toolId: string; dataState: string; status: string; fromDay: string; toDay: string; cursor: string | null }, stack: Array<string | null>, index: number, replace = false) {
    const params = new URLSearchParams();
    if (next.toolId) params.set("toolId", next.toolId);
    if (kind === "imports" && next.dataState !== "all") params.set("dataState", next.dataState);
    if (next.status) params.set("status", next.status);
    if (next.fromDay) params.set("fromDay", next.fromDay);
    if (next.toDay) params.set("toDay", next.toDay);
    if (next.cursor) params.set("cursor", next.cursor);
    const url = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history[replace ? "replaceState" : "pushState"]({ goldisHistory: true, cursorStack: stack, pageIndex: index }, "", url);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCursor(null); setCursorStack([null]); cursorStackRef.current = [null]; setPageIndex(0);
    writeUrl({ toolId, dataState, status, fromDay, toDay, cursor: null }, [null], 0);
  }

  function nextPage() {
    if (!nextCursor) return;
    const next = [...cursorStack.slice(0, pageIndex + 1), nextCursor];
    cursorStackRef.current = next; setCursorStack(next); setPageIndex(pageIndex + 1); setCursor(nextCursor);
    writeUrl({ toolId, dataState, status, fromDay, toDay, cursor: nextCursor }, next, pageIndex + 1);
  }

  function previousPage() {
    if (pageIndex < 1) return;
    const previous = cursorStack[pageIndex - 1] ?? null;
    setPageIndex(pageIndex - 1); setCursor(previous);
    writeUrl({ toolId, dataState, status, fromDay, toDay, cursor: previous }, cursorStack, pageIndex - 1);
  }

  async function responseError(response: Response, payload: { message?: unknown }): Promise<never> {
    const message = typeof payload.message === "string" ? payload.message : `Żądanie nie powiodło się (${response.status}).`;
    throw new Error(message);
  }

  async function beginDeletion(item: HistoryItem, targetType: "run" | "artifact" | "import" = "run") {
    const targetId = targetType === "artifact" ? item.artifactId : item.id;
    if (!targetId) return;
    const flowItem = { ...item, deletionTargetType: targetType, deletionTargetId: targetId };
    setDeletionPassword("");
    setDeletionFlow({ type: "previewing", item: flowItem });
    try {
      const response = await fetch("/api/deletions/preview", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrfToken ?? "" },
        body: JSON.stringify({ targetType, targetId }),
      });
      const payload = await response.json().catch(() => ({})) as DeletionPreview & { message?: string };
      if (response.status === 401) { setSessionState("signed-out"); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      if (!response.ok) await responseError(response, payload);
      setDeletionFlow({ type: "review", item: flowItem, preview: payload });
    } catch (cause) {
      setDeletionFlow({ type: "error", item: flowItem, message: cause instanceof Error ? cause.message : "Nie udało się przygotować podglądu." });
    }
  }

  async function submitDeletionJob(item: HistoryItem, preview: DeletionPreview, request: DeletionJobRequest) {
    setDeletionFlow({ type: "submitting", item, preview, request });
    try {
      const response = await fetch("/api/deletions/jobs", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrfToken ?? "" },
        body: JSON.stringify(request),
      });
      const payload = await response.json().catch(() => ({})) as DeletionJob & { message?: string };
      if (response.status === 401) { setSessionState("signed-out"); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      if (!response.ok) {
        const message = typeof payload.message === "string" ? payload.message : `Nie udało się zlecić usuwania (${response.status}).`;
        setDeletionFlow({ type: "error", item, preview, message,
          ...(response.status >= 500 ? { retryRequest: request } : {}) });
        return;
      }
      if (item.deletionTargetType === "artifact") {
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, artifactAvailable: false, artifactId: null } : entry));
      } else {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
      }
      setDeletionJobs((current) => [payload, ...current.filter((job) => job.jobId !== payload.jobId)].slice(0, 25));
      setDeletionFlow({ type: "job", item, preview, job: payload });
    } catch (cause) {
      setDeletionFlow({ type: "error", item, preview,
        message: cause instanceof Error ? `${cause.message} Jeśli serwer przyjął żądanie, ponowienie użyje tego samego klucza i nie utworzy drugiego zadania.`
          : "Nie otrzymano odpowiedzi serwera. Możesz bezpiecznie ponowić to samo żądanie.",
        retryRequest: request });
    }
  }

  async function confirmDeletion() {
    if (deletionFlow?.type !== "review" || !session?.csrfToken || !deletionPassword) return;
    const { item, preview } = deletionFlow;
    setDeletionFlow({ type: "step-up", item, preview });
    try {
      const response = await fetch("/api/auth/deletion-step-up", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ currentPassword: deletionPassword, previewId: preview.previewId }),
      });
      const payload = await response.json().catch(() => ({})) as { stepUpToken?: string; message?: string };
      setDeletionPassword("");
      if (response.status === 401) { setSessionState("signed-out"); throw new Error("Sesja wygasła. Zaloguj się ponownie."); }
      if (!response.ok) await responseError(response, payload);
      const stepUpToken = payload.stepUpToken;
      if (typeof stepUpToken !== "string") throw new Error("Serwer nie zwrócił potwierdzenia. Odśwież podgląd.");
      const request: DeletionJobRequest = {
        previewId: preview.previewId, stepUpToken,
        idempotencyKey: `web-${window.crypto.randomUUID()}`,
      };
      await submitDeletionJob(item, preview, request);
    } catch (cause) {
      setDeletionFlow({ type: "error", item, preview,
        message: cause instanceof Error ? cause.message : "Nie udało się ponownie potwierdzić hasła." });
    }
  }

  function dismissDeletion() {
    setDeletionFlow(null);
    setDeletionPassword("");
  }

  const title = kind === "imports" ? "Historia importów" : kind === "runs" ? "Historia zadań" : "Wyniki weryfikacji";
  const description = kind === "imports" ? "Wróć do wcześniejszego importu i zobacz, ile wierszy wymaga przeglądu."
    : kind === "runs" ? "Śledź wykonanie zadań dla dozwolonych importów."
      : "Zobacz wyniki zakończone, także zadania bez aktualnych polis OC.";
  const returnTo = `${windowSafePath()}${typeof window === "undefined" ? "" : window.location.search}`;
  const canDownload = session?.tools?.some((tool) => tool.toolId === "oc-policy-verification" && tool.canDownloadResults) ?? false;
  const canDeleteData = Boolean(session?.canDeleteData);
  const displayedDeletionPreview = deletionFlow && "preview" in deletionFlow ? deletionFlow.preview : undefined;
  const deletionJobStatusLabels: Record<string, string> = {
    queued: "W kolejce", processing: "Usuwanie w toku", verifying: "Weryfikacja", failed_retryable: "Ponawianie",
    completed: "Zakończono", manual_required: "Wymaga kontroli technicznej",
  };
  const deletionInProgress = (targetType: "run" | "artifact" | "import", targetId: string) => deletionJobs.some((job) =>
    job.targetType === targetType && job.targetId === targetId
      && ["queued", "processing", "verifying", "failed_retryable", "manual_required"].includes(job.status));

  return <main className="history-page">
    <header className="history-topbar"><a className="history-brand" href="/" aria-label="Goldis — katalog"><GoldisLogo variant="header" /><span>Goldis · Platforma automatyzacji</span></a><nav aria-label="Historia"><a href="/">Katalog</a>{sessionState === "ready" && session?.role !== "auditor" && <><a href="/imports">Importy</a><a href="/runs">Zadania</a><a href="/results">Wyniki</a></>}{sessionState === "ready" && session?.role && ["admin", "manager", "reviewer", "auditor"].includes(session.role) && <a href="/audit">Audyt</a>}<a href="/account">Moje konto</a></nav></header>
    <section className="history-content">
      <p className="eyebrow">PLATFORMA / OC</p><h1>{title}</h1><p className="history-lede">{description}</p>
      {sessionState === "loading" && <p className="history-notice" role="status">Sprawdzanie sesji…</p>}
      {sessionState === "signed-out" && <p className="history-notice" role="status">Sesja wygasła. <a href={`/?returnTo=${encodeURIComponent(returnTo)}`}>Zaloguj się, aby wrócić do tej historii</a>.</p>}
      {sessionState === "error" && <p className="history-error" role="alert">Nie udało się sprawdzić sesji. Odśwież stronę.</p>}
      {sessionState === "ready" && <>
        <form className="history-filters" onSubmit={applyFilters}>
          <label>Narzędzie<select value={toolId} onChange={(event) => setToolId(event.target.value)}><option value="">Wszystkie z dostępem</option><option value="oc-policy-verification">Weryfikacja polis OC</option></select></label>
          {kind === "imports" && <label>Stan danych<select value={dataState} onChange={(event) => setDataState(event.target.value)}><option value="all">Wszystkie</option><option value="ready">Gotowe</option><option value="needs_review">Do przeglądu</option></select></label>}
          {kind !== "imports" && <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Wszystkie</option>{(kind === "results" ? ["completed", "no_matching_policies"] : ["queued", "validating", "awaiting_portal_adapter", "pzu_login", "waiting_for_sms", "everest_search", "identity_review", "compensa_login", "compensa_form", "waiting_for_manual_data", "ufg_verification", "reading_oc", "export_ready", "no_matching_policies", "completed", "cancelled", "failed"]).map((item) => <option key={item} value={item}>{runLabels[item] ?? item}</option>)}</select></label>}
          <label>Od dnia (Warszawa)<input type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} /></label>
          <label>Do dnia (Warszawa)<input type="date" value={toDay} onChange={(event) => setToDay(event.target.value)} /></label>
          <button type="submit">Zastosuj filtry</button>
        </form>
        <p className="history-timezone">Daty filtrowane według strefy Europe/Warsaw. Czasy zdarzeń wyświetlamy w tej samej strefie.</p>
        {canDeleteData && <section className="deletion-job-list" aria-label="Zlecenia usuwania danych">
          <div className="deletion-job-list-head"><div><p className="eyebrow">OPERACJE DANYCH</p><h2>Zlecenia usuwania</h2></div>
            <span>{deletionJobs.length ? `${deletionJobs.length} z ostatnich zleceń` : "Bez zleceń"}</span></div>
          {deletionJobs.length === 0 ? <p className="deletion-job-list-empty">Trwałe zlecenia usuwania pojawią się tutaj po ich utworzeniu.</p>
            : <ul>{deletionJobs.map((job) => <li key={job.jobId}>
              <div><strong>{deletionJobStatusLabels[job.status] ?? job.status}</strong>
                <span>{job.targetType === "run" ? "Wynik zadania" : job.targetType === "artifact" ? "Plik Excel" : job.targetType === "import" ? "Import i powiązane dane" : job.targetType} · {job.targetId.slice(0, 8)}</span>
                {job.createdAt && <time dateTime={job.createdAt}>{displayDate(job.createdAt)}</time>}
              </div>
              <p>{job.filesRemoved} z {job.fileCount} plików{job.errorCode ? ` · ${job.errorCode}` : ""}</p>
            </li>)}</ul>}
        </section>}
        {error && <p className="history-error" role="alert">{error}</p>}
        {loading && <p className="history-notice" role="status">Ładowanie historii…</p>}
        {!loading && !error && empty && <section className="history-empty"><h2>Brak pozycji dla tych filtrów</h2><p>Wyczyść filtr lub wykonaj nowy import w narzędziu OC.</p><a href="/tools/oc-policy-verification">Otwórz narzędzie OC</a></section>}
        {!loading && !error && items.length > 0 && <div className="history-list" aria-live="polite">{items.map((item) => {
          const moduleAvailable = item.toolId === "oc-policy-verification";
          const workspace = `/tools/oc-policy-verification?${new URLSearchParams({ ...(item.batchId ? { import: item.batchId } : { import: item.id }), ...(kind !== "imports" ? { run: item.id } : {}) })}`;
          return <article className="history-row" key={item.id}>
            <div className="history-row-main">
              <span className="history-row-kicker">{kind === "imports" ? item.toolId : `Wiersz ${item.rowNumber}`}</span>
              <h2>{kind === "imports" ? item.fileName : runLabels[item.status ?? ""] ?? item.status}</h2>
              <p>{kind === "imports" ? `${item.totalRows ?? 0} wierszy · ${item.reviewCount ?? 0} do przeglądu${item.ownerLabel ? ` · ${item.ownerLabel}` : ""}`
                : kind === "results" ? item.status === "no_matching_policies" ? "Brak polis OC aktualnych na dzień sprawdzenia" : `${item.policyCounts?.currentOcCount ?? 0} aktualnych polis OC · ${item.policyCounts?.totalOcCount ?? 0} w danych źródłowych`
                  : `Import ${item.batchId} · data sprawdzenia ${item.referenceDate ?? "—"}${item.errorCode ? ` · ${item.errorCode}` : ""}`}</p>
              <time dateTime={item.createdAt}>{displayDate(item.createdAt)}</time>
            </div>
            <div className="history-row-actions">
              {moduleAvailable
                ? <a className="history-open" href={kind === "imports" ? `/imports/${item.id}` : kind === "results" ? `/runs/${item.id}` : workspace}>{kind === "imports" ? "Otwórz import" : kind === "results" ? "Otwórz wynik" : "Otwórz zadanie"}</a>
                : <span className="history-muted">Moduł narzędzia nie jest jeszcze dostępny</span>}
              {kind === "results" && item.status === "completed" && item.artifactAvailable && (canDownload
                ? <a className="history-download" href={`/api/runs/${item.id}/artifact`}>Pobierz Excel</a>
                : <span className="history-muted">Plik gotowy · brak uprawnienia do pobrania</span>)}
              {canDeleteData && kind === "results" && ["completed", "no_matching_policies"].includes(item.status ?? "")
                && <button className="history-delete" type="button" disabled={deletionInProgress("run", item.id)} onClick={() => void beginDeletion(item)}>
                  Przygotuj usunięcie wyniku
                </button>}
              {canDeleteData && kind === "results" && item.status === "completed" && item.artifactAvailable && item.artifactId
                && <button className="history-delete" type="button" disabled={deletionInProgress("artifact", item.artifactId)}
                  onClick={() => void beginDeletion(item, "artifact")}>Usuń sam plik Excel</button>}
              {canDeleteData && kind === "imports" && <button className="history-delete" type="button" disabled={deletionInProgress("import", item.id)}
                onClick={() => void beginDeletion(item, "import")}>Przygotuj usunięcie importu</button>}
            </div>
          </article>;
        })}</div>}
        <div className="history-pagination"><button type="button" onClick={previousPage} disabled={pageIndex === 0 || loading}>Poprzednia strona</button><span>Strona {pageIndex + 1}</span><button type="button" onClick={nextPage} disabled={!nextCursor || loading}>Następna strona</button></div>
      </>}
    </section>
    {deletionFlow && <div className="deletion-backdrop">
      <section className="deletion-dialog" role="dialog" aria-modal="true" aria-labelledby="deletion-title">
        <div className="deletion-dialog-head"><div><p className="eyebrow">USUWANIE DANYCH / WYNIK</p>
          <h2 id="deletion-title">{deletionFlow.item.deletionTargetType === "artifact" ? "Usuń plik Excel" : deletionFlow.item.deletionTargetType === "import" ? "Usuń import" : "Usuń wynik zadania"}</h2></div>
          {!(["previewing", "step-up", "submitting"].includes(deletionFlow.type)) && <button className="deletion-close" type="button" onClick={dismissDeletion} aria-label="Zamknij podgląd">×</button>}
        </div>
        <p className="deletion-target">{deletionFlow.item.deletionTargetType === "import" ? `${deletionFlow.item.fileName ?? "Import"} · import` : `Wiersz ${deletionFlow.item.rowNumber} · ${deletionFlow.item.deletionTargetType === "artifact" ? "plik" : "zadanie"}`} {deletionFlow.item.deletionTargetId ?? deletionFlow.item.id}</p>
        {deletionFlow.type === "previewing" && <p className="history-notice" role="status">Sprawdzam odwołania i przygotowuję aktualny podgląd…</p>}
        {displayedDeletionPreview && <>
          <p className="deletion-explainer">{deletionFlow.item.deletionTargetType === "artifact"
            ? "Usunięty zostanie tylko opublikowany plik Excel. Wynik zadania i import źródłowy pozostaną w historii; pobranie tego pliku przestanie być dostępne."
            : deletionFlow.item.deletionTargetType === "import"
              ? "Usunięte zostaną import, jego wiersze, przebiegi i pliki. Leady przydzielone innym pracownikom zachowają status kontaktu i wynik; nieprzydzielone leady oraz leady przydzielone właścicielowi importu zostaną usunięte."
              : "Usunięte zostaną dane tego przebiegu i jego pliki wynikowe. Import źródłowy Excel pozostanie w systemie; zlecenie nie usuwa sprawy z portalu ubezpieczyciela."}</p>
          <dl className="deletion-counts">{Object.entries(displayedDeletionPreview.summary.counts)
            .filter(([, count]) => Number(count) > 0)
            .map(([key, count]) => <div key={key}><dt>{deletionCountLabels[key] ?? key}</dt><dd>{count}</dd></div>)}</dl>
          {displayedDeletionPreview.summary.blockers.length > 0 && <div className="deletion-blockers" role="alert"><strong>Nie można teraz bezpiecznie usunąć {deletionFlow.item.deletionTargetType === "import" ? "importu" : "wyniku"}.</strong><ul>
            {displayedDeletionPreview.summary.blockers.map((blocker) => <li key={blocker}>{deletionBlockerLabels[blocker] ?? "Dane mają aktywne odwołanie wymagające wyjaśnienia."}</li>)}
          </ul></div>}
        </>}
        {deletionFlow.type === "review" && <>
          <label className="deletion-password">Potwierdź swoje obecne hasło<input type="password" autoComplete="current-password" value={deletionPassword}
            onChange={(event) => setDeletionPassword(event.target.value)} maxLength={1024} disabled={deletionFlow.preview.summary.blockers.length > 0} /></label>
          <p className="deletion-warning">Operacja jest nieodwracalna. System jeszcze raz sprawdzi stan danych przed przyjęciem zlecenia.</p>
          <div className="deletion-actions"><button type="button" className="history-delete" onClick={() => void confirmDeletion()}
            disabled={!deletionPassword || deletionFlow.preview.summary.blockers.length > 0}>Potwierdź i zleć usunięcie</button>
            <button type="button" className="deletion-secondary" onClick={dismissDeletion}>Anuluj</button></div>
        </>}
        {deletionFlow.type === "step-up" && <p className="history-notice" role="status">Weryfikuję hasło i ponownie sprawdzam podgląd…</p>}
        {deletionFlow.type === "submitting" && <p className="history-notice" role="status">Zapisuję trwałe zlecenie usunięcia…</p>}
        {deletionFlow.type === "job" && <div className="deletion-job-state" role="status">
          <strong>{deletionFlow.job.status === "queued" ? "Zlecenie czeka w kolejce" : deletionFlow.job.status === "processing" || deletionFlow.job.status === "verifying" ? "Usuwanie jest w toku" : deletionFlow.job.status === "manual_required" ? "Wymagana kontrola techniczna" : "Ponawiam bezpieczne usuwanie"}</strong>
          <p>Usunięte pliki: {deletionFlow.job.filesRemoved} z {deletionFlow.job.fileCount}. Próba {deletionFlow.job.attemptCount}.</p>
          {deletionFlow.pollError && <p className="deletion-poll-error">{deletionFlow.pollError} Zlecenie pozostaje zapisane na serwerze.</p>}
          {deletionFlow.job.status === "manual_required" && <p className="deletion-poll-error">Dane wyniku są ukryte i pozostają oznaczone do usunięcia, dopóki administrator nie wyjaśni błędu.</p>}
        </div>}
        {deletionFlow.type === "done" && <div className="deletion-success" role="status"><strong>{deletionFlow.item.deletionTargetType === "artifact" ? "Plik usunięty" : deletionFlow.item.deletionTargetType === "import" ? "Import usunięty" : "Wynik usunięty"}</strong><p>{deletionFlow.item.deletionTargetType === "artifact"
          ? "Plik Excel usunięto. Dane przebiegu i import źródłowy pozostały."
          : deletionFlow.item.deletionTargetType === "import"
            ? "Import, jego wiersze, powiązane przebiegi i pliki wynikowe usunięto z lokalnej platformy."
            : "Pliki i dane przebiegu usunięto. Import źródłowy pozostał w historii importów."}</p><button type="button" className="deletion-secondary" onClick={dismissDeletion}>Zamknij</button></div>}
        {deletionFlow.type === "error" && <div className="deletion-blockers" role="alert"><strong>Nie udało się zakończyć tego kroku.</strong><p>{deletionFlow.message}</p>
          {deletionFlow.retryRequest && deletionFlow.preview && <button type="button" className="history-delete" onClick={() => void submitDeletionJob(deletionFlow.item, deletionFlow.preview!, deletionFlow.retryRequest!)}>Ponów to samo zlecenie</button>}
          {!deletionFlow.retryRequest && <button type="button" className="deletion-secondary" onClick={() => void beginDeletion(deletionFlow.item, deletionFlow.item.deletionTargetType ?? "run")}>Odśwież podgląd</button>}
        </div>}
      </section>
    </div>}
  </main>;
}

function windowSafePath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
}
