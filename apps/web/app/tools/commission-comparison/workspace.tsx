"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { loginHref } from "../../lib/return-to";
import { polishCount } from "../../lib/ui-labels";
import styles from "./workspace.module.css";

type Source = "CRM" | "ASF" | "WARTA";
type CommissionFile = { fileId: string; sourceType: Source | "DICTIONARY"; fileName: string; sha256: string; sizeBytes: number; validationState: string; uploadedAt: string };
type DictionaryVersion = { dictionaryVersionId: string; versionNumber: number; status: string; isActive: boolean; revision: number; entryCount: number; createdAt: string };
type Rate = { status: string; rate: number | null; raw: unknown; changed: boolean; rule_id: string | null };
type Entry = { id: string; tu: string; risk: string; variant: string; notes: string; agents: { Ola: Rate; Maciek: Rate } };
type Preset = { client_dictionary?: { entries?: Entry[]; stats?: Record<string, unknown> }; version?: string };
type Run = { runId: string; startDate: string; endDate: string; status: string; progressStage: string; counters: Record<string, number>; errorCode: string | null; createdAt: string; dictionaryVersionId: string };
type RecordRow = Record<string, unknown>;
type Result = { summary: Record<string, number>; issues: RecordRow[]; unresolved: RecordRow[]; policies: RecordRow[]; reverse_audit: { rows: RecordRow[]; note: string }; warnings: string[]; assumptions: string[] };
type RunDetail = { run: { runId: string; start: string; end: string; status: string; progress: string; counters: Record<string, number>; errorCode: string | null; dictionaryVersionId: string }; result: Result | null };
type Tab = "analysis" | "dictionary" | "history";
type ReadState = "loading" | "ready" | "error";

const api = "/api/tools/commission-comparison";
const sourceLabels: Record<Source, string> = { CRM: "Lista polis CRM", ASF: "Raport ASF", WARTA: "Raport Warty" };
const statusLabels: Record<string, string> = { queued: "W kolejce", running: "W trakcie", cancel_requested: "Anulowanie", cancelled: "Anulowano", failed: "Nie udało się", completed: "Zakończono", completed_with_findings: "Zakończono z pozycjami do sprawdzenia", draft: "Robocza", published: "Opublikowana", archived: "Archiwalna" };
const findingLabels: Record<string, string> = { BRAK_PROWIZJI: "Brak rozliczenia", BLEDNY_PROCENT: "Niepasujący procent", BRAK_WERYFIKACJI_PROCENTU: "Brak stawki do sprawdzenia", DOPASOWANIE_NUMERU: "Niepewny numer", ROZNI_AGENCI: "Różni OFWCA" };
const activeStates = new Set(["queued", "running", "cancel_requested"]);

function dateString(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function firstOfMonth() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`; }
function rateText(rate?: Rate) { if (!rate || rate.status !== "RATE" && rate.status !== "NO_COMMISSION" || rate.rate === null) return "BRAK"; return `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 4 }).format(rate.rate)}%`; }
async function json<T>(response: Response): Promise<T> { const body = await response.json().catch(() => ({})) as { message?: string | string[]; code?: string }; if (!response.ok) throw Object.assign(new Error(Array.isArray(body.message) ? body.message.join("; ") : body.message || body.code || `Błąd żądania (${response.status}).`), { status: response.status }); return body as T; }

export default function CommissionComparisonWorkspace() {
  const pendingStart = useRef<{ fingerprint: string; key: string } | null>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const dictionaryRequest = useRef(0);
  const [tab, setTab] = useState<Tab>("analysis");
  const [resultView, setResultView] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(true);
  const [csrf, setCsrf] = useState("");
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [canExecute, setCanExecute] = useState(false);
  const [canDownload, setCanDownload] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [files, setFiles] = useState<CommissionFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [versions, setVersions] = useState<DictionaryVersion[]>([]);
  const [versionId, setVersionId] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoadError, setDetailLoadError] = useState("");
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(() => dateString(new Date()));
  const [company, setCompany] = useState("Wszystkie towarzystwa");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readState, setReadState] = useState<{ files: ReadState; versions: ReadState; runs: ReadState; dictionary: ReadState }>({ files: "loading", versions: "loading", runs: "loading", dictionary: "loading" });
  const [readErrors, setReadErrors] = useState<{ files: string; versions: string; runs: string; dictionary: string }>({ files: "", versions: "", runs: "", dictionary: "" });
  const runListed = Boolean(runId && runs.some((item) => item.runId === runId));

  const changeView = useCallback((view: Tab | "result", selectedRunId?: string) => {
    const params = new URLSearchParams();
    params.set("view", view);
    if (view === "result" && selectedRunId) params.set("runId", selectedRunId);
    window.history.pushState({ commissionView: view }, "", `${window.location.pathname}?${params.toString()}`);
    setTab(view === "result" ? "analysis" : view); setResultView(view === "result");
    setRunId(view === "result" ? selectedRunId ?? "" : ""); setError(""); setNotice("");
  }, []);

  useEffect(() => {
    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const view = params.get("view");
      const run = params.get("runId") ?? "";
      if (view === "result" && /^[0-9a-f-]{36}$/i.test(run)) { setTab("analysis"); setResultView(true); setRunId(run); return; }
      const nextTab: Tab = view === "dictionary" || view === "history" ? view : "analysis";
      setTab(nextTab); setResultView(false); setRunId("");
    };
    syncFromUrl(); window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => { if (resultView && (detail?.run.runId === runId || runListed)) resultHeadingRef.current?.focus({ preventScroll: true }); }, [detail?.run.runId, resultView, runId, runListed]);

  const reloadFiles = useCallback(async () => {
    setReadState((current) => ({ ...current, files: "loading" })); setReadErrors((current) => ({ ...current, files: "" }));
    try { const data = await json<{ items: CommissionFile[] }>(await fetch(`${api}/files`, { credentials: "same-origin", cache: "no-store" })); setFiles(data.items); setReadState((current) => ({ ...current, files: "ready" })); }
    catch (cause) { if ((cause as { status?: number }).status === 401) setSignedIn(false); const message = cause instanceof Error ? cause.message : "Nie udało się wczytać plików."; setReadState((current) => ({ ...current, files: "error" })); setReadErrors((current) => ({ ...current, files: message })); throw cause; }
  }, []);
  const reloadVersions = useCallback(async () => {
    setReadState((current) => ({ ...current, versions: "loading" })); setReadErrors((current) => ({ ...current, versions: "" }));
    try {
      const data = await json<{ items: DictionaryVersion[]; canEdit: boolean }>(await fetch(`${api}/dictionary/versions`, { credentials: "same-origin", cache: "no-store" }));
      setVersions(data.items); setCanEdit(data.canEdit); setReadState((current) => ({ ...current, versions: "ready" }));
      setVersionId((previous) => previous || data.items.find((item) => item.isActive)?.dictionaryVersionId || data.items.find((item) => item.status === "draft")?.dictionaryVersionId || "");
    } catch (cause) { if ((cause as { status?: number }).status === 401) setSignedIn(false); const message = cause instanceof Error ? cause.message : "Nie udało się wczytać wersji słownika."; setReadState((current) => ({ ...current, versions: "error" })); setReadErrors((current) => ({ ...current, versions: message })); throw cause; }
  }, []);
  const reloadRuns = useCallback(async () => {
    setReadState((current) => ({ ...current, runs: "loading" })); setReadErrors((current) => ({ ...current, runs: "" }));
    try { const data = await json<{ items: Run[] }>(await fetch(`${api}/runs`, { credentials: "same-origin", cache: "no-store" })); setRuns(data.items); setReadState((current) => ({ ...current, runs: "ready" })); }
    catch (cause) { if ((cause as { status?: number }).status === 401) setSignedIn(false); const message = cause instanceof Error ? cause.message : "Nie udało się wczytać historii analiz."; setReadState((current) => ({ ...current, runs: "error" })); setReadErrors((current) => ({ ...current, runs: message })); throw cause; }
  }, []);
  const loadDictionary = useCallback(async (id: string) => {
    const requestId = ++dictionaryRequest.current;
    setReadState((current) => ({ ...current, dictionary: "loading" })); setReadErrors((current) => ({ ...current, dictionary: "" }));
    if (!id) { setPreset(null); setReadState((current) => ({ ...current, dictionary: "ready" })); return; }
    try { const data = await json<{ preset: Preset }>(await fetch(`${api}/dictionary/versions/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" })); if (requestId !== dictionaryRequest.current) return; setPreset(data.preset); setPage(0); setReadState((current) => ({ ...current, dictionary: "ready" })); }
    catch (cause) { if (requestId !== dictionaryRequest.current) return; if ((cause as { status?: number }).status === 401) setSignedIn(false); const message = cause instanceof Error ? cause.message : "Nie udało się wczytać słownika."; setReadState((current) => ({ ...current, dictionary: "error" })); setReadErrors((current) => ({ ...current, dictionary: message })); throw cause; }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const me = await json<{ csrfToken?: string; tools?: Array<{ toolId: string; canExecute?: boolean; canDownloadResults?: boolean }> }>(await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" }));
        if (!live) return;
        const access = me.tools?.find((item) => item.toolId === "commission-comparison");
        setSignedIn(true); setCsrf(me.csrfToken ?? ""); setCanExecute(access?.canExecute === true); setCanDownload(access?.canDownloadResults === true);
        await Promise.allSettled([reloadFiles(), reloadVersions(), reloadRuns()]);
      } catch (cause) { if (live) { if ((cause as { status?: number }).status === 401) setSignedIn(false); else setError(cause instanceof Error ? cause.message : "Nie udało się wczytać porównywarki."); } }
    })();
    return () => { live = false; };
  }, [reloadFiles, reloadRuns, reloadVersions]);

  useEffect(() => { void loadDictionary(versionId).catch(() => undefined); }, [versionId, loadDictionary]);

  const selectedRun = useMemo(() => runs.find((item) => item.runId === runId), [runId, runs]);
  const displayRun: Run | null = selectedRun ?? (detail ? {
    runId: detail.run.runId, startDate: detail.run.start, endDate: detail.run.end, status: detail.run.status,
    progressStage: detail.run.progress, counters: detail.run.counters, errorCode: detail.run.errorCode,
    createdAt: "", dictionaryVersionId: detail.run.dictionaryVersionId,
  } : null);
  useEffect(() => {
    if (!runId) { setDetail(null); setDetailLoadError(""); return; }
    let live = true;
    setDetail(null); setDetailLoadError("");
    const refresh = async () => { try { const value = await json<RunDetail>(await fetch(`${api}/runs/${encodeURIComponent(runId)}`, { credentials: "same-origin", cache: "no-store" })); if (live) { setDetail(value); setDetailLoadError(""); } } catch (cause) { if (live) { if ((cause as { status?: number }).status === 401) setSignedIn(false); const message = cause instanceof Error ? cause.message : "Nie udało się odczytać wyniku."; setDetailLoadError(message); setError(message); } } };
    void refresh();
    const timer = selectedRun && activeStates.has(selectedRun.status) ? window.setInterval(() => { void refresh(); void reloadRuns(); }, 2500) : undefined;
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [runId, selectedRun?.status, reloadRuns]);

  const entries = preset?.client_dictionary?.entries ?? [];
  const companies = useMemo(() => [...new Set(entries.map((entry) => entry.tu))].sort((a, b) => a.localeCompare(b, "pl")), [entries]);
  const filteredEntries = useMemo(() => entries.filter((entry) => (company === "Wszystkie towarzystwa" || entry.tu === company)
    && (!search || `${entry.tu} ${entry.risk} ${entry.variant} ${entry.notes}`.toLocaleLowerCase("pl").includes(search.toLocaleLowerCase("pl")))), [company, entries, search]);
  const pageSize = 60; const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize));
  const visibleEntries = filteredEntries.slice(page * pageSize, (page + 1) * pageSize);
  const selected = files.filter((file) => selectedFiles.includes(file.fileId));
  const activeVersion = versions.find((item) => item.isActive);
  const currentVersion = versions.find((item) => item.dictionaryVersionId === versionId);
  const hasCrm = selected.some((item) => item.sourceType === "CRM");
  const hasReport = selected.some((item) => item.sourceType === "ASF" || item.sourceType === "WARTA");
  const validDateRange = Boolean(start && end && start <= end);
  const canStart = hasCrm && hasReport && Boolean(activeVersion) && validDateRange && readState.files === "ready" && readState.versions === "ready" && readState.dictionary === "ready" && !busy && !uploading;
  const readinessMessage = !canExecute ? "To konto może przeglądać wyniki, ale nie ma prawa uruchamiać analiz."
    : readState.files === "loading" ? "Pobieram listę plików źródłowych."
      : readState.files === "error" ? "Nie udało się odczytać plików. Ponów ładowanie przed uruchomieniem."
        : readState.versions === "loading" || readState.dictionary === "loading" ? "Sprawdzam aktywny słownik prowizji."
          : readState.versions === "error" || readState.dictionary === "error" ? "Nie udało się potwierdzić stanu słownika. Ponów odczyt przed uruchomieniem."
            : !validDateRange ? "Ustaw prawidłowy zakres dat."
              : !hasCrm && !hasReport ? "Zaznacz plik CRM oraz przynajmniej jeden raport ASF lub Warty."
                : !hasCrm ? "Zaznacz plik CRM."
                  : !hasReport ? "Zaznacz raport ASF lub Warty."
                    : !activeVersion ? "Brak aktywnego słownika. Otwórz słownik, sprawdź wersję i opublikuj ją."
                      : busy || uploading ? "Zapisuję zmianę. Poczekaj na potwierdzenie przed uruchomieniem analizy."
                      : "Zestaw jest gotowy do analizy.";

  const upload = async (source: Source | "DICTIONARY", file?: File) => {
    if (!file) return;
    setError(""); setNotice(""); setUploading(source);
    try {
      const form = new FormData(); form.append("file", file); if (source !== "DICTIONARY") form.append("sourceType", source);
      const path = source === "DICTIONARY" ? `${api}/dictionary/import` : `${api}/files`;
      const uploaded = await json<{ fileId?: string; dictionaryVersionId?: string }>(await fetch(path, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf }, body: form }));
      await Promise.all([reloadFiles(), reloadVersions()]);
      setNotice(source === "DICTIONARY" ? "Utworzono wersję roboczą słownika. Sprawdź ją i opublikuj przed użyciem." : `Dodano plik: ${file.name}`);
      if (source !== "DICTIONARY") setUploadOpen(false);
      if (source !== "DICTIONARY" && uploaded.fileId) setSelectedFiles((values) => values.includes(uploaded.fileId!) ? values : [...values, uploaded.fileId!]);
      if (source === "DICTIONARY" && uploaded.dictionaryVersionId) setVersionId(uploaded.dictionaryVersionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się przesłać pliku."); }
    finally { setUploading(""); }
  };

  const createRun = async () => {
    if (busy) return;
    if (!canExecute || !canStart) { setError(readinessMessage); return; }
    const fingerprint = JSON.stringify({ start, end, fileIds: [...selectedFiles].sort() });
    if (!pendingStart.current || pendingStart.current.fingerprint !== fingerprint) pendingStart.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const response = await fetch(`${api}/runs`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ start, end, fileIds: selectedFiles, idempotencyKey: pendingStart.current!.key }) });
      const created = await json<{ runId: string }>(response); pendingStart.current = null; await reloadRuns().catch(() => undefined); changeView("result", created.runId); setNotice("Analiza została przyjęta do kolejki.");
    } catch (cause) { if ((cause as { status?: number }).status === 401) setSignedIn(false); setError(cause instanceof Error ? cause.message : "Nie udało się uruchomić analizy."); }
    finally { setBusy(false); }
  };

  const publish = async () => {
    if (!currentVersion || currentVersion.status !== "draft") return;
    setBusy(true); setError("");
    try { await json(await fetch(`${api}/dictionary/drafts/${encodeURIComponent(currentVersion.dictionaryVersionId)}/publish`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ revision: currentVersion.revision }) })); await reloadVersions(); setNotice("Opublikowano słownik. Ta wersja będzie używana w nowych analizach."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się opublikować słownika."); }
    finally { setBusy(false); }
  };

  const activateVersion = async () => {
    if (!currentVersion || currentVersion.status !== "archived") return;
    setBusy(true); setError("");
    try { await json(await fetch(`${api}/dictionary/versions/${encodeURIComponent(currentVersion.dictionaryVersionId)}/activate`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } })); await reloadVersions(); setNotice("Ponownie aktywowano wcześniejszą wersję słownika."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się aktywować wersji."); }
    finally { setBusy(false); }
  };

  const changeRate = async (entry: Entry, agent: "Ola" | "Maciek", value: string) => {
    if (!currentVersion || currentVersion.status !== "draft") return;
    const rate = value.trim() ? Number(value.replace(",", ".")) : null;
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) { setError("Stawka musi mieścić się w zakresie 0–100%."); return; }
    try {
      const saved = await json<{ revision: number; entry: Entry }>(await fetch(`${api}/dictionary/drafts/${encodeURIComponent(currentVersion.dictionaryVersionId)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ revision: currentVersion.revision, agent, status: rate === null ? "MISSING" : "RATE", rate }) }));
      setPreset((old) => old ? { ...old, client_dictionary: { ...old.client_dictionary, entries: old.client_dictionary?.entries?.map((row) => row.id === entry.id ? saved.entry : row) } } : old);
      setVersions((old) => old.map((item) => item.dictionaryVersionId === currentVersion.dictionaryVersionId ? { ...item, revision: saved.revision } : item)); setError("");
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      const message = cause instanceof Error ? cause.message : "Nie udało się zapisać stawki.";
      if (status === 409 && message.includes("COMMISSION_DICTIONARY_REVISION_CONFLICT") && currentVersion) {
        try {
          await Promise.all([reloadVersions(), loadDictionary(currentVersion.dictionaryVersionId)]);
          setError("Słownik zmienił się w innej sesji. Wpisana wartość pozostała w polu; sprawdź aktualną wersję i zapisz ją ponownie świadomie.");
        } catch {
          setError("Słownik zmienił się w innej sesji, a odświeżenie wersji się nie powiodło. Wpisana wartość pozostała w polu; odśwież dane przed ponownym zapisem.");
        }
      } else {
        setError(message);
      }
    }
  };

  const cancelRun = async () => { if (!runId) return; setBusy(true); try { await json(await fetch(`${api}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } })); await reloadRuns(); setNotice("Wysłano żądanie anulowania."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się anulować analizy."); } finally { setBusy(false); } };

  const download = async () => {
    if (!runId) return;
    setBusy(true); setError("");
    try {
      const created = await json<{ exportId: string }>(await fetch(`${api}/runs/${encodeURIComponent(runId)}/exports`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } }));
      const response = await fetch(`${api}/exports/${encodeURIComponent(created.exportId)}/download`, { credentials: "same-origin", cache: "no-store" }); if (!response.ok) throw new Error("Nie udało się pobrać Excela.");
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = `porownanie-prowizji-${detail?.run.start ?? "wynik"}.xlsx`; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się przygotować eksportu."); }
    finally { setBusy(false); }
  };

  if (signedIn === false) return <main className={`${styles.workspace} lead-content platform-content`}><div className="lead-page-heading"><div><h1>Porównywarka prowizji</h1><p>Zaloguj się do Goldis, aby wczytać pliki i sprawdzić rozliczenia.</p></div></div><a className="lead-primary" href={loginHref("/tools/commission-comparison", window.location.origin)}>Przejdź do logowania</a>{error && <p className={styles.error} role="alert">{error}</p>}</main>;

  const issueRows = [...(detail?.result?.issues ?? []), ...(detail?.result?.unresolved ?? [])];
  return <main className={`${styles.workspace} lead-content platform-content`}>
    <div className="lead-page-heading"><div><h1>Porównywarka prowizji</h1><p>Sprawdź kompletność rozliczeń ASF i Warty oraz zgodność procentów z wersją słownika przypiętą do analizy.</p></div><span className="lead-count-tag">{readState.versions === "loading" || readState.dictionary === "loading" ? "Sprawdzam słownik…" : readState.versions === "error" || readState.dictionary === "error" ? "Nie udało się odczytać słownika" : activeVersion ? `Słownik v${activeVersion.versionNumber} aktywny` : "Brak opublikowanego słownika"}</span></div>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    <nav className={styles.tabs} aria-label="Sekcje porównywarki">{([ ["analysis", "Nowa analiza"], ["dictionary", "Słownik prowizji"], ["history", "Historia analiz"] ] as const).map(([key, label]) => <button key={key} type="button" className={tab === key && !resultView ? styles.activeTab : ""} aria-current={tab === key && !resultView ? "page" : undefined} onClick={() => changeView(key)}>{label}</button>)}</nav>

    {tab === "analysis" && <>
      {!resultView && <>
      <section className={`lead-panel ${styles.panel}`}>
        <header className={styles.sectionHeading}><div><h2>Pliki źródłowe</h2><p>Dodaj zestaw danych dla wybranego okresu. Identyczne pliki zostaną wykryte po zawartości.</p></div><span>{readState.files === "loading" ? "Wczytuję pliki…" : readState.files === "error" ? "Lista niedostępna" : polishCount(files.filter((file) => file.sourceType !== "DICTIONARY").length, "plik", "pliki", "plików")}</span></header>
        <details className={styles.uploadDetails} open={uploadOpen} onToggle={(event) => setUploadOpen(event.currentTarget.open)}>
          <summary>{uploadOpen ? "Wybór plików" : "Dodaj pliki źródłowe"}</summary>
          <div className={styles.uploadGrid}>{(["CRM", "ASF", "WARTA"] as Source[]).map((source) => <label className={styles.uploadSlot} key={source}><strong>{sourceLabels[source]}</strong><span>Arkusz Excel .xlsx</span><input type="file" accept=".xlsx" disabled={!canExecute || Boolean(uploading)} onChange={(event: ChangeEvent<HTMLInputElement>) => { void upload(source, event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /><b>{uploading === source ? "Wczytywanie…" : "Wybierz plik"}</b></label>)}</div>
        </details>
        {readState.files === "error" && <div className={styles.error} role="alert"><span>{readErrors.files}</span><button type="button" className="lead-secondary" onClick={() => void reloadFiles().catch(() => undefined)}>Ponów ładowanie plików</button></div>}
        {readState.versions === "error" && <div className={styles.error} role="alert"><span>{readErrors.versions}. Ostatnie poprawne wersje pozostają widoczne.</span><button type="button" className="lead-secondary" onClick={() => void reloadVersions().catch(() => undefined)}>Ponów odczyt wersji</button></div>}
        {readState.dictionary === "error" && <div className={styles.error} role="alert"><span>{readErrors.dictionary}. Ostatnio wczytane pozycje pozostają widoczne.</span><button type="button" className="lead-secondary" onClick={() => void loadDictionary(versionId).catch(() => undefined)}>Ponów odczyt słownika</button></div>}
        {readState.files === "ready" && files.filter((file) => file.sourceType !== "DICTIONARY").length === 0 && <p className={styles.emptyState}>Nie dodano jeszcze plików. Dodaj CRM oraz co najmniej jeden raport ASF lub Warty.</p>}
        {readState.files === "loading" && <p className={styles.muted} role="status">Wczytuję pliki źródłowe…</p>}
        <div className={`${styles.tableScroll} ${styles.fileTable}`}><table><thead><tr><th>Do analizy</th><th>Rodzaj</th><th>Plik</th><th>Rozmiar</th><th>Dodano</th></tr></thead><tbody>{files.filter((file) => file.sourceType !== "DICTIONARY").map((file) => <tr key={file.fileId}><td><label className={styles.fileSelect}><input type="checkbox" aria-label={`Uwzględnij ${file.fileName}`} checked={selectedFiles.includes(file.fileId)} onChange={(event) => setSelectedFiles((ids) => event.target.checked ? [...ids, file.fileId] : ids.filter((id) => id !== file.fileId))} /></label></td><td>{sourceLabels[file.sourceType as Source]}</td><td className={styles.fileName}>{file.fileName}</td><td>{(file.sizeBytes / 1048576).toFixed(2)} MB</td><td>{new Date(file.uploadedAt).toLocaleDateString("pl-PL")}</td></tr>)}</tbody></table></div>
        <ul className={styles.mobileFiles} aria-label="Pliki do analizy">{files.filter((file) => file.sourceType !== "DICTIONARY").map((file) => <li key={file.fileId}><label><input type="checkbox" aria-label={`Uwzględnij ${file.fileName}`} checked={selectedFiles.includes(file.fileId)} onChange={(event) => setSelectedFiles((ids) => event.target.checked ? [...ids, file.fileId] : ids.filter((id) => id !== file.fileId))} /><span><strong>{sourceLabels[file.sourceType as Source]}</strong><span className={styles.fileName}>{file.fileName}</span><small>{(file.sizeBytes / 1048576).toFixed(2)} MB · dodano {new Date(file.uploadedAt).toLocaleDateString("pl-PL")}</small></span></label></li>)}</ul>
      </section>
      {!resultView && <section className={`lead-panel ${styles.panel} ${styles.analysisControls}`} aria-labelledby="commission-analysis-controls">
        <header className={styles.sectionHeading}><div><h2 id="commission-analysis-controls">Zakres analizy</h2><p>Wybierz daty, dla których mają zostać sprawdzone rozliczenia.</p></div></header>
        <div className={styles.dateRange}><label>Od<input type="date" value={start} max={end || undefined} onChange={(event) => setStart(event.target.value)} /></label><label>Do<input type="date" value={end} min={start || undefined} onChange={(event) => setEnd(event.target.value)} /></label></div>
        <div className={styles.readiness} role="status"><p id="commission-readiness-message">{readinessMessage}</p>{(!activeVersion || readState.versions === "error" || readState.dictionary === "error") && <button className="lead-secondary" type="button" onClick={() => changeView("dictionary")}>Otwórz słownik prowizji</button>}</div>
        <button className="lead-primary" type="button" disabled={!canStart} aria-describedby="commission-readiness-message" onClick={() => void createRun()}>{busy ? "Uruchamiam analizę…" : "Uruchom analizę"}</button>
      </section>}
      </>}
      {resultView && displayRun && <section className={`lead-panel ${styles.panel}`} aria-labelledby="commission-result-heading"><header className={styles.sectionHeading}><div><h2 id="commission-result-heading" ref={resultHeadingRef} tabIndex={-1}>Wynik analizy</h2><p>{detail?.run.start ?? displayRun.startDate} – {detail?.run.end ?? displayRun.endDate} · {statusLabels[detail?.run.status ?? displayRun.status] ?? displayRun.status}</p></div><div className={styles.actionGroup}><button type="button" className="lead-secondary" onClick={() => changeView("history")}>Wróć do historii</button>{activeStates.has(displayRun.status) && canExecute && <button type="button" className={styles.cancelButton} disabled={busy} onClick={() => void cancelRun()}>Anuluj</button>}{detail?.result && canDownload && <button className="lead-secondary" type="button" disabled={busy} onClick={() => void download()}>Pobierz Excel</button>}</div></header>
        {detailLoadError && !detail?.result && <div className={styles.error} role="alert">Nie udało się otworzyć tego wyniku: {detailLoadError} <button type="button" className="lead-secondary" onClick={() => changeView("history")}>Wróć do historii</button></div>}
        {detail?.result ? <><div className={styles.summaryStrip}>{[["policies", "polisy"], ["matched_policies", "dopasowano"], ["missing_policies", "bez rozliczenia"], ["wrong_rate_rows", "niezgodne %"], ["unverified_rate_rows", "bez oceny %"], ["candidate_policies", "niepewne numery"]].map(([key, label]) => <div key={key}><strong>{detail.result?.summary[key] ?? 0}</strong><span>{label}</span></div>)}</div><div className={styles.tableScroll}><table className={styles.findings}><thead><tr><th>Problem</th><th>TU</th><th>Numer CRM</th><th>Numer raportu</th><th>Klient / data CRM</th><th>OFWCA</th><th>Ryzyko</th><th>Otrzymano</th><th>Oczekiwano</th><th>Źródło / powód</th></tr></thead><tbody>{issueRows.slice(0, 500).map((row, index) => <tr key={`${String(row.policy_id)}-${String(row.kind)}-${index}`}><td>{findingLabels[String(row.kind)] ?? String(row.kind ?? "Do sprawdzenia")}</td><td>{String(row.insurer ?? "—")}</td><td className={styles.mono}>{String(row.number ?? "—")}</td><td className={styles.mono}>{String(row.report_number || "—")}</td><td>{String(row.customer || "—")}<br />{String(row.issued || "—")}</td><td>{String(row.agent || "Nieustalony")}</td><td>{String(row.risk || "—")}</td><td>{row.actual_rate == null ? "—" : `${row.actual_rate}%`}</td><td>{row.expected_rate == null ? "—" : `${row.expected_rate}%`}</td><td>{[row.file, row.sheet, row.row].filter(Boolean).join(" · ") || String(row.reason ?? "")}</td></tr>)}{issueRows.length === 0 && <tr><td colSpan={10} className={styles.empty}>Nie znaleziono pozycji wymagających sprawdzenia.</td></tr>}</tbody></table></div><p className={styles.footnote}>Brak rozliczenia dotyczy dostarczonych plików. Rozbieżność stawki wymaga oceny warunków TU.</p>{detail.result.reverse_audit?.rows?.length > 0 && <details className={styles.reverse}><summary>Rozliczenia bez odpowiednika w CRM ({detail.result.reverse_audit.rows.length})</summary><p>{detail.result.reverse_audit.note}</p><div className={styles.tableScroll}><table><thead><tr><th>TU</th><th>Numer</th><th>Źródło</th><th>Data umowy / zakres</th><th>Wiersze</th><th>OFWCA</th></tr></thead><tbody>{detail.result.reverse_audit.rows.slice(0, 200).map((row, index) => <tr key={index}><td>{String(row.insurer ?? "—")}</td><td>{String(row.number ?? "—")}</td><td>{String(row.source_type ?? "—")}</td><td>{String(row.date_scope ?? "Brak daty")}<br />{Array.isArray(row.dates) ? row.dates.join(", ") : ""}</td><td>{String(row.rows ?? 0)}</td><td>{Array.isArray(row.agents) ? row.agents.join(", ") : "—"}</td></tr>)}</tbody></table></div></details>}</> : <p className={styles.muted}>{displayRun.status === "failed" ? `Analiza zakończyła się błędem: ${displayRun.errorCode ?? "błąd przetwarzania"}.` : "Analiza jest w toku lub ładuje szczegóły. Stan odświeża się automatycznie."}</p>}</section>}
      {resultView && !displayRun && <section className={`lead-panel ${styles.panel}`} aria-live="polite"><h2>Otwieram wynik analizy</h2>{detailLoadError ? <p className={styles.error} role="alert">Nie udało się otworzyć wyniku: {detailLoadError}</p> : <p className={styles.muted}>Pobieram zapisany wynik…</p>}<button type="button" className="lead-secondary" onClick={() => changeView("history")}>Wróć do historii</button></section>}
    </>}

    {tab === "dictionary" && <section className={`lead-panel ${styles.panel}`}><header className={styles.sectionHeading}><div><h2>Słownik prowizji</h2><p>Stawki Oli i Maćka są oddzielne; warianty PZU „Nowy” i „Wznowienie aktywne” pozostają osobnymi pozycjami.</p></div>{canEdit && <label className={styles.importButton}>{uploading === "DICTIONARY" ? "Wczytywanie…" : "Wczytaj Excel"}<input type="file" accept=".xlsx,.xlsm" disabled={Boolean(uploading)} onChange={(event) => { void upload("DICTIONARY", event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>}</header>
      {readState.versions === "error" && <div className={styles.error} role="alert"><span>{readErrors.versions}. Ostatnio wczytane wersje pozostają widoczne.</span><button type="button" className="lead-secondary" onClick={() => void reloadVersions().catch(() => undefined)}>Ponów odczyt wersji</button></div>}
      {readState.dictionary === "error" && <div className={styles.error} role="alert"><span>{readErrors.dictionary}</span><button type="button" className="lead-secondary" onClick={() => void loadDictionary(versionId).catch(() => undefined)}>Ponów ładowanie słownika</button></div>}
      <div className={styles.dictionaryTools}><label>Wersja<select value={versionId} onChange={(event) => setVersionId(event.target.value)}><option value="">Wybierz</option>{versions.map((version) => <option key={version.dictionaryVersionId} value={version.dictionaryVersionId}>v{version.versionNumber} · {statusLabels[version.status] ?? version.status}{version.isActive ? " · aktywna" : ""}</option>)}</select></label><label>Towarzystwo<select value={company} onChange={(event) => { setCompany(event.target.value); setPage(0); }}><option>Wszystkie towarzystwa</option>{companies.map((item) => <option key={item}>{item}</option>)}</select></label><label>Szukaj<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Ryzyko, wariant…" /></label>{currentVersion?.status === "draft" && canEdit && <button type="button" className="lead-primary" disabled={busy} onClick={() => void publish()}>Opublikuj wersję</button>}{currentVersion?.status === "archived" && canEdit && <button type="button" className="lead-secondary" disabled={busy} onClick={() => void activateVersion()}>Aktywuj tę wersję</button>}</div>
      {currentVersion && <p className={styles.dictionaryInfo}>{polishCount(currentVersion.entryCount, "pozycja", "pozycje", "pozycji")} · {currentVersion.status === "draft" ? "wersja robocza; opublikuj po sprawdzeniu" : currentVersion.isActive ? "aktywna dla nowych analiz" : "zachowana w historii"}</p>}
      <div className={styles.tableScroll}><table className={styles.dictionaryTable}><thead><tr><th>Towarzystwo</th><th>Rodzaj ryzyka / produkt</th><th>Wariant</th><th>Ola %</th><th>Maciek %</th><th>Uwagi</th></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={entry.id}><td>{entry.tu}</td><td>{entry.risk}</td><td>{entry.variant || "—"}</td>{(["Ola", "Maciek"] as const).map((person) => { const value = entry.agents?.[person]; const editable = canEdit && currentVersion?.status === "draft"; return <td key={person}>{editable ? <input className={value?.rate == null && value?.status !== "NO_COMMISSION" ? styles.missingRate : styles.rateInput} type="number" min="0" max="100" step="0.01" defaultValue={value?.rate ?? ""} aria-label={`${entry.tu}, ${entry.risk}, prowizja ${person}`} placeholder="BRAK" onBlur={(event) => { const next = event.currentTarget.value; if (next === "" && value?.status !== "MISSING" || next !== "" && Number(next) !== value?.rate) void changeRate(entry, person, next); }} /> : <span className={value?.rate == null && value?.status !== "NO_COMMISSION" ? styles.missingLabel : ""}>{rateText(value)}</span>}</td>; })}<td>{entry.notes || "—"}</td></tr>)}{visibleEntries.length === 0 && readState.dictionary === "ready" && <tr><td colSpan={6} className={styles.empty}>{versionId ? "Brak pozycji dla zastosowanych filtrów." : "Wczytaj plik słownika klienta, aby rozpocząć."}</td></tr>}{visibleEntries.length === 0 && readState.dictionary === "loading" && <tr><td colSpan={6} className={styles.empty}>Wczytuję pozycje słownika…</td></tr>}</tbody></table></div>
      {filteredEntries.length > pageSize && <div className={styles.pagination}><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, filteredEntries.length)} z {filteredEntries.length}</span><div><button type="button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Poprzednia</button><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Następna</button></div></div>}
      {!canEdit && <p className={styles.muted}>Możesz przeglądać słownik. Do edycji potrzebne jest osobne uprawnienie.</p>}
    </section>}

    {tab === "history" && <section className={`lead-panel ${styles.panel}`}><header className={styles.sectionHeading}><div><h2>Historia analiz</h2><p>Każdy wynik zachowuje zestaw plików i wersję słownika używaną podczas obliczeń.</p></div><button className="lead-secondary" type="button" disabled={readState.runs === "loading"} onClick={() => void reloadRuns().catch(() => undefined)}>Odśwież</button></header>
      {readState.runs === "error" && <div className={styles.error} role="alert"><span>{readErrors.runs}</span><button type="button" className="lead-secondary" onClick={() => void reloadRuns().catch(() => undefined)}>Ponów ładowanie historii</button></div>}
      {readState.runs === "loading" && <p className={styles.muted} role="status">Wczytuję historię analiz…</p>}
      {readState.runs === "ready" && runs.length === 0 && <p className={styles.emptyState}>Nie wykonano jeszcze analiz.</p>}
      {(readState.runs === "ready" || readState.runs === "error") && runs.length > 0 && <div className={styles.tableScroll}><table><thead><tr><th>Zakres</th><th>Utworzono</th><th>Status</th><th>Polisy</th><th>Braki</th><th>Niepasujące %</th><th></th></tr></thead><tbody>{runs.map((run) => <tr key={run.runId}><td>{run.startDate} – {run.endDate}</td><td>{new Date(run.createdAt).toLocaleString("pl-PL")}</td><td>{statusLabels[run.status] ?? run.status}</td><td>{run.counters.policies ?? "—"}</td><td>{run.counters.missing_policies ?? "—"}</td><td>{run.counters.wrong_rate_rows ?? "—"}</td><td><button className={styles.rowAction} type="button" onClick={() => changeView("result", run.runId)}>Otwórz wynik</button></td></tr>)}</tbody></table></div>}
    </section>}
  </main>;
}
