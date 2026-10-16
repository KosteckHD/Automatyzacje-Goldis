"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

export type LeadRecipient = { userId: string; name: string; role: string };
type AllocationSummary = { availableCount: number; resultSetId: string | null; checkedAt: string };
type PendingAllocation = {
  version: 1; actorKey: string; recipientUserId: string; count: number; resultSetId: string | null; idempotencyKey: string;
};
type Props = {
  recipients: LeadRecipient[];
  csrfToken: string;
  actorKey: string;
  resultSetId: string | null;
  onUnauthorized: () => void;
  onAllocated: () => Promise<void> | void;
};

function messageOf(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.filter((item): item is string => typeof item === "string").join(" · ");
  }
  return fallback;
}

function pendingFrom(value: string | null, actorKey: string): PendingAllocation | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Partial<PendingAllocation>;
    if (record.version !== 1 || record.actorKey !== actorKey || record.resultSetId !== null && typeof record.resultSetId !== "string"
      || typeof record.recipientUserId !== "string" || !Number.isSafeInteger(record.count)
      || typeof record.idempotencyKey !== "string") return null;
    return record as PendingAllocation;
  } catch { return null; }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "chwilę temu" : new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function leadCountLabel(count: number) {
  const lastTwo = count % 100;
  const lastOne = count % 10;
  return count === 1 ? "lead" : lastOne >= 2 && lastOne <= 4 && (lastTwo < 12 || lastTwo > 14) ? "leady" : "leadów";
}

export default function LeadAllocationPanel({ recipients, csrfToken, actorKey, resultSetId, onUnauthorized, onAllocated }: Props) {
  const storageKey = useMemo(() => `goldis:pending-lead-allocation:${actorKey}`, [actorKey]);
  const [recipientUserId, setRecipientUserId] = useState("");
  const [allocationCount, setAllocationCount] = useState("10");
  const [availability, setAvailability] = useState<AllocationSummary | null>(null);
  const [availabilityError, setAvailabilityError] = useState("");
  const [loadingAvailability, setLoadingAvailability] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [pendingAllocation, setPendingAllocation] = useState<PendingAllocation | null>(null);
  const pendingKey = pendingAllocation?.idempotencyKey ?? null;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadAvailability = useCallback(async (signal?: AbortSignal): Promise<AllocationSummary | null> => {
    setLoadingAvailability(true);
    setAvailabilityError("");
    const params = new URLSearchParams();
    if (resultSetId) params.set("resultSetId", resultSetId);
    try {
      const suffix = params.size ? `?${params.toString()}` : "";
      const response = await fetch(`/api/leads/allocation-summary${suffix}`, {
        credentials: "same-origin", cache: "no-store", signal,
      });
      const payload = await response.json().catch(() => ({})) as AllocationSummary & { message?: string };
      if (response.status === 401) { onUnauthorized(); return null; }
      if (!response.ok) throw new Error(messageOf(payload, "Nie udało się sprawdzić dostępnej puli."));
      if (!Number.isSafeInteger(payload.availableCount) || payload.availableCount < 0) throw new Error("API zwróciło nieprawidłową dostępność puli.");
      setAvailability(payload);
      if (payload.availableCount > 0) setAllocationCount((current) => Number(current) > payload.availableCount ? String(payload.availableCount) : current);
      return payload;
    } catch (cause) {
      if (!signal?.aborted) setAvailabilityError(cause instanceof Error ? cause.message : "Nie udało się sprawdzić dostępnej puli.");
      return null;
    } finally { if (!signal?.aborted) setLoadingAvailability(false); }
  }, [onUnauthorized, resultSetId]);

  useEffect(() => {
    if (!recipients.length) { setRecipientUserId(""); return; }
    setRecipientUserId((current) => recipients.some((recipient) => recipient.userId === current) ? current : recipients[0].userId);
  }, [recipients]);

  useEffect(() => {
    const controller = new AbortController();
    if (!actorKey) { setLoadingAvailability(false); return () => controller.abort(); }
    try {
      const pending = pendingFrom(sessionStorage.getItem(storageKey), actorKey);
      if (!pending) {
        setPendingAllocation(null);
        void loadAvailability(controller.signal);
        return () => controller.abort();
      }
      setAvailability(null);
      setLoadingAvailability(false);
      setPendingAllocation(pending);
      setRecipientUserId(pending.recipientUserId);
      setAllocationCount(String(pending.count));
      setReviewing(true);
      setError("Wynik poprzedniego przydziału jest niepewny. Sprawdź ponownie tę samą operację, aby bezpiecznie ustalić jej wynik.");
    } catch {
      setLoadingAvailability(false);
      setAvailabilityError("Nie można odczytać oczekującego przydziału z pamięci sesji. Odśwież dostępność puli i skontaktuj się z administratorem przed nowym przydziałem.");
    }
    return () => controller.abort();
  }, [actorKey, loadAvailability, storageKey]);

  const count = Number(allocationCount);
  const validCount = Number.isSafeInteger(count) && count > 0 && count <= 5000
    && availability !== null && count <= availability.availableCount;

  async function previewAllocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recipientUserId || submitting) return;
    setError(""); setNotice("");
    const latest = await loadAvailability();
    if (!latest) return;
    const requested = Number(allocationCount);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 5000) {
      setError("Wybierz całkowitą liczbę od 1 do 5000."); return;
    }
    if (requested > latest.availableCount) {
      setError(`Dostępnych jest teraz ${latest.availableCount} leadów. Zmień liczbę przed podsumowaniem.`); return;
    }
    setReviewing(true);
  }

  async function confirmAllocation() {
    if (!csrfToken || submitting) return;
    let pending = pendingAllocation;
    if (!pending) {
      if (!recipientUserId || !availability) return;
      const requestCount = Number(allocationCount);
      if (!Number.isSafeInteger(requestCount) || requestCount < 1 || requestCount > Math.min(5000, availability.availableCount)) {
        setReviewing(false); setError("Dostępna pula się zmieniła. Sprawdź aktualną liczbę i przygotuj podsumowanie ponownie.");
        await loadAvailability();
        return;
      }
      pending = { version: 1, actorKey, recipientUserId, count: requestCount, resultSetId, idempotencyKey: crypto.randomUUID() };
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
    } catch {
      setError("Przeglądarka nie pozwoliła zapisać bezpiecznego ponowienia. Włącz pamięć sesji i spróbuj ponownie.");
      return;
    }
    setPendingAllocation(pending);
    setSubmitting(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/leads/allocations", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ recipientUserId: pending.recipientUserId, count: pending.count,
          ...(pending.resultSetId ? { resultSetId: pending.resultSetId } : {}), idempotencyKey: pending.idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({})) as {
        allocationId?: string; count?: number; replayed?: boolean; code?: string; availableCount?: number; message?: string;
      };
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) {
        const reason = messageOf(payload, "Nie udało się potwierdzić przydziału.");
        if (response.status === 409 && payload.code === "LEAD_POOL_CHANGED") {
          sessionStorage.removeItem(storageKey); setPendingAllocation(null); setReviewing(false);
          if (pending.resultSetId === resultSetId && Number.isSafeInteger(payload.availableCount) && Number(payload.availableCount) >= 0) {
            setAvailability({ availableCount: Number(payload.availableCount), resultSetId, checkedAt: new Date().toISOString() });
          } else await loadAvailability();
          setError(`${reason} Pula została odświeżona; sprawdź podsumowanie ponownie.`);
          return;
        }
        if ([400, 403, 404, 409].includes(response.status)) {
          sessionStorage.removeItem(storageKey); setPendingAllocation(null); setReviewing(false);
          setError(reason);
          await loadAvailability();
          return;
        }
        setError(`${reason} Ponowienie użyje tego samego klucza, aby nie utworzyć drugiego przydziału.`);
        return;
      }
      sessionStorage.removeItem(storageKey);
      setPendingAllocation(null); setReviewing(false);
      const assignedCount = Number.isSafeInteger(payload.count) ? Number(payload.count) : pending.count;
      const assignedRecipient = recipients.find((item) => item.userId === pending?.recipientUserId);
      setNotice(`Przydzielono ${assignedCount} ${leadCountLabel(assignedCount)} odbiorcy ${assignedRecipient?.name ?? "z zespołu"}${payload.allocationId ? `. Numer przydziału: ${payload.allocationId}` : ""}${payload.replayed ? " (potwierdzono wcześniejszą operację)" : ""}.`);
      const latest = await loadAvailability();
      if (!latest || latest.availableCount === 0) setAllocationCount("1");
      else if (Number(allocationCount) > latest.availableCount) setAllocationCount(String(latest.availableCount));
      await onAllocated();
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Nie otrzymaliśmy odpowiedzi serwera."} Ponów tę samą operację, aby sprawdzić jej wynik.`);
    } finally { setSubmitting(false); }
  }

  function returnToEdit() {
    if (pendingAllocation) return;
    setReviewing(false); setError("");
  }

  const recipient = recipients.find((item) => item.userId === recipientUserId);
  const displayScopeId = pendingAllocation ? pendingAllocation.resultSetId : resultSetId;
  const scopeLabel = displayScopeId ? `Zestaw wyników ${displayScopeId.slice(0, 8).toUpperCase()}` : "Cała dostępna pula OC";
  const pendingRecipient = pendingAllocation && recipients.find((item) => item.userId === pendingAllocation.recipientUserId);

  return <section className="lead-panel lead-allocation" aria-labelledby="lead-allocation-title">
    <div><p className="lead-overline">DYSTRYBUCJA PULI</p><h2 id="lead-allocation-title">Przydziel leady osobie z zespołu</h2><p>Wybierz odbiorcę i liczbę firm. Dostępność obejmuje całą pulę w wybranym zakresie, nie tylko firmy widoczne na bieżącej stronie.</p>
      <p className="lead-allocation-availability" role="status" aria-live="polite">{pendingAllocation
        ? `Do rozstrzygnięcia pozostaje operacja w zakresie ${scopeLabel}.`
        : loadingAvailability ? "Sprawdzam dostępną pulę…" : availability ? `Dostępne do przydziału: ${availability.availableCount} · sprawdzono ${formatDate(availability.checkedAt)}` : "Dostępność puli jest nieznana."}</p>
      {availabilityError && <p className="lead-feedback" role="alert">{availabilityError}</p>}
      <button className="lead-allocation-refresh" type="button" onClick={() => void loadAvailability()} disabled={loadingAvailability || submitting || Boolean(pendingAllocation)}>Odśwież dostępność puli</button>
    </div>
    {reviewing ? <div className="lead-allocation-review" role="group" aria-label="Podsumowanie przydziału" aria-live="polite">
      <p className="lead-overline">{pendingKey ? "OCZEKUJĄCA OPERACJA" : "SPRAWDŹ PRZYDZIAŁ"}</p>
      <dl><div><dt>Odbiorca</dt><dd>{pendingAllocation ? pendingRecipient?.name ?? "Odbiorca z poprzedniej próby" : recipient?.name ?? "Odbiorca z poprzedniej próby"}</dd></div>
        <div><dt>Liczba firm</dt><dd>{allocationCount}</dd></div><div><dt>Zakres</dt><dd>{scopeLabel}</dd></div>
        <div><dt>Kolejność wyboru</dt><dd>Najstarsze wolne leady</dd></div></dl>
      <p className="lead-allocation-warning">Przydział jest stały w obecnym procesie i nie można go przenieść.</p>
      {!pendingKey && <button className="lead-secondary" type="button" disabled={submitting} onClick={returnToEdit}>Wróć do edycji</button>}
      <button className="lead-primary" type="button" disabled={submitting || !csrfToken || !pendingKey && !validCount}
        onClick={() => void confirmAllocation()}>{submitting ? "Zapisuję przydział…" : pendingKey ? "Sprawdź ponownie tę samą operację" : "Potwierdź przydział"}</button>
    </div> : <form onSubmit={(event) => void previewAllocation(event)}>
      <label>Odbiorca<select required value={recipientUserId} onChange={(event) => { setRecipientUserId(event.target.value); setError(""); }} disabled={!recipients.length || Boolean(pendingKey)}>
        <option value="" disabled>Wybierz odbiorcę</option>{recipients.map((item) => <option key={item.userId} value={item.userId}>{item.name}{item.role === "manager" ? " · menedżer" : ""}</option>)}
      </select></label>
      <label>Liczba leadów<input type="number" min="1" max={Math.min(5000, availability?.availableCount ?? 5000)} step="1" required value={allocationCount}
        onChange={(event) => { setAllocationCount(event.target.value); setError(""); }} disabled={Boolean(pendingKey)} /></label>
        <button className="lead-primary" type="submit" disabled={loadingAvailability || !availability || availability.availableCount < 1 || !validCount || !recipientUserId || !csrfToken}>
        {loadingAvailability ? "Sprawdzam pulę…" : "Sprawdź przydział"}
      </button>
      {availability?.availableCount === 0 && <small className="lead-allocation-hint" role="status">W tym zakresie nie ma teraz wolnych leadów.</small>}
      {availability && availability.availableCount > 0 && Number(allocationCount) > availability.availableCount && <small className="lead-allocation-hint" role="status">Dostępnych jest {availability.availableCount}. Zmniejsz liczbę, aby przygotować podsumowanie.</small>}
      {!recipients.length && !loadingAvailability && <small className="lead-allocation-hint" role="status">Brak aktywnych pracowników lub menedżerów do przydziału.</small>}
    </form>}
    {error && <p className="lead-feedback" role="alert">{error}</p>}
    {notice && <p className="lead-notice" role="status">{notice}</p>}
  </section>;
}
