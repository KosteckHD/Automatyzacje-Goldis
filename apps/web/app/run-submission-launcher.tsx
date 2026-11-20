"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { automationDraftStorageKey, clearAutomationDraft, readAutomationDraft, writeAutomationDraft, type AutomationDraftAttempt, type AutomationDraftIdentity } from "./tools/oc-policy-verification/automation-draft";
import CompanySelection from "./tools/oc-policy-verification/CompanySelection";

type PreviewItem = { sourceRowId: string; rowNumber: number; companyName: string; nip: string | null; effectiveRegon: string | null; state: "ready" | "review" | "excluded"; reasonCode: string | null; alreadyActive: boolean };
type Preview = {
  selectionFingerprint: string;
  referenceDate: string;
  counts: { selected: number; ready: number; needsReview: number; excluded: number; uniqueGroups: number; alreadyActive: number };
  items: PreviewItem[];
};
type WholePreview = {
  preparationId: string;
  revision: number;
  snapshotFingerprint: string;
  totalRows: number;
  referenceDate: string;
  counts: { ready: number; review: number; duplicates: number; skippedNoIdentifiers: number; waitingRegistry: number };
};
type WholeExecution = {
  executionId: string;
  status: "queued" | "running" | "waiting_attention" | "pause_requested" | "paused" | "completed" | "cancelled" | "failed";
  version: number;
  referenceDate: string;
  totalRows: number;
  chunkCount: number;
  progress: { generatedChunks: number; completedChunks: number; activeChunks: number; waitingChunks: number; failedChunks: number; cancelledChunks: number };
  chunks?: { ordinal: number; firstRowNumber: number; lastRowNumber: number; rowCount: number;
    status: string; childSubmissionId: string | null; finishedAt: string | null }[];
  chunkPage?: { nextAfterOrdinal: number | null };
  errorCode: string | null;
};
type SubmissionSnapshot = {
  submissionId: string; importBatchId: string; referenceDate: string; status: string; version: number;
  counts: { items: Record<string, number>; groups: Record<string, number>; selectedRows: number; uniqueGroups: number };
};
type SubmissionItem = { rowNumber: number; preparationState: string; reasonCode: string | null; runId: string | null; runStatus: string | null; runErrorCode: string | null };
type SubmissionItemsPage = { items: SubmissionItem[]; nextCursor: string | null };

const reasons: Record<string, string> = {
  DUPLICATE_SOURCE_ROW: "duplikat — pominięty w zestawie roboczym; źródłowy import pozostaje zachowany",
  PENDING_REGON_CORRECTION: "oczekuje korekta REGON",
  OPEN_ENTITY_CONFLICT: "otwarty konflikt grupowania",
  REGON_REQUIRED: "brak REGON-u",
  SOURCE_ROW_HAS_ISSUES: "wiersz ma błędy walidacji",
  INVALID_NIP: "nieprawidłowy NIP",
  INVALID_REGON: "nieprawidłowy REGON",
  SAME_NIP_DIFFERENT_REGON: "NIP wskazuje różne numery REGON",
  SAME_REGON_DIFFERENT_NIP: "REGON wskazuje różne numery NIP",
  NAME_MISMATCH: "nazwa firmy wymaga sprawdzenia",
  SOURCE_LINK_MISMATCH: "powiązanie firmy wymaga sprawdzenia",
  ACTIVE_RUN_REFERENCE_DATE_MISMATCH: "aktywne zadanie ma inną datę odniesienia",
  IDENTITY_NOT_FOUND: "brak dopasowania w PZU",
  IDENTITY_PESEL_MISSING: "w PZU brakuje numeru PESEL",
  COMPENSA_CUSTOMER_DATA_INCOMPLETE: "dane klienta w Compensie są niekompletne",
  COMPENSA_PAYER_DATA_SKIPPED: "brak wymaganych danych płatnika — sprawdzanie pominięte",
  MANUAL_DATA_REQUIRED: "sprawdź otwarte zgłoszenie przed wznowieniem",
};
const chunkStatusLabels: Record<string, string> = {
  queued: "w kolejce", submitting: "przekazywana", running: "w toku", waiting_attention: "wymaga uwagi",
  pause_requested: "wstrzymywanie", paused: "wstrzymana", completed: "zakończona", cancelled: "anulowana", failed: "błąd",
};
const submissionCountLabels: Record<string, string> = {
  review: "Do kontroli", excluded: "Pominięte", skipped: "Pominięte: dane płatnika", waiting: "W kolejce", running: "W toku",
  waiting_attention: "Wymaga uwagi", completed: "Zakończone", no_matching_policies: "Bez pasujących polis",
  failed: "Błędy", cancelled: "Anulowane", blocked: "Zablokowane",
};
const submissionItemStatusLabels: Record<string, string> = {
  ready: "Gotowy", review: "Do kontroli", excluded: "Pominięty", duplicate: "Duplikat — pominięty",
  waiting: "W kolejce", queued: "W kolejce", validating: "Sprawdzanie danych", running: "W toku",
  waiting_attention: "Wymaga uwagi", waiting_for_sms: "Oczekuje na kod SMS", completed: "Zakończono",
  no_matching_policies: "Brak pasujących polis", cancelled: "Anulowano", failed: "Błąd", blocked: "Zablokowany",
  awaiting_portal_adapter: "Oczekuje na portale", pzu_login: "Logowanie do PZU", everest_search: "Wyszukiwanie w PZU",
  compensa_login: "Logowanie do Compensy", compensa_form: "Formularz Compensy", ufg_verification: "Weryfikacja UFG",
  reading_oc: "Odczyt polis", export_ready: "Przygotowanie Excela", waiting_for_manual_data: "Wymaga uwagi", identity_review: "Sprawdź dopasowanie",
};

function parseRows(value: string): number[] {
  const tokens = value.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 500 || tokens.some((token) => !/^\d+$/.test(token))) {
    throw new Error("Wpisz od 1 do 500 numerów wierszy, oddzielonych przecinkami lub spacjami.");
  }
  const rows = tokens.map(Number);
  if (rows.some((row) => !Number.isSafeInteger(row) || row < 2) || new Set(rows).size !== rows.length) {
    throw new Error("Numery muszą być różne i zaczynać się od 2 (pierwszy wiersz danych w Excelu).");
  }
  return rows.sort((a, b) => a - b);
}

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string; code?: string };
  if (!response.ok) throw Object.assign(new Error(payload.message || `Żądanie nie powiodło się (${response.status}).`), { status: response.status, code: payload.code });
  return payload;
}

export default function RunSubmissionLauncher({
  batchId, csrfToken, phase = "all", submissionId, executionId, preparationId, preparationRevision, preparationFingerprint, draftIdentity,
  startBlockedReason, onRefreshReadiness, onUnauthorized, onPreviewReady, onStarted, onOpenRun, onOperationStatus,
}: {
  batchId: string;
  csrfToken: string;
  phase?: "all" | "selection" | "launch" | "progress";
  submissionId?: string | null;
  executionId?: string | null;
  preparationId?: string;
  preparationRevision?: number;
  preparationFingerprint?: string;
  draftIdentity?: AutomationDraftIdentity | null;
  startBlockedReason?: string | null;
  onRefreshReadiness?: () => void;
  onUnauthorized?: () => void;
  onPreviewReady?: (preview: { kind: "all" | "selected"; readyCount: number; preparationId: string | null; revision: number | null; fingerprint: string; referenceDate: string } | null) => void;
  onStarted?: (id: string, kind: "submission" | "execution") => void;
  onOpenRun?: (runId: string) => void;
  onOperationStatus?: (status: string) => void;
}) {
  const [mode, setMode] = useState<"range" | "list">("range");
  const [selectionMode, setSelectionMode] = useState<"companies" | "advanced">("companies");
  const [selectedCompanyRows, setSelectedCompanyRows] = useState<number[]>([]);
  const [fromRow, setFromRow] = useState("");
  const [toRow, setToRow] = useState("");
  const [rowList, setRowList] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const idempotencyKey = useRef("");
  const wholeIdempotencyKey = useRef("");
  const [wholePreview, setWholePreview] = useState<WholePreview | null>(null);
  const [wholeExecution, setWholeExecution] = useState<WholeExecution | null>(null);
  const [chunkAfterOrdinal, setChunkAfterOrdinal] = useState(0);
  const [wholeConfirmed, setWholeConfirmed] = useState(false);
  const [wholeBusy, setWholeBusy] = useState(false);
  const [wholeError, setWholeError] = useState("");
  const [wholeNotice, setWholeNotice] = useState("");
  const [submission, setSubmission] = useState<SubmissionSnapshot | null>(null);
  const loadedSubmissionPages = useRef(1);
  const [submissionItems, setSubmissionItems] = useState<SubmissionItem[]>([]);
  const [submissionCursor, setSubmissionCursor] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState("");
  const [pendingAttempt, setPendingAttempt] = useState<AutomationDraftAttempt | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const [draftLoadedContext, setDraftLoadedContext] = useState("");
  const [draftCleared, setDraftCleared] = useState(false);
  const [draftPaused, setDraftPaused] = useState(false);
  const draftKey = draftIdentity ? automationDraftStorageKey(draftIdentity, batchId) : null;
  const draftContext = `${draftKey ?? ""}:${preparationId ?? ""}:${preparationRevision ?? ""}:${preparationFingerprint ?? ""}`;

  function getSessionStorage(): Storage | null {
    try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
  }

  function saveDraft(attempt: AutomationDraftAttempt | null = pendingAttempt) {
    if (!draftKey || !draftIdentity || !preparationId || preparationRevision === undefined || !preparationFingerprint) return;
    const storage = getSessionStorage();
    writeAutomationDraft(storage, draftKey, {
      version: 1, tenantId: draftIdentity.tenantId, userId: draftIdentity.userId, batchId,
      preparationId, revision: preparationRevision, sourceFingerprint: preparationFingerprint,
      mode, selectionMode, selectedRows: selectedCompanyRows, fromRow, toRow, rowList,
      updatedAt: new Date().toISOString(), pendingAttempt: attempt,
    });
  }

  function markDraftEdited() { setDraftCleared(false); setDraftPaused(false); }

  function clearSavedSelection() {
    if (draftKey) clearAutomationDraft(getSessionStorage(), draftKey);
    setDraftCleared(true); setDraftPaused(true);
    setSelectionMode("companies"); setMode("range"); setSelectedCompanyRows([]);
    setFromRow(""); setToRow(""); setRowList(""); setPendingAttempt(null);
    setDraftNotice("Zapisany wybór został wyczyszczony.");
    invalidatePreviews();
  }

  function invalidatePreviews() {
    setPreview(null); setConfirmed(false); idempotencyKey.current = "";
    setWholePreview(null); setWholeConfirmed(false); wholeIdempotencyKey.current = "";
    onPreviewReady?.(null);
  }

  useEffect(() => {
    invalidatePreviews();
    // A changed preparation revision invalidates both the preview and its confirmation.
  }, [batchId, preparationId, preparationRevision, preparationFingerprint]);

  useEffect(() => {
    setPreview(null); setConfirmed(false); setWholePreview(null); setWholeConfirmed(false);
    const storage = getSessionStorage();
    const stored = draftKey ? readAutomationDraft(storage, draftKey) : null;
    const matchesIdentity = Boolean(stored && draftIdentity && stored.tenantId === draftIdentity.tenantId
      && stored.userId === draftIdentity.userId && stored.batchId === batchId);
    const samePreparation = Boolean(matchesIdentity && stored?.preparationId === preparationId
      && stored?.revision === preparationRevision && stored?.sourceFingerprint === preparationFingerprint);
    if (samePreparation && stored) {
      setMode(stored.mode); setSelectionMode(stored.selectionMode); setSelectedCompanyRows(stored.selectedRows);
      setFromRow(stored.fromRow); setToRow(stored.toRow); setRowList(stored.rowList);
      setPendingAttempt(stored.pendingAttempt);
      setDraftNotice(stored.pendingAttempt
        ? "Nie wiadomo, czy wcześniejszy start został zapisany. Ponów tę samą próbę, aby odtworzyć jej wynik."
        : "Przywrócono wybór. Przygotuj nowe podsumowanie przed startem.");
    } else {
      setMode("range"); setSelectionMode("companies"); setSelectedCompanyRows([]);
      setFromRow(""); setToRow(""); setRowList("");
      setPendingAttempt(matchesIdentity ? stored?.pendingAttempt ?? null : null);
      setDraftNotice(matchesIdentity && stored?.pendingAttempt
        ? "Zachowano nierozstrzygniętą próbę z wcześniejszej rewizji. Ponów ją dokładnie w tej postaci przed wyborem nowego zakresu."
        : matchesIdentity ? "Dane przygotowania zmieniły się. Wybierz firmy ponownie i sprawdź nowe podsumowanie." : "");
    }
    setDraftCleared(false);
    setDraftPaused(false);
    setDraftLoadedContext(draftContext);
  }, [draftContext, draftKey, draftIdentity?.tenantId, draftIdentity?.userId, batchId, preparationId, preparationRevision, preparationFingerprint]);

  useEffect(() => {
    if (!draftKey || draftLoadedContext !== draftContext) return;
    if (draftCleared) { clearAutomationDraft(getSessionStorage(), draftKey); return; }
    if (draftPaused) return;
    saveDraft();
  }, [draftKey, draftContext, draftLoadedContext, draftCleared, draftPaused, mode, selectionMode, selectedCompanyRows, fromRow, toRow, rowList, pendingAttempt]);

  useEffect(() => {
    if (!executionId || executionId === wholeExecution?.executionId) return;
    let active = true;
    fetch(`/api/imports/${batchId}/prepared-set-executions/${executionId}`, { credentials: "same-origin" })
      .then((response) => readPayload<WholeExecution>(response))
      .then((current) => { if (active) { setWholeExecution(current); setChunkAfterOrdinal(0); onOperationStatus?.(current.status); } })
      .catch((cause) => { if (active) setWholeError(cause instanceof Error ? cause.message : "Nie udało się otworzyć wykonania."); });
    return () => { active = false; };
  }, [batchId, executionId, wholeExecution?.executionId, onOperationStatus]);

  useEffect(() => {
    setSubmission(null);
    setSubmissionItems([]);
    loadedSubmissionPages.current = 1;
    setSubmissionCursor(null);
    setSubmissionError("");
    if (!submissionId) return;
    let stopped = false;
    let timer: number | null = null;
    let busyReading = false;
    const refresh = async () => {
      if (busyReading || stopped) return;
      busyReading = true;
      try {
        const summaryResponse = await fetch(`/api/run-submissions/${submissionId}`, { credentials: "same-origin" });
        const current = await readPayload<SubmissionSnapshot>(summaryResponse);
        if (stopped) return;
        if (current.importBatchId !== batchId) {
          setSubmissionError("Zgłoszenie należy do innego importu. Otwórz je z jego historii.");
          return;
        }
        setSubmission(current);
        onOperationStatus?.(current.status);
        {
          const allItems: SubmissionItemsPage["items"] = [];
          let nextCursor: string | null = null;
          for (let pageIndex = 0; pageIndex < loadedSubmissionPages.current; pageIndex += 1) {
            const suffix: string = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
            const page: SubmissionItemsPage = await readPayload<SubmissionItemsPage>(await fetch(`/api/run-submissions/${submissionId}/items${suffix}`, { credentials: "same-origin" }));
            if (stopped) return;
            allItems.push(...(page.items ?? []));
            nextCursor = page.nextCursor ?? null;
            if (!nextCursor) break;
          }
          setSubmissionItems(allItems);
          setSubmissionCursor(nextCursor);
        }
        setSubmissionError("");
        if (!["completed", "cancelled"].includes(current.status)) timer = window.setTimeout(() => void refresh(), 4_000);
      } catch (cause) {
        if (!stopped) {
          setSubmissionError(cause instanceof Error ? cause.message : "Nie udało się odświeżyć zgłoszenia.");
          timer = window.setTimeout(() => void refresh(), 12_000);
        }
      } finally { busyReading = false; }
    };
    void refresh();
    return () => { stopped = true; if (timer !== null) window.clearTimeout(timer); };
  }, [batchId, submissionId, onOperationStatus]);

  useEffect(() => {
    if (!wholeExecution || ["paused", "completed", "cancelled", "failed"].includes(wholeExecution.status)) return;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const cursor = chunkAfterOrdinal > 0 ? `?afterOrdinal=${chunkAfterOrdinal}` : "";
        const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/${wholeExecution.executionId}${cursor}`, { credentials: "same-origin" });
        const current = await readPayload<WholeExecution>(response);
        if (!stopped) { setWholeExecution(current); setWholeError(""); onOperationStatus?.(current.status); }
      } catch (cause) {
        if (!stopped) setWholeError(cause instanceof Error ? cause.message : "Nie udało się odświeżyć stanu całego importu.");
      } finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [batchId, wholeExecution?.executionId, wholeExecution?.status, chunkAfterOrdinal, onOperationStatus]);

  async function previewWholeImport() {
    if (wholeBusy) return;
    setWholeBusy(true); setWholeError(""); setWholeNotice(""); setWholePreview(null); setWholeConfirmed(false);
    setPreview(null); setConfirmed(false); onPreviewReady?.(null);
    try {
      const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/preview`, { credentials: "same-origin" });
      const current = await readPayload<WholePreview>(response);
      setWholePreview(current);
      wholeIdempotencyKey.current = "";
      setWholeNotice("Podgląd obejmuje całą najnowszą, zakończoną rewizję przygotowania. Żadne zadanie nie zostało jeszcze uruchomione.");
      onPreviewReady?.({ kind: "all", readyCount: current.counts.ready, preparationId: current.preparationId, revision: current.revision, fingerprint: current.snapshotFingerprint, referenceDate: current.referenceDate });
    } catch (cause) { setWholeError(cause instanceof Error ? cause.message : "Nie udało się przygotować podglądu całego importu."); }
    finally { setWholeBusy(false); }
  }

  async function startWholeImport() {
    if (!wholePreview || !wholeConfirmed || wholeBusy || startBlockedReason || pendingAttempt) return;
    if (!csrfToken) { setWholeError("Brak tokenu bezpieczeństwa sesji. Odśwież stronę."); return; }
    if (!wholeIdempotencyKey.current) wholeIdempotencyKey.current = crypto.randomUUID();
    const payload = { idempotencyKey: wholeIdempotencyKey.current,
      preparationId: wholePreview.preparationId, snapshotFingerprint: wholePreview.snapshotFingerprint };
    await executeAttempt({ kind: "all", preparationId: wholePreview.preparationId, revision: wholePreview.revision,
      sourceFingerprint: preparationFingerprint ?? wholePreview.snapshotFingerprint,
      idempotencyKey: wholeIdempotencyKey.current, payload });
  }

  async function cancelWholeImport() {
    if (!wholeExecution || wholeBusy || !csrfToken) return;
    setWholeBusy(true); setWholeError("");
    try {
      const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/${wholeExecution.executionId}/cancel`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: wholeExecution.version }),
      });
      const execution = await readPayload<WholeExecution>(response);
      setWholeExecution(execution);
      onOperationStatus?.(execution.status);
      setChunkAfterOrdinal(0);
    } catch (cause) { setWholeError(cause instanceof Error ? cause.message : "Nie udało się anulować całego importu."); }
    finally { setWholeBusy(false); }
  }

  async function setWholeImportControl(action: "pause" | "resume") {
    if (!wholeExecution || wholeBusy || !csrfToken) return;
    setWholeBusy(true); setWholeError("");
    try {
      const response = await fetch(`/api/imports/${batchId}/prepared-set-executions/${wholeExecution.executionId}/${action}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: wholeExecution.version }),
      });
      const execution = await readPayload<WholeExecution>(response);
      setWholeExecution(execution);
      onOperationStatus?.(execution.status);
      setChunkAfterOrdinal(0);
    } catch (cause) { setWholeError(cause instanceof Error ? cause.message : action === "pause" ? "Nie udało się wstrzymać całego importu." : "Nie udało się wznowić całego importu."); }
    finally { setWholeBusy(false); }
  }

  const wholeExecutionTerminal = wholeExecution && ["completed", "cancelled", "failed"].includes(wholeExecution.status);

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setPreview(null); setConfirmed(false); idempotencyKey.current = "";
    setWholePreview(null); setWholeConfirmed(false); wholeIdempotencyKey.current = ""; onPreviewReady?.(null);
    try {
      if (!csrfToken) throw new Error("Brak tokenu bezpieczeństwa sesji. Odśwież stronę.");
      const selection = selectionMode === "companies"
        ? { rowNumbers: selectedCompanyRows }
        : mode === "range"
        ? { fromRow: Number(fromRow), toRow: Number(toRow) }
        : { rowNumbers: parseRows(rowList) };
      if (selectionMode === "companies" && selectedCompanyRows.length === 0)
        throw new Error("Zaznacz przynajmniej jedną firmę albo wybierz wszystkie gotowe firmy.");
      const response = await fetch(`/api/imports/${batchId}/run-submissions/preview`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(selection),
      });
      const current = await readPayload<Preview>(response);
      setPreview(current);
      setNotice("Podgląd jest aktualny. Zgłoszenie nie uruchamia jeszcze zadań.");
      onPreviewReady?.({ kind: "selected", readyCount: current.counts.ready, preparationId: preparationId ?? null, revision: preparationRevision ?? null, fingerprint: current.selectionFingerprint, referenceDate: current.referenceDate });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się przygotować podglądu."); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!preview || !confirmed || busy || startBlockedReason || pendingAttempt) return;
    if (!csrfToken) { setError("Brak tokenu bezpieczeństwa sesji. Odśwież stronę."); return; }
    const selection = selectionMode === "companies"
      ? { rowNumbers: selectedCompanyRows }
      : mode === "range"
      ? { fromRow: Number(fromRow), toRow: Number(toRow) }
      : { rowNumbers: parseRows(rowList) };
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    const payload = { ...selection, selectionFingerprint: preview.selectionFingerprint, idempotencyKey: idempotencyKey.current };
    if (!preparationId || preparationRevision === undefined || !preparationFingerprint) {
      setError("Nie można potwierdzić rewizji przygotowania. Odśwież etap przygotowania i sprawdź podsumowanie ponownie."); return;
    }
    await executeAttempt({ kind: "selected", preparationId, revision: preparationRevision,
      sourceFingerprint: preparationFingerprint, idempotencyKey: idempotencyKey.current, payload });
  }

  async function executeAttempt(attempt: AutomationDraftAttempt) {
    if (pendingAttempt && (pendingAttempt.idempotencyKey !== attempt.idempotencyKey || pendingAttempt.kind !== attempt.kind)) return;
    if (!csrfToken) { setError("Sesja wymaga odświeżenia. Zaloguj się ponownie, aby wznowić tę samą próbę."); return; }
    setPendingAttempt(attempt); setDraftNotice("Próba startu została zapisana lokalnie na wypadek utraty odpowiedzi.");
    saveDraft(attempt); onPreviewReady?.(null);
    if (attempt.kind === "all") { setWholeBusy(true); setWholeError(""); setWholeNotice(""); }
    else { setBusy(true); setError(""); setNotice(""); }
    try {
      const response = await fetch(attempt.kind === "all"
        ? `/api/imports/${batchId}/prepared-set-executions`
        : `/api/imports/${batchId}/run-submissions`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(attempt.payload),
      });
      if (response.status === 401) { onUnauthorized?.(); throw Object.assign(new Error("Sesja wygasła. Próba została zachowana."), { status: 401 }); }
      if (attempt.kind === "all") {
        const execution = await readPayload<WholeExecution>(response);
        if (!execution.executionId) throw new Error("Odpowiedź nie zawiera identyfikatora uruchomienia.");
        setWholeExecution(execution); setChunkAfterOrdinal(0); onOperationStatus?.(execution.status);
        onStarted?.(execution.executionId, "execution");
        setWholeNotice("Uruchomienie zapisano. Postęp aktualizuje się automatycznie.");
      } else {
        const created = await readPayload<{ submissionId: string }>(response);
        if (!created.submissionId) throw new Error("Odpowiedź nie zawiera identyfikatora zgłoszenia.");
        if (phase === "all") window.location.assign(`/submissions/${created.submissionId}`);
        else onStarted?.(created.submissionId, "submission");
      }
      setPendingAttempt(null); setDraftNotice(""); setDraftCleared(true);
      if (draftKey) clearAutomationDraft(getSessionStorage(), draftKey);
      setPreview(null); setConfirmed(false); setWholePreview(null); setWholeConfirmed(false);
      onPreviewReady?.(null);
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      const isConflict = status === 409;
      if (isConflict) {
        setPendingAttempt(null); setDraftNotice(""); setPreview(null); setConfirmed(false); setWholePreview(null); setWholeConfirmed(false);
        onPreviewReady?.(null); saveDraft(null);
        const message = "Przygotowane dane lub wybór zmieniły się po podglądzie. Sprawdź rewizję i przygotuj nowe podsumowanie.";
        if (attempt.kind === "all") setWholeError(message); else setError(message);
      } else if (status && status >= 400 && status < 500 && status !== 401) {
        setPendingAttempt(null); setDraftNotice(""); saveDraft(null);
        const message = cause instanceof Error ? cause.message : "Serwer odrzucił próbę uruchomienia.";
        if (attempt.kind === "all") setWholeError(message); else setError(message);
      } else {
        setPendingAttempt(attempt);
        setDraftNotice("Nie wiadomo, czy start został zapisany. Użyj wyłącznie „Ponów tę samą próbę”; zachowamy ten sam zakres i klucz.");
        saveDraft(attempt);
        const message = cause instanceof Error ? cause.message : "Nie otrzymano potwierdzenia startu.";
        if (attempt.kind === "all") setWholeError(message); else setError(message);
      }
    } finally {
      if (attempt.kind === "all") setWholeBusy(false); else setBusy(false);
    }
  }

  async function resumePendingAttempt() {
    if (!pendingAttempt || busy || wholeBusy) return;
    await executeAttempt(pendingAttempt);
  }

  async function loadMoreSubmissionItems() {
    if (!submissionId || !submissionCursor) return;
    try {
      const response = await fetch(`/api/run-submissions/${submissionId}/items?cursor=${encodeURIComponent(submissionCursor)}`, { credentials: "same-origin" });
      const page = await readPayload<SubmissionItemsPage>(response);
      loadedSubmissionPages.current += 1;
      setSubmissionItems((current) => [...current, ...(page.items ?? [])]);
      setSubmissionCursor(page.nextCursor ?? null);
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : "Nie udało się pobrać kolejnych wierszy zgłoszenia.");
    }
  }

  async function cancelSubmission() {
    if (!submission || !csrfToken || busy || ["completed", "cancelled"].includes(submission.status)) return;
    setBusy(true);
    setSubmissionError("");
    try {
      const response = await fetch(`/api/run-submissions/${submission.submissionId}/cancel`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: submission.version }),
      });
      await readPayload(response);
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : "Nie udało się anulować zgłoszenia.");
    } finally { setBusy(false); }
  }

  async function setSubmissionControl(action: "pause" | "resume") {
    if (!submission || !csrfToken || busy) return;
    setBusy(true);
    setSubmissionError("");
    try {
      const response = await fetch(`/api/run-submissions/${submission.submissionId}/${action}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ expectedVersion: submission.version }),
      });
      setSubmission(await readPayload<SubmissionSnapshot>(response));
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : action === "pause" ? "Nie udało się wstrzymać zgłoszenia." : "Nie udało się wznowić zgłoszenia.");
    } finally { setBusy(false); }
  }

  if (pendingAttempt) {
    return <section className={`result-section submission-launcher${phase !== "all" ? " oc-operation" : ""}`} aria-labelledby="submission-pending-title">
      <div className="section-head"><div><p className="eyebrow">START WYMAGA POTWIERDZENIA</p><h2 id="submission-pending-title">Nie otrzymaliśmy potwierdzenia uruchomienia</h2></div></div>
      <p className="submission-notice" role="status">{draftNotice || "Zapisaliśmy próbę lokalnie. Ponowienie użyje tych samych danych i tego samego klucza, więc nie utworzy drugiego zgłoszenia."}</p>
      <dl className="submission-counts">
        <div><dt>Tryb</dt><dd>{pendingAttempt.kind === "all" ? "Cały przygotowany import" : "Wybrane firmy"}</dd></div>
        <div><dt>Rewizja przygotowania</dt><dd>{pendingAttempt.revision}</dd></div>
        <div><dt>Id próby</dt><dd>{pendingAttempt.idempotencyKey.slice(0, 8)}…</dd></div>
      </dl>
      <button className="submission-primary" type="button" onClick={() => void resumePendingAttempt()} disabled={busy || wholeBusy || !csrfToken}>
        {busy || wholeBusy ? "Ponawiam tę samą próbę…" : "Ponów tę samą próbę"}
      </button>
      {!csrfToken && <p className="submission-notice" role="status">Zaloguj się ponownie. Próba pozostaje zachowana i będzie dostępna po powrocie do tego importu.</p>}
      <p className="submission-notice">Nie zmieniaj zakresu ani rewizji, dopóki ta próba nie zostanie rozstrzygnięta.</p>
      {(error || wholeError) && <p className="error" role="alert">{error || wholeError}</p>}
    </section>;
  }

  if (phase !== "all") {
    return <section className="result-section submission-launcher oc-operation" aria-label={phase === "selection" ? "Wybór firm do sprawdzenia" : phase === "launch" ? "Podsumowanie i uruchomienie" : "Postęp automatyzacji"}>
      {draftNotice && <p className="submission-notice" role="status">{draftNotice}</p>}
      <button type="button" className="lead-secondary" onClick={clearSavedSelection} disabled={!draftKey}>Wyczyść zapisany wybór</button>
      {phase === "selection" && <>
        <div className="prepared-set-control" aria-labelledby="oc-whole-title">
          <div><h3 id="oc-whole-title">Wszystkie gotowe firmy</h3><p>System użyje najnowszej zamkniętej rewizji i podzieli ją na porcje do 500. Przed startem pokaże liczbę gotowych firm i problemów.</p></div>
          {(!wholeExecution || wholeExecutionTerminal) && <button className="submission-primary" type="button" onClick={() => void previewWholeImport()} disabled={wholeBusy || !csrfToken}>{wholeBusy ? "Przygotowuję podsumowanie…" : "Przejdź do podsumowania całego importu"}</button>}
          {wholeError && <p className="error" role="alert">{wholeError}</p>}
        </div>
        <div className="submission-mode company-selection-mode" role="group" aria-label="Tryb wyboru firm">
          <button type="button" aria-pressed={selectionMode === "companies"} onClick={() => { markDraftEdited(); setSelectionMode("companies"); invalidatePreviews(); }}>Wybierz firmy</button>
          <button type="button" aria-pressed={selectionMode === "advanced"} onClick={() => { markDraftEdited(); setSelectionMode("advanced"); invalidatePreviews(); }}>Zakres lub numery wierszy</button>
        </div>
        {selectionMode === "companies" && <CompanySelection batchId={batchId} preparationId={preparationId}
          selectedRows={selectedCompanyRows} onUnauthorized={() => onUnauthorized?.()}
          onChange={(rows) => { markDraftEdited(); setSelectedCompanyRows(rows); invalidatePreviews(); }} />}
        {selectionMode === "companies" && <form className="submission-selection" onSubmit={requestPreview}>
          <p>Podgląd obejmie wyłącznie zaznaczone firmy; zaznaczanie dotyczy tylko bieżącej strony, a wybór zachowuje się między stronami.</p>
          <button type="submit" disabled={busy || !csrfToken || selectedCompanyRows.length === 0}>{busy ? "Przygotowuję podsumowanie…" : `Przejdź do podsumowania (${selectedCompanyRows.length})`}</button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>}
        {selectionMode === "advanced" && <form className="submission-selection" onSubmit={requestPreview}>
          <div className="submission-mode" role="group" aria-label="Sposób wyboru wierszy">
            <button type="button" aria-pressed={mode === "range"} onClick={() => { markDraftEdited(); setMode("range"); invalidatePreviews(); }}>Zakres</button>
            <button type="button" aria-pressed={mode === "list"} onClick={() => { markDraftEdited(); setMode("list"); invalidatePreviews(); }}>Lista numerów</button>
          </div>
          {mode === "range" ? <div className="submission-fields">
            <label>Od wiersza<input name="from-row" autoComplete="off" type="number" min="2" max="100000000" step="1" value={fromRow} onChange={(event) => { markDraftEdited(); setFromRow(event.target.value); invalidatePreviews(); }} required /></label>
            <label>Do wiersza<input name="to-row" autoComplete="off" type="number" min="2" max="100000000" step="1" value={toRow} onChange={(event) => { markDraftEdited(); setToRow(event.target.value); invalidatePreviews(); }} required /></label>
          </div> : <label className="submission-row-list">Numery wierszy z Excela<textarea name="row-list" autoComplete="off" rows={3} value={rowList} onChange={(event) => { markDraftEdited(); setRowList(event.target.value); invalidatePreviews(); }} placeholder="np. 2, 4, 8, 9, 10…" aria-describedby="submission-list-help" required /></label>}
          {mode === "list" && <small id="submission-list-help">Oddziel numery przecinkiem, średnikiem lub spacją; maksymalnie 500 wierszy.</small>}
          <button type="submit" disabled={busy || !csrfToken}>{busy ? "Przygotowuję podgląd…" : "Sprawdź wybrane wiersze"}</button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>}
      </>}
      {phase === "launch" && <>
        {startBlockedReason && <p className="submission-notice" role="status">{startBlockedReason}{onRefreshReadiness && <> <button type="button" onClick={onRefreshReadiness}>Sprawdź gotowość ponownie</button></>}</p>}
        {wholePreview && <div className="prepared-set-preview">
          <h3>Cały import · rewizja {wholePreview.revision} · data {wholePreview.referenceDate}</h3>
          <dl className="submission-counts"><div><dt>Wszystkie wiersze</dt><dd>{wholePreview.totalRows}</dd></div><div><dt>Gotowe</dt><dd>{wholePreview.counts.ready}</dd></div><div><dt>Do kontroli</dt><dd>{wholePreview.counts.review}</dd></div><div><dt>Duplikaty</dt><dd>{wholePreview.counts.duplicates}</dd></div><div><dt>Bez NIP i REGON</dt><dd>{wholePreview.counts.skippedNoIdentifiers}</dd></div><div><dt>Oczekuje REGON</dt><dd>{wholePreview.counts.waitingRegistry}</dd></div></dl>
          <details className="prepared-set-company-review"><summary>Przejrzyj firmy z tej rewizji</summary>
            <CompanySelection key={`whole-preview-${wholePreview.preparationId}-${wholePreview.revision}`} batchId={batchId}
              preparationId={wholePreview.preparationId} selectedRows={[]} onChange={() => undefined}
              onUnauthorized={() => onUnauthorized?.()} readOnly />
          </details>
          {wholePreview.counts.ready > 0 ? <><label className="submission-confirm"><input type="checkbox" checked={wholeConfirmed} onChange={(event) => setWholeConfirmed(event.target.checked)} />Potwierdzam uruchomienie wszystkich {wholePreview.counts.ready} gotowych wierszy.</label><button className="submission-primary" type="button" onClick={() => void startWholeImport()} disabled={wholeBusy || !wholeConfirmed || Boolean(startBlockedReason)}>{wholeBusy ? "Zapisuję zestaw…" : "Potwierdź i uruchom cały import"}</button></> : <p className="submission-notice">Brak gotowych wierszy. Rozstrzygnij problemy i przygotuj nową rewizję.</p>}
        </div>}
        {preview && <div className="submission-preview">
          <h3>Wybrane wiersze · data {preview.referenceDate}</h3>
          <dl className="submission-counts"><div><dt>Wybrane</dt><dd>{preview.counts.selected}</dd></div><div><dt>Gotowe</dt><dd>{preview.counts.ready}</dd></div><div><dt>Do kontroli</dt><dd>{preview.counts.needsReview}</dd></div><div><dt>Pominięte</dt><dd>{preview.counts.excluded}</dd></div><div><dt>Osobne zadania</dt><dd>{preview.counts.uniqueGroups}</dd></div><div><dt>Już aktywne</dt><dd>{preview.counts.alreadyActive}</dd></div></dl>
          <div className="submission-preview-list" role="region" aria-label="Firmy w podsumowaniu" tabIndex={0}><ul>{preview.items.map((item) => <li key={item.sourceRowId}><strong>{item.companyName || "Firma bez nazwy"}</strong><span className={`submission-state submission-state--${item.state}`}>{item.state === "ready" ? "Zostanie sprawdzona" : item.state === "review" ? "Wymaga kontroli" : "Zostanie pominięta"}</span><small>NIP: {item.nip || "—"} · REGON: {item.effectiveRegon || "—"} · wiersz {item.rowNumber}{item.reasonCode ? ` · ${reasons[item.reasonCode] ?? "wymaga dodatkowej kontroli"}` : item.alreadyActive ? " · zadanie dla tej firmy już działa" : ""}</small></li>)}</ul></div>
          {preview.counts.ready > 0 && <label className="submission-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Rozumiem podsumowanie i potwierdzam utworzenie maksymalnie {preview.counts.uniqueGroups} zadań.</label>}
          {preview.counts.ready === 0 ? <p className="submission-notice">Brak gotowych wierszy. Rozstrzygnij wskazane problemy i przygotuj nowy podgląd.</p> : <button className="submission-primary" type="button" onClick={() => void submit()} disabled={busy || !confirmed || Boolean(startBlockedReason)}>{busy ? "Zapisuję zgłoszenie…" : "Potwierdź i uruchom gotowe wiersze"}</button>}
        </div>}
        {!wholePreview && !preview && <p className="submission-notice">Nie ma aktualnego podglądu. Wróć do wyboru wierszy i sprawdź zakres.</p>}
        {wholeError && <p className="error" role="alert">{wholeError}</p>}{error && <p className="error" role="alert">{error}</p>}
      </>}
      {phase === "progress" && <div className="oc-execution-progress" aria-live="polite">
        {wholeExecution && <div className="prepared-set-progress">
          <div className="prepared-set-progress-head"><h3>Cały import · {chunkStatusLabels[wholeExecution.status] ?? "stan nieznany"}</h3>
            {wholeExecution.status !== "paused" && wholeExecution.status !== "pause_requested" && !["completed", "cancelled", "failed"].includes(wholeExecution.status) && <button type="button" onClick={() => void setWholeImportControl("pause")} disabled={wholeBusy || !csrfToken}>Wstrzymaj po bieżącej porcji</button>}
            {wholeExecution.status === "paused" && <button type="button" onClick={() => void setWholeImportControl("resume")} disabled={wholeBusy || !csrfToken}>Wznów import</button>}
            {!(["completed", "cancelled", "failed"].includes(wholeExecution.status)) && <button type="button" onClick={() => void cancelWholeImport()} disabled={wholeBusy || !csrfToken}>Anuluj cały zestaw</button>}
          </div>
          <p>{wholeExecution.progress.completedChunks} z {wholeExecution.chunkCount || "…"} porcji zakończonych; {wholeExecution.progress.generatedChunks} utworzonych, {wholeExecution.totalRows} wierszy.</p>
          {wholeExecution.status === "pause_requested" && <p className="submission-notice">Nowe porcje nie będą przyjmowane. Bieżąca dojdzie do bezpiecznego punktu.</p>}
          {wholeExecution.status === "paused" && <p className="submission-notice">Wznowienie kontynuuje od zapisanej porcji.</p>}
          {!!wholeExecution.chunks?.length && <ul className="prepared-set-chunks">{wholeExecution.chunks.map((chunk) => <li key={chunk.ordinal}><strong>Porcja {chunk.ordinal}</strong><span>wiersze {chunk.firstRowNumber}–{chunk.lastRowNumber} · {chunk.rowCount} rekordów</span><small>{chunkStatusLabels[chunk.status] ?? chunk.status}</small></li>)}</ul>}
        </div>}
        {submissionId && <div className="prepared-set-progress">
          <div className="prepared-set-progress-head"><h3>Zgłoszenie · {submission?.status === "paused" ? "wstrzymane" : submission?.status === "queued" ? "w kolejce" : submission?.status === "running" ? "w toku" : submission?.status === "waiting_attention" ? "wymaga uwagi" : submission?.status === "completed" ? "zakończone" : submission?.status === "cancelled" ? "anulowane" : "odczytywanie"}</h3>
            {submission && submission.status === "paused" && <button type="button" onClick={() => void setSubmissionControl("resume")} disabled={busy || !csrfToken}>Wznów przyjmowanie zadań</button>}
            {submission && !["completed", "cancelled", "paused"].includes(submission.status) && <button type="button" onClick={() => void setSubmissionControl("pause")} disabled={busy || !csrfToken}>Wstrzymaj nowe zadania</button>}
            {submission && !["completed", "cancelled"].includes(submission.status) && <button type="button" onClick={() => void cancelSubmission()} disabled={busy || !csrfToken}>Anuluj dalsze przyjmowanie</button>}
          </div>
          {submission && <><p>Data odniesienia: {submission.referenceDate} · {submission.counts.selectedRows} wierszy · {submission.counts.uniqueGroups} osobnych zadań</p>
            {submission.status === "paused" && <p className="submission-notice">Wstrzymano przyjmowanie nowych zadań. Zadania już przyjęte są kontynuowane; wznowienie obejmie tylko pozostałe rekordy.</p>}
            <dl className="submission-counts">{Object.entries(submission.counts.items).map(([key, count]) => <div key={key}><dt>{submissionCountLabels[key] ?? "Pozostałe"}</dt><dd>{count}</dd></div>)}</dl>
            <div className="submission-preview-list" role="region" aria-label="Postęp dla wybranych wierszy" tabIndex={0}><ul>{submissionItems.map((item) => <li key={item.rowNumber}><strong>Wiersz {item.rowNumber}</strong><span>{item.runErrorCode === "COMPENSA_PAYER_DATA_SKIPPED" ? "Pominięto: dane płatnika" : submissionItemStatusLabels[item.runStatus ?? item.preparationState] ?? "Stan wymaga sprawdzenia"}</span><small>{reasons[item.runErrorCode ?? item.reasonCode ?? ""] ?? (item.runId ? "zadanie zapisane" : "oczekuje na przyjęcie")}</small>{item.runId && onOpenRun && <button type="button" onClick={() => onOpenRun(item.runId!)}>Otwórz zadanie</button>}</li>)}</ul></div>
            {submissionCursor && <button type="button" onClick={() => void loadMoreSubmissionItems()}>Pokaż kolejne wiersze</button>}
          </>}
          {submissionError && <p className="error" role="alert">{submissionError}</p>}
        </div>}
        {!wholeExecution && !submissionId && <p className="submission-notice">Wybierz wykonanie lub zadanie, aby wyświetlić postęp.</p>}
      </div>}
    </section>;
  }

  return <section className="result-section submission-launcher" aria-labelledby="submission-launch-title">
    <div className="section-head"><div><p className="eyebrow">URUCHOMIENIE PARTII</p><h2 id="submission-launch-title">Sprawdź wiele wierszy</h2></div></div>
    {draftNotice && <p className="submission-notice" role="status">{draftNotice}</p>}
    <button type="button" className="lead-secondary" onClick={clearSavedSelection} disabled={!draftKey}>Wyczyść zapisany wybór</button>
    <p>Najpierw zobaczysz, które wiersze są gotowe, wymagają kontroli lub zostaną pominięte. Zadania powstaną dopiero po osobnym potwierdzeniu.</p>
    <div className="prepared-set-control" aria-labelledby="prepared-set-title">
      <div><h3 id="prepared-set-title">Wszystkie gotowe firmy</h3>
        <p>System użyje najnowszej zakończonej rewizji, zachowa rozliczenie duplikatów i podzieli wszystkie wiersze na porcje do 500. Przed startem pokaże podsumowanie gotowości. Pauza czeka na bezpieczny koniec przyjętej porcji; anulowanie kończy dalsze porcje.</p></div>
      {(!wholeExecution || wholeExecutionTerminal) && <button className="submission-primary" type="button" onClick={() => void previewWholeImport()} disabled={wholeBusy || !csrfToken}>
        {wholeBusy ? "Sprawdzam przygotowanie…" : wholeExecution ? "Przygotuj nowe wykonanie" : "Przejdź do podsumowania całego importu"}
      </button>}
      {wholeError && <p className="error" role="alert">{wholeError}</p>}
      {wholeNotice && !wholeError && <p className="submission-notice" role="status">{wholeNotice}</p>}
      {wholePreview && <div className="prepared-set-preview">
        <h4>Rewizja {wholePreview.revision} · data {wholePreview.referenceDate}</h4>
        <dl className="submission-counts">
          <div><dt>Wszystkie wiersze</dt><dd>{wholePreview.totalRows}</dd></div>
          <div><dt>Gotowe do sprawdzenia</dt><dd>{wholePreview.counts.ready}</dd></div>
          <div><dt>Do kontroli</dt><dd>{wholePreview.counts.review}</dd></div>
          <div><dt>Duplikaty</dt><dd>{wholePreview.counts.duplicates}</dd></div>
          <div><dt>Bez NIP i REGON</dt><dd>{wholePreview.counts.skippedNoIdentifiers}</dd></div>
          <div><dt>Oczekuje REGON</dt><dd>{wholePreview.counts.waitingRegistry}</dd></div>
        </dl>
        <details className="prepared-set-company-review"><summary>Przejrzyj firmy z tej rewizji</summary>
          <CompanySelection key={`whole-preview-${wholePreview.preparationId}-${wholePreview.revision}`} batchId={batchId}
            preparationId={wholePreview.preparationId} selectedRows={[]} onChange={() => undefined}
            onUnauthorized={() => onUnauthorized?.()} readOnly />
        </details>
        {wholePreview.counts.ready > 0 ? <>
          <label className="submission-confirm"><input type="checkbox" checked={wholeConfirmed} onChange={(event) => setWholeConfirmed(event.target.checked)} />Potwierdzam uruchomienie wszystkich {wholePreview.counts.ready} gotowych wierszy z tej rewizji.</label>
          <button className="submission-primary" type="button" onClick={() => void startWholeImport()} disabled={wholeBusy || !wholeConfirmed}>
            {wholeBusy ? "Zapisuję zestaw…" : "Potwierdź i uruchom cały import"}
          </button>
        </> : <p className="submission-notice">Nie ma gotowych wierszy. Rozstrzygnij problemy lub uzupełnij REGON, a potem przygotuj nową rewizję.</p>}
      </div>}
      {wholeExecution && <div className="prepared-set-progress" aria-live="polite">
        <div className="prepared-set-progress-head"><h4>Cały import · {wholeExecution.status === "queued" ? "w kolejce" : wholeExecution.status === "running" ? "w toku" : wholeExecution.status === "waiting_attention" ? "wymaga uwagi" : wholeExecution.status === "pause_requested" ? "wstrzymywanie" : wholeExecution.status === "paused" ? "wstrzymany" : wholeExecution.status === "completed" ? "zakończony" : wholeExecution.status === "cancelled" ? "anulowany" : "błąd"}</h4>
          {wholeExecution.status !== "paused" && wholeExecution.status !== "pause_requested" && wholeExecution.status !== "completed" && wholeExecution.status !== "cancelled" && wholeExecution.status !== "failed" && <button type="button" onClick={() => void setWholeImportControl("pause")} disabled={wholeBusy || !csrfToken}>Wstrzymaj po bieżącej porcji</button>}
          {wholeExecution.status === "paused" && <button type="button" onClick={() => void setWholeImportControl("resume")} disabled={wholeBusy || !csrfToken}>Wznów import</button>}
          {!(["completed", "cancelled", "failed"].includes(wholeExecution.status)) && <button type="button" onClick={() => void cancelWholeImport()} disabled={wholeBusy || !csrfToken}>Anuluj cały zestaw</button>}
        </div>
        <p>{wholeExecution.progress.completedChunks} z {wholeExecution.chunkCount || "…"} porcji zakończonych; {wholeExecution.progress.generatedChunks} utworzonych, {wholeExecution.totalRows} wierszy w zestawie.</p>
        {wholeExecution.status === "pause_requested" && <p className="submission-notice">Nowe porcje nie będą uruchamiane. Bieżąca porcja dojdzie do bezpiecznego punktu; zewnętrznych działań już wysłanych nie można cofnąć.</p>}
        {wholeExecution.status === "paused" && <p className="submission-notice">Wykonanie jest wstrzymane. Wznowienie kontynuuje od zapisanej porcji i nie tworzy drugiego zestawu.</p>}
        {wholeExecution.status === "waiting_attention" && <p className="submission-notice">System wstrzymał kolejne porcje do czasu rozwiązania problemu: {wholeExecution.errorCode ?? "wymagana kontrola"}.</p>}
        {!!wholeExecution.chunks?.length && <div className="prepared-set-chunks" aria-label="Porcje wykonania">
          <ul>{wholeExecution.chunks.map((chunk) => <li key={chunk.ordinal}><strong>Porcja {chunk.ordinal}</strong>
            <span>wiersze {chunk.firstRowNumber}–{chunk.lastRowNumber} · {chunk.rowCount} rekordów</span>
            <small>{chunkStatusLabels[chunk.status] ?? "stan nieznany"}</small></li>)}</ul>
          <div>
            {chunkAfterOrdinal > 0 && <button type="button" onClick={() => setChunkAfterOrdinal(0)}>Pokaż pierwsze porcje</button>}
            {wholeExecution.chunkPage?.nextAfterOrdinal !== null && wholeExecution.chunkPage?.nextAfterOrdinal !== undefined
              && <button type="button" onClick={() => setChunkAfterOrdinal(wholeExecution.chunkPage!.nextAfterOrdinal!)}>Pokaż kolejne porcje</button>}
          </div>
        </div>}
        {wholeExecution.errorCode === "PREPARATION_CHANGED" && <p className="error" role="alert">Dane zmieniły się po przygotowaniu. Utwórz nową rewizję i uruchom ją ponownie.</p>}
      </div>}
    </div>
    <div className="submission-mode company-selection-mode" role="group" aria-label="Tryb wyboru firm">
      <button type="button" aria-pressed={selectionMode === "companies"} onClick={() => { markDraftEdited(); setSelectionMode("companies"); invalidatePreviews(); }}>Wybierz firmy</button>
      <button type="button" aria-pressed={selectionMode === "advanced"} onClick={() => { markDraftEdited(); setSelectionMode("advanced"); invalidatePreviews(); }}>Zakres lub numery wierszy</button>
    </div>
    {selectionMode === "companies" && <CompanySelection batchId={batchId} preparationId={preparationId}
      selectedRows={selectedCompanyRows} onUnauthorized={() => onUnauthorized?.()}
      onChange={(rows) => { markDraftEdited(); setSelectedCompanyRows(rows); invalidatePreviews(); }} />}
    {selectionMode === "companies" && <form className="submission-selection" onSubmit={requestPreview}>
      <p>Podgląd obejmie wyłącznie zaznaczone firmy; zaznaczanie dotyczy tylko bieżącej strony, a wybór zachowuje się między stronami.</p>
      <button type="submit" disabled={busy || !csrfToken || selectedCompanyRows.length === 0}>{busy ? "Przygotowuję podgląd…" : `Przejdź do podsumowania (${selectedCompanyRows.length})`}</button>
    </form>}
    {selectionMode === "advanced" && <form className="submission-selection" onSubmit={requestPreview}>
      <div className="submission-mode" role="group" aria-label="Sposób wyboru wierszy">
        <button type="button" aria-pressed={mode === "range"} onClick={() => { markDraftEdited(); setMode("range"); invalidatePreviews(); }}>Zakres</button>
        <button type="button" aria-pressed={mode === "list"} onClick={() => { markDraftEdited(); setMode("list"); invalidatePreviews(); }}>Lista numerów</button>
      </div>
      {mode === "range" ? <div className="submission-fields">
        <label>Od wiersza (zakres partii)<input name="from-row" autoComplete="off" type="number" min="2" max="100000000" step="1" value={fromRow} onChange={(event) => { markDraftEdited(); setFromRow(event.target.value); invalidatePreviews(); }} required /></label>
        <label>Do wiersza (zakres partii)<input name="to-row" autoComplete="off" type="number" min="2" max="100000000" step="1" value={toRow} onChange={(event) => { markDraftEdited(); setToRow(event.target.value); invalidatePreviews(); }} required /></label>
      </div> : <label className="submission-row-list">Numery wierszy z Excela<textarea name="row-list" autoComplete="off" rows={3} value={rowList} onChange={(event) => { markDraftEdited(); setRowList(event.target.value); invalidatePreviews(); }} placeholder="np. 2, 4, 8, 9, 10…" aria-describedby="submission-list-help" required /></label>}
      {mode === "list" && <small id="submission-list-help">Oddziel numery przecinkiem, średnikiem lub spacją; maksymalnie 500 wierszy.</small>}
      <button type="submit" disabled={busy || !csrfToken}>{busy ? "Przygotowuję podgląd…" : "Przejdź do podsumowania"}</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && !error && <p className="submission-notice" role="status">{notice}</p>}
    {startBlockedReason && <p className="submission-notice" role="status">{startBlockedReason}{onRefreshReadiness && <> <button type="button" onClick={onRefreshReadiness}>Sprawdź gotowość ponownie</button></>}</p>}
    {preview && <div className="submission-preview" aria-labelledby="submission-preview-title">
      <h3 id="submission-preview-title">Podsumowanie · data {preview.referenceDate}</h3>
      <dl className="submission-counts"><div><dt>Wybrane</dt><dd>{preview.counts.selected}</dd></div><div><dt>Gotowe</dt><dd>{preview.counts.ready}</dd></div><div><dt>Do kontroli</dt><dd>{preview.counts.needsReview}</dd></div><div><dt>Pominięte</dt><dd>{preview.counts.excluded}</dd></div><div><dt>Osobne zadania</dt><dd>{preview.counts.uniqueGroups}</dd></div><div><dt>Już aktywne</dt><dd>{preview.counts.alreadyActive}</dd></div></dl>
      <div className="submission-preview-list" role="region" aria-label="Firmy w podsumowaniu" tabIndex={0}><ul>{preview.items.map((item) => <li key={item.sourceRowId}>
        <strong>{item.companyName || "Firma bez nazwy"}</strong><span className={`submission-state submission-state--${item.state}`}>{item.state === "ready" ? "Zostanie sprawdzona" : item.state === "review" ? "Wymaga kontroli" : "Zostanie pominięta"}</span>
        <small>NIP: {item.nip || "—"} · REGON: {item.effectiveRegon || "—"} · wiersz {item.rowNumber}{item.reasonCode ? ` · ${reasons[item.reasonCode] ?? "wymaga dodatkowej kontroli"}` : item.alreadyActive ? " · zadanie dla tej firmy już działa" : ""}</small>
      </li>)}</ul></div>
      {preview.counts.ready > 0 && <label className="submission-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Rozumiem podsumowanie i potwierdzam utworzenie maksymalnie {preview.counts.uniqueGroups} zadań.</label>}
      {preview.counts.ready === 0 && <p className="submission-notice">Brak gotowych wierszy. Rozstrzygnij wskazane problemy i przygotuj nowy podgląd.</p>}
      <button className="submission-primary" type="button" onClick={() => void submit()} disabled={busy || !confirmed || preview.counts.ready === 0 || Boolean(startBlockedReason)}>{busy ? "Zapisuję zgłoszenie…" : "Potwierdź i uruchom gotowe wiersze"}</button>
    </div>}
  </section>;
}
