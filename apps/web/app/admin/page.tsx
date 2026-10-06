"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { GoldisLogo } from "../../components/brand/GoldisLogo";
import { StatValue } from "../../components/ui/StatValue";
import { AdminConfirmDialog, type AdminConfirmation } from "./AdminConfirmDialog";
import { formatWarsawDateTimeLocal, warsawDateTimeCandidates, warsawUtcOffsetLabel } from "../../lib/warsaw-date-time";

type Role = "admin" | "operator" | "reviewer" | "auditor";
type Me = { role: Role; username: string; csrfToken: string; mustChangePassword: boolean };
type UserRow = { userId: string; username: string; role: Role; status: string; lastLoginAt: string | null; createdAt: string; activeSessionCount: number };
type ToolRow = { toolId: string; displayName: string; description?: string; status: string };
type GrantRow = ToolRow & { canDiscover: boolean; canExecute: boolean; canViewResults: boolean; canDownloadResults: boolean; version: number };
type SessionRow = { sessionId: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null; browserLabel: string; isCurrent?: boolean };
type InterventionRow = { interventionId: string; runId: string; toolId: string; kind: string; portal: string | null; reasonCode: string | null; status: string; priority: "normal" | "high"; dueAt: string | null; assigneeUserId: string | null; assigneeUsername: string | null; revision: number; createdAt: string; rowNumber: number; currentStep: string; runErrorCode: string | null };
type AssignmentDraft = { assigneeUserId: string; dueAt: string; originalDueAt: string | null; dueAtEdited: boolean; ambiguousChoice: string };
type ToolSettings = { enabledForNewRuns: boolean; maxNewRunsPerHour: number | null; allowedLocalStart: string | null; allowedLocalEnd: string | null; timezone: string; version: number; updatedAt: string };
type Overview = { userCount: number; toolCount: number; openInterventionCount: number; activeRunCount: number };
type Ops = { api: string; database: string; redis: string; worker: string; portalMode: string; portalConfig: string; automationReady: boolean; runCounts: Record<string, number>; openInterventionCount: number; dispatch: { pendingCount: number; oldestCreatedAt: string | null } };
type AuditEvent = { eventId: string; actorUserId: string | null; actorUsername: string | null; action: string; resourceType: string; resourceId: string | null; outcome: string; createdAt: string };
type Report = { counts: { created: number; completed: number; noPolicies: number; failed: number; inProgress: number; downloads: number; generated: number; openInterventions: number }; completionRate: number | null; durationSeconds: { median: number | null; p90: number | null }; medianResolvedInterventionSeconds: number | null; daily: { day: string; created: number; completed: number; noPolicies: number; failed: number }[]; definitions: Record<string, string> };
const adminSectionIds = ["resources", "accounts", "operations", "interventions", "automation", "audit", "reports"] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Żądanie nie powiodło się (${response.status})`);
  return payload as T;
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function warsawMidnightIso(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const targetLocal = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let utcGuess = targetLocal;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(utcGuess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    const correction = targetLocal - represented;
    utcGuess += correction;
    if (correction === 0) break;
  }
  return new Date(utcGuess).toISOString();
}

function localTime(value: string | null | undefined): string {
  return value ? value.slice(0, 5) : "";
}

function assignmentDraftFor(intervention: InterventionRow): AssignmentDraft {
  return {
    assigneeUserId: intervention.assigneeUserId ?? "",
    dueAt: formatWarsawDateTimeLocal(intervention.dueAt),
    originalDueAt: intervention.dueAt,
    dueAtEdited: false,
    ambiguousChoice: "",
  };
}

function dateLabel(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—";
}

function readableStatus(value: string): string {
  const labels: Record<string, string> = {
    available: "Dostępne", maintenance: "Przerwa techniczna", disabled: "Wyłączone",
    queued: "W kolejce", running: "W toku", online: "Online", offline: "Offline", off: "Wyłączona",
    live: "Live", succeeded: "Powodzenie", failed: "Błąd", denied: "Odmowa",
    normal: "Normalny", high: "Pilny", open: "Otwarte", resolved: "Rozwiązane",
  };
  return labels[value] ?? value.replaceAll("_", " ");
}

export default function AdminPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [activeAdminSection, setActiveAdminSection] = useState("resources");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [operations, setOperations] = useState<Ops | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedToolId, setSelectedToolId] = useState("");
  const [selectedOperationToolId, setSelectedOperationToolId] = useState("");
  const [selectedInterventionToolId, setSelectedInterventionToolId] = useState("");
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [interventions, setInterventions] = useState<InterventionRow[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [failures, setFailures] = useState<Record<string, unknown>[]>([]);
  const [interventionReport, setInterventionReport] = useState<Record<string, unknown>[]>([]);
  const [throughput, setThroughput] = useState<Record<string, unknown>[]>([]);
  const [runRows, setRunRows] = useState<Record<string, unknown>[]>([]);
  const [activity, setActivity] = useState<Record<string, unknown>[]>([]);
  const [activityFor, setActivityFor] = useState("");
  const [from, setFrom] = useState(() => localDateValue(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => localDateValue(new Date(Date.now() + 86_400_000)));
  const [auditFrom, setAuditFrom] = useState(() => localDateValue(new Date(Date.now() - 6 * 86_400_000)));
  const [auditTo, setAuditTo] = useState(() => localDateValue(new Date(Date.now() + 86_400_000)));
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailsRevision, setDetailsRevision] = useState(0);
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "operator" as Role });
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Role>>({});
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("open");
  const [selectedAssigneeId, setSelectedAssigneeId] = useState("");
  const [selectedPriority, setSelectedPriority] = useState("");
  const [selectedRunStatus, setSelectedRunStatus] = useState("");
  const [operationPage, setOperationPage] = useState(1);
  const [operationHasMore, setOperationHasMore] = useState(false);
  const [loadingOperations, setLoadingOperations] = useState(false);
  const [interventionPage, setInterventionPage] = useState(1);
  const [interventionHasMore, setInterventionHasMore] = useState(false);
  const [loadingInterventions, setLoadingInterventions] = useState(false);
  const [userCursor, setUserCursor] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [assigneeUsers, setAssigneeUsers] = useState<UserRow[]>([]);
  const [assigneeCursor, setAssigneeCursor] = useState<string | null>(null);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const [newRunLimit, setNewRunLimit] = useState("");
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [auditFilters, setAuditFilters] = useState({ actorId: "", action: "", resourceType: "", resourceId: "", outcome: "", toolId: "" });
  const operationRequest = useRef(0);
  const interventionRequest = useRef(0);
  const operationsInFlight = useRef(false);
  const interventionsInFlight = useRef(false);

  async function loadAdminData() {
    setError("");
    try {
      const current = await api<Me>("/auth/me");
      setMe(current);
      if (current.role !== "admin") { setError("Ta strona jest dostępna wyłącznie dla administratora."); return; }
      const [summary, userPage, catalog, ops, interventionResult] = await Promise.all([
        api<Overview>("/admin/overview"),
        api<{ items: UserRow[]; nextCursor: string | null }>("/admin/users?limit=100"),
        api<{ items: ToolRow[] }>("/admin/tools"),
        api<Ops>("/admin/operations/summary"),
        api<{ items: InterventionRow[]; page: number; hasMore: boolean }>("/admin/interventions?status=open&page=1"),
      ]);
      setOverview(summary); setUsers((current) => {
        const firstPageIds = new Set(userPage.items.map((user) => user.userId));
        const selectedOutsidePage = current.find((user) => user.userId === selectedUserId && !firstPageIds.has(user.userId));
        return selectedOutsidePage ? [...userPage.items, selectedOutsidePage] : userPage.items;
      });
      setUserCursor(userPage.nextCursor); setTools(catalog.items); setOperations(ops); setInterventions(interventionResult.items);
      setInterventionPage(interventionResult.page); setInterventionHasMore(interventionResult.hasMore);
      if (!selectedUserId && userPage.items[0]) setSelectedUserId(userPage.items[0].userId);
      if (!selectedToolId && catalog.items[0]) setSelectedToolId(catalog.items[0].toolId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się pobrać danych panelu."); }
  }

  useEffect(() => { void loadAdminData(); }, []);

  useEffect(() => {
    let frame = 0;
    const updateActiveSection = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        let active: (typeof adminSectionIds)[number] = adminSectionIds[0];
        for (const id of adminSectionIds) {
          const section = document.getElementById(id);
          if (section && section.getBoundingClientRect().top <= window.innerHeight * 0.8) active = id;
        }
        setActiveAdminSection(active);
      });
    };
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    window.addEventListener("hashchange", updateActiveSection);
    updateActiveSection();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
      window.removeEventListener("hashchange", updateActiveSection);
    };
  }, []);

  useEffect(() => {
    if (!me || me.role !== "admin" || !selectedUserId) return;
    let active = true;
    Promise.all([
      api<{ items: GrantRow[] }>(`/admin/users/${selectedUserId}/grants`),
      api<{ items: SessionRow[] }>(`/admin/users/${selectedUserId}/sessions`),
    ]).then(([grantPage, sessionPage]) => {
      if (active) { setGrants(grantPage.items); setSessions(sessionPage.items); }
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać dostępów użytkownika."); });
    return () => { active = false; };
  }, [me?.role, selectedUserId, detailsRevision]);

  useEffect(() => {
    if (!me || me.role !== "admin" || !selectedToolId) return;
    let active = true;
    api<ToolSettings>(`/admin/tools/${selectedToolId}/settings`).then((value) => { if (active) { setSettings(value); setNewRunLimit(value.maxNewRunsPerHour === null ? "" : String(value.maxNewRunsPerHour)); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać ustawień narzędzia."); });
    return () => { active = false; };
  }, [me?.role, selectedToolId]);

  async function mutate(path: string, method: string, body?: unknown) {
    if (!me?.csrfToken) throw new Error("Brak tokenu CSRF. Odśwież stronę i zaloguj się ponownie.");
    return api<unknown>(path, {
      method, headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function requestConfirmation(value: AdminConfirmation) {
    setConfirmation(value);
  }

  async function confirmPendingAction() {
    const action = confirmation?.action;
    setConfirmation(null);
    if (action) await action();
  }

  async function perform(label: string | ((result: unknown) => string), action: () => Promise<unknown>, reload = true) {
    setBusy(true); setNotice(""); setError("");
    try { const result = await action(); setNotice(typeof label === "function" ? label(result) : label); if (reload) { await loadAdminData(); setDetailsRevision((value) => value + 1); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Operacja nie powiodła się."); }
    finally { setBusy(false); }
  }

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let createdId: string | undefined;
    await perform("Konto utworzone. Użytkownik zmieni hasło przy pierwszym logowaniu.", async () => {
      const created = await mutate("/admin/users", "POST", newUser) as { userId?: string };
      setNewUser({ username: "", password: "", role: "operator" });
      createdId = created.userId;
    });
    if (createdId) { setSelectedUserId(createdId); setDetailsRevision((value) => value + 1); }
  }

  async function saveGrant(grant: GrantRow) {
    await perform((result) => {
      const count = (result as { unassignedInterventions?: number } | null)?.unassignedInterventions ?? 0;
      return count ? `Uprawnienia zapisane. Zdjęto ${count} przydziałów wymagających odebranego dostępu.` : "Uprawnienia zapisane.";
    }, () => mutate(`/admin/users/${selectedUserId}/grants/${grant.toolId}`, "PUT", {
      canDiscover: grant.canDiscover, canExecute: grant.canExecute, canViewResults: grant.canViewResults,
      canDownloadResults: grant.canDownloadResults, expectedVersion: grant.version,
    }));
  }

  async function loadMoreUsers() {
    if (!userCursor) return;
    setLoadingUsers(true); setError("");
    try {
      const query = new URLSearchParams({ limit: "100", cursor: userCursor });
      const page = await api<{ items: UserRow[]; nextCursor: string | null }>(`/admin/users?${query}`);
      setUsers((current) => [...current, ...page.items.filter((next) => !current.some((user) => user.userId === next.userId))]);
      setUserCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się wczytać kolejnych użytkowników."); }
    finally { setLoadingUsers(false); }
  }

  function interventionQuery(page = 1) {
    const query = new URLSearchParams({ status: selectedStatus, page: String(page) });
    if (selectedInterventionToolId) query.set("toolId", selectedInterventionToolId);
    if (selectedAssigneeId) query.set("assigneeUserId", selectedAssigneeId);
    if (selectedPriority) query.set("priority", selectedPriority);
    return query;
  }

  async function loadMoreAssignees() {
    if (!assigneeCursor) return;
    setLoadingAssignees(true); setError("");
    try {
      const query = new URLSearchParams({ limit: "100", cursor: assigneeCursor });
      if (assigneeSearch.trim()) query.set("q", assigneeSearch.trim());
      const page = await api<{ items: UserRow[]; nextCursor: string | null }>(`/admin/users?${query}`);
      setAssigneeUsers((current) => [...current, ...page.items.filter((user) => user.status === "active" && !current.some((item) => item.userId === user.userId))]);
      setAssigneeCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się wczytać kolejnych odbiorców."); }
    finally { setLoadingAssignees(false); }
  }

  useEffect(() => {
    if (!me || me.role !== "admin") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoadingAssignees(true);
      const query = new URLSearchParams({ limit: "100" });
      if (assigneeSearch.trim()) query.set("q", assigneeSearch.trim());
      api<{ items: UserRow[]; nextCursor: string | null }>(`/admin/users?${query}`, { signal: controller.signal })
        .then((page) => { setAssigneeUsers(page.items.filter((user) => user.status === "active")); setAssigneeCursor(page.nextCursor); })
        .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Nie udało się znaleźć odbiorców."); })
        .finally(() => { if (!controller.signal.aborted) setLoadingAssignees(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [me?.role, assigneeSearch]);

  async function loadInterventions(pageNumber = 1) {
    if (interventionsInFlight.current) return;
    interventionsInFlight.current = true;
    const requestNumber = ++interventionRequest.current;
    setLoadingInterventions(true); setError("");
    try {
      const result = await api<{ items: InterventionRow[]; page: number; hasMore: boolean }>(`/admin/interventions?${interventionQuery(pageNumber)}`);
      if (requestNumber !== interventionRequest.current) return;
      setInterventions(result.items); setInterventionPage(result.page); setInterventionHasMore(result.hasMore); setAssignmentDrafts({});
    } catch (cause) {
      if (requestNumber === interventionRequest.current) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać interwencji.");
    } finally {
      interventionsInFlight.current = false;
      if (requestNumber === interventionRequest.current) setLoadingInterventions(false);
    }
  }

  async function loadOperations(pageNumber = 1) {
    if (operationsInFlight.current) return;
    operationsInFlight.current = true;
    const requestNumber = ++operationRequest.current;
    setLoadingOperations(true); setError("");
    const query = new URLSearchParams({ page: String(pageNumber) });
    if (selectedOperationToolId) query.set("toolId", selectedOperationToolId);
    if (selectedRunStatus) query.set("status", selectedRunStatus);
    try {
      const [ops, result] = await Promise.all([
        api<Ops>("/admin/operations/summary"),
        api<{ items: Record<string, unknown>[]; page: number; hasMore: boolean }>(`/admin/operations/runs?${query}`),
      ]);
      if (requestNumber !== operationRequest.current) return;
      setOperations(ops); setRunRows(result.items); setOperationPage(result.page); setOperationHasMore(result.hasMore);
      setNotice(`Centrum operacyjne odświeżone · strona ${result.page}, ${result.items.length} zadań.`);
    } catch (cause) {
      if (requestNumber === operationRequest.current) setError(cause instanceof Error ? cause.message : "Nie udało się pobrać zadań operacyjnych.");
    } finally {
      operationsInFlight.current = false;
      if (requestNumber === operationRequest.current) setLoadingOperations(false);
    }
  }

  useEffect(() => {
    if (!me || me.role !== "admin") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !operationsInFlight.current) void loadOperations(operationPage);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [me?.role, operationPage, selectedOperationToolId, selectedRunStatus]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || !selectedToolId) return;
    await perform("Ustawienia automatyzacji zapisane.", async () => {
      const updated = await mutate(`/admin/tools/${selectedToolId}/settings`, "PATCH", {
        enabledForNewRuns: settings.enabledForNewRuns,
        maxNewRunsPerHour: newRunLimit.trim() === "" ? null : Number(newRunLimit),
        allowedLocalStart: settings.allowedLocalStart ? localTime(settings.allowedLocalStart) : null,
        allowedLocalEnd: settings.allowedLocalEnd ? localTime(settings.allowedLocalEnd) : null,
        timezone: settings.timezone, expectedVersion: settings.version,
      }) as ToolSettings;
      setSettings(updated);
      setNewRunLimit(updated.maxNewRunsPerHour === null ? "" : String(updated.maxNewRunsPerHour));
    });
  }

  async function searchAudit(event?: FormEvent<HTMLFormElement>, cursor?: string) {
    event?.preventDefault(); setError("");
    try {
      const query = new URLSearchParams({ from: warsawMidnightIso(auditFrom), to: warsawMidnightIso(auditTo), limit: "50" });
      for (const [key, value] of Object.entries(auditFilters)) if (value.trim()) query.set(key, value.trim());
      if (cursor) query.set("cursor", cursor);
      const result = await api<{ items: AuditEvent[]; nextCursor: string | null }>(`/audit/events?${query}`);
      setAudit(cursor ? [...audit, ...result.items] : result.items); setAuditCursor(result.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się wyszukać zdarzeń."); }
  }

  async function loadReports(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); setError("");
    try {
      const query = new URLSearchParams({ from: warsawMidnightIso(from), to: warsawMidnightIso(to) });
      if (selectedToolId) query.set("toolId", selectedToolId);
      const [overviewData, failureData] = await Promise.all([
        api<Report>(`/admin/reports/overview?${query}`),
        api<{ items: Record<string, unknown>[] }>(`/admin/reports/failures?${query}`),
      ]);
      const [interventionData, throughputData] = await Promise.all([
        api<{ items: Record<string, unknown>[] }>(`/admin/reports/interventions?${query}`),
        api<{ items: Record<string, unknown>[] }>(`/admin/reports/throughput?${query}`),
      ]);
      setReport(overviewData); setFailures(failureData.items);
      setInterventionReport(interventionData.items); setThroughput(throughputData.items);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się policzyć raportu."); }
  }

  async function assign(intervention: InterventionRow) {
    const draft = assignmentDrafts[intervention.interventionId] ?? assignmentDraftFor(intervention);
    await perform("Przydział zapisany.", () => {
      let dueAt = draft.originalDueAt;
      if (draft.dueAtEdited) {
        if (!draft.dueAt) dueAt = null;
        else {
          const candidates = warsawDateTimeCandidates(draft.dueAt);
          if (candidates.length === 0) throw new Error("Ta godzina nie istnieje w strefie Europe/Warsaw. Wybierz inną.");
          if (candidates.length > 1 && !candidates.includes(draft.ambiguousChoice)) {
            throw new Error("Ta godzina występuje dwa razy przy zmianie czasu. Wybierz właściwy offset UTC.");
          }
          dueAt = candidates.length > 1 ? draft.ambiguousChoice : candidates[0];
        }
      }
      return mutate(`/admin/interventions/${intervention.interventionId}/assignment`, "PATCH", {
        assigneeUserId: draft.assigneeUserId || null,
        dueAt,
        expectedRevision: intervention.revision,
      });
    });
  }

  async function changePriority(intervention: InterventionRow) {
    const priority = intervention.priority === "high" ? "normal" : "high";
    await perform(`Priorytet zmieniony na: ${readableStatus(priority)}.`, () => mutate(`/admin/interventions/${intervention.interventionId}/priority`, "PATCH", { priority, expectedRevision: intervention.revision }));
  }

  async function showActivity(id: string) {
    setActivityFor(id); setActivity([]);
    try { setActivity((await api<{ items: Record<string, unknown>[] }>(`/admin/interventions/${id}/activity`)).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Nie udało się odczytać historii zgłoszenia."); }
  }

  const chosenUser = useMemo(() => users.find((user) => user.userId === selectedUserId) ?? null, [users, selectedUserId]);
  const chosenRole = chosenUser ? roleDrafts[chosenUser.userId] ?? chosenUser.role : "operator";
  const activeUsers = useMemo(() => users.filter((user) => user.status === "active"), [users]);
  const assigneeOptions = useMemo(() => [...new Map([...activeUsers, ...assigneeUsers].map((user) => [user.userId, user])).values()], [activeUsers, assigneeUsers]);
  const maxDaily = Math.max(1, ...(report?.daily.map((point) => point.created) ?? []));
  return <div className="admin-shell">
    <aside className="admin-rail">
      <a className="admin-brand" href="/"><GoldisLogo variant="sidebar" /><div><strong>GOLDIS</strong><small>panel administracyjny</small></div></a>
      <nav aria-label="Sekcje administracji" aria-describedby="admin-nav-hint">
        <a className={activeAdminSection === "resources" ? "admin-nav-active" : ""} href="#resources" onClick={() => setActiveAdminSection("resources")} aria-current={activeAdminSection === "resources" ? "location" : undefined}>Dostępy do narzędzi</a>
        <a className={activeAdminSection === "accounts" ? "admin-nav-active" : ""} href="#accounts" onClick={() => setActiveAdminSection("accounts")} aria-current={activeAdminSection === "accounts" ? "location" : undefined}>Konta i sesje</a>
        <a className={activeAdminSection === "operations" ? "admin-nav-active" : ""} href="#operations" onClick={() => setActiveAdminSection("operations")} aria-current={activeAdminSection === "operations" ? "location" : undefined}>Centrum operacyjne</a>
        <a className={activeAdminSection === "interventions" ? "admin-nav-active" : ""} href="#interventions" onClick={() => setActiveAdminSection("interventions")} aria-current={activeAdminSection === "interventions" ? "location" : undefined}>Przydział pracy</a>
        <a className={activeAdminSection === "automation" ? "admin-nav-active" : ""} href="#automation" onClick={() => setActiveAdminSection("automation")} aria-current={activeAdminSection === "automation" ? "location" : undefined}>Automatyzacja</a>
        <a className={activeAdminSection === "audit" ? "admin-nav-active" : ""} href="#audit" onClick={() => setActiveAdminSection("audit")} aria-current={activeAdminSection === "audit" ? "location" : undefined}>Audyt</a>
        <a className={activeAdminSection === "reports" ? "admin-nav-active" : ""} href="#reports" onClick={() => setActiveAdminSection("reports")} aria-current={activeAdminSection === "reports" ? "location" : undefined}>Raporty jakości</a>
      </nav>
      <p className="admin-nav-hint" id="admin-nav-hint">Przewiń menu w bok, aby zobaczyć wszystkie sekcje.</p>
      <div className="admin-rail-foot"><span>Organizacja Goldis</span><a href="/account">Moje konto</a><a href="/">Powrót do narzędzi</a></div>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><span>OPERACJE / USTAWIENIA ORGANIZACJI</span><span>{me ? `${me.username} · administrator` : "Ładowanie sesji…"}</span></header>
      <div className="admin-content">
        <section className="admin-hero">
          <div><p className="eyebrow">PANEL KONTROLI PLATFORMY</p><h1>Dostęp i jakość pracy<br /><em>pod kontrolą.</em></h1><p>Przydzielaj narzędzia, pilnuj zgłoszeń i sprawdzaj, co dzieje się z wynikami.</p></div>
          <div className="admin-hero-mark" aria-hidden="true"><GoldisLogo variant="header" /></div>
        </section>
        {error && <p className="admin-alert" role="alert">{error}</p>}{notice && <p className="admin-notice" role="status">{notice}</p>}
        {!me ? <section className="admin-card"><p>Sprawdzam uprawnienia…</p></section> : me.role !== "admin" ? <section className="admin-card"><h2>Brak dostępu</h2><p>{error || "Wymagana jest rola administratora."}</p><a className="admin-button" href="/">Wróć do narzędzi</a></section> : <>
          {me.mustChangePassword && <p className="admin-alert">Hasło tymczasowe wymaga zmiany. <a href="/account?required=1">Przejdź do ustawień bezpieczeństwa</a></p>}
          <section className="admin-kpis" aria-label="Podsumowanie organizacji">
            <article><small>AKTYWNE KONTA</small><strong><StatValue value={overview?.userCount ?? "—"} /></strong><span>członkowie organizacji</span></article>
            <article><small>OTWARTE ZGŁOSZENIA</small><strong><StatValue value={overview?.openInterventionCount ?? "—"} /></strong><span>czekają na obsługę</span></article>
            <article><small>ZADANIA W TOKU</small><strong><StatValue value={overview?.activeRunCount ?? "—"} /></strong><span>przyjęte do realizacji</span></article>
            <article><small>NARZĘDZIA</small><strong><StatValue value={overview?.toolCount ?? "—"} /></strong><span>w katalogu platformy</span></article>
          </section>

          <section id="resources" className="admin-section">
            <div className="admin-section-title"><div><p className="eyebrow">ZAKRES DOSTĘPU</p><h2>Dostęp do narzędzi</h2></div><p>Każdy grant określa, co dana osoba może zrobić. Brak grantu oznacza brak dostępu.</p></div>
            <div className="admin-grid admin-grid-wide">
              <article className="admin-card">
                <div className="admin-card-head"><div><h3>Konta i przypisane uprawnienia</h3><p>Wybierz konto, aby edytować dostęp do poszczególnych narzędzi.</p></div><button className="admin-quiet" disabled={busy} onClick={() => void loadAdminData()}>Odśwież</button></div>
                <label className="admin-field">Użytkownik<select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>{users.map((user) => <option key={user.userId} value={user.userId}>{user.username} · {user.role} · {readableStatus(user.status)}</option>)}</select></label>
                {userCursor && <button type="button" className="admin-quiet admin-load-more" disabled={loadingUsers} onClick={() => void loadMoreUsers()}>{loadingUsers ? "Wczytywanie…" : "Wczytaj kolejnych użytkowników"}</button>}
                {chosenUser && <p className="admin-muted">Ostatnie logowanie: {dateLabel(chosenUser.lastLoginAt)} · aktywne sesje: {chosenUser.activeSessionCount}</p>}
                <div className="admin-grants">
                  {grants.map((grant) => <fieldset key={grant.toolId} className="admin-grant">
                    <legend>{grant.displayName}<small>{grant.toolId} · {readableStatus(grant.status)}</small></legend>
                    <div className="admin-checks">
                      {([ ["canDiscover", "Widoczność"], ["canExecute", "Uruchamianie"], ["canViewResults", "Odczyt wyników"], ["canDownloadResults", "Pobieranie plików"] ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={grant[key]} onChange={(event) => setGrants((current) => current.map((item) => item.toolId === grant.toolId ? { ...item, [key]: event.target.checked } : item))} />{label}</label>)}
                    </div>
      <div className="admin-row-actions"><span>Wersja {grant.version}</span><button className="admin-button small" disabled={busy} onClick={() => void saveGrant(grant)}>Zapisz grant</button><button className="admin-quiet danger" disabled={busy} onClick={() => requestConfirmation({ title: "Cofnąć dostęp do narzędzia?", description: `Użytkownik ${chosenUser?.username ?? ""} utraci dostęp do ${grant.displayName}. Otwarte przydziały wymagające tego grantu mogą zostać zdjęte.`, confirmLabel: "Cofnij dostęp", action: () => perform((result) => { const count = (result as { unassignedInterventions?: number } | null)?.unassignedInterventions ?? 0; return count ? `Grant cofnięty. Zdjęto ${count} przydziałów.` : "Grant cofnięty."; }, () => mutate(`/admin/users/${selectedUserId}/grants/${grant.toolId}/revoke`, "POST", { expectedVersion: grant.version })) })}>Cofnij dostęp</button></div>
                  </fieldset>)}
                </div>
              </article>
              <article className="admin-card admin-tool-list"><h3>Katalog narzędzi</h3><p>Lista zawiera wyłącznie narzędzia zarejestrowane w platformie.</p>{tools.map((tool) => <div key={tool.toolId} className="admin-tool-line"><span className={`status-dot ${tool.status === "available" ? "" : "health-warn"}`} /><div><strong>{tool.displayName}</strong><small>{tool.toolId}</small></div><span className="admin-status">{readableStatus(tool.status)}</span></div>)}</article>
            </div>
          </section>

          <section id="accounts" className="admin-section">
            <div className="admin-section-title"><div><p className="eyebrow">TOŻSAMOŚĆ I SESJE</p><h2>Konta i bezpieczeństwo</h2></div><p>Hasła tymczasowe pokazuj użytkownikowi bezpiecznym kanałem. Aplikacja ich nie wysyła.</p></div>
            <div className="admin-grid">
              <article className="admin-card"><h3>Dodaj konto</h3><form className="admin-form" onSubmit={createUser}>
                <label className="admin-field">Login<input autoComplete="off" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} maxLength={128} required /></label>
                <label className="admin-field">Hasło tymczasowe<input autoComplete="new-password" type="password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} minLength={14} maxLength={1024} required /><small>Minimum 14 znaków. Użytkownik zmieni je przy pierwszym logowaniu.</small></label>
                <label className="admin-field">Rola<select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value as Role })}><option value="operator">Operator</option><option value="reviewer">Recenzent</option><option value="auditor">Audytor</option><option value="admin">Administrator</option></select></label>
                <button className="admin-button" disabled={busy}>Utwórz konto</button>
              </form></article>
              <article className="admin-card"><h3>Zarządzaj kontem</h3>{chosenUser ? <>
                <p className="admin-selected-user"><strong>{chosenUser.username}</strong><span>{chosenUser.userId}</span></p>
                <div className="admin-form-row"><label className="admin-field">Rola<select value={chosenRole} onChange={(event) => setRoleDrafts((current) => ({ ...current, [chosenUser.userId]: event.target.value as Role }))}><option value="operator">Operator</option><option value="reviewer">Recenzent</option><option value="auditor">Audytor</option><option value="admin">Administrator</option></select></label><div className="admin-account-actions">{chosenRole !== chosenUser.role && <button type="button" className="admin-button" disabled={busy} onClick={() => requestConfirmation({ title: "Zapisać nową rolę?", description: `Rola użytkownika ${chosenUser.username} zmieni się z ${chosenUser.role} na ${chosenRole}. Wszystkie jego sesje zostaną cofnięte; zależnie od nowej roli otwarte przydziały mogą zostać zdjęte.`, confirmLabel: "Zapisz rolę", action: () => perform((result) => { const count = (result as { unassignedInterventions?: number } | null)?.unassignedInterventions ?? 0; setRoleDrafts((current) => ({ ...current, [chosenUser.userId]: chosenRole })); setUsers((current) => current.map((user) => user.userId === chosenUser.userId ? { ...user, role: chosenRole } : user)); return count ? `Rola zaktualizowana. Sesje cofnięte; zdjęto ${count} przydziałów.` : "Rola zaktualizowana. Sesje użytkownika zostały cofnięte."; }, () => mutate(`/admin/users/${selectedUserId}/role`, "PATCH", { role: chosenRole })) })}>Zapisz rolę</button>}
                  <button type="button" className={`admin-button ${chosenUser.status === "active" ? "danger-button" : ""}`} disabled={busy} onClick={() => chosenUser.status === "active" ? requestConfirmation({ title: "Wyłączyć konto?", description: `Konto ${chosenUser.username} straci dostęp. Jego sesje zostaną cofnięte, a otwarte przydziały zdjęte.`, confirmLabel: "Wyłącz konto", action: () => perform(() => { setUsers((current) => current.map((user) => user.userId === selectedUserId ? { ...user, status: "disabled" } : user)); return "Konto wyłączone, sesje cofnięte, przydziały zdjęte."; }, () => mutate(`/admin/users/${selectedUserId}/disable`, "POST")) }) : void perform(() => { setUsers((current) => current.map((user) => user.userId === selectedUserId ? { ...user, status: "active" } : user)); return "Konto włączone."; }, () => mutate(`/admin/users/${selectedUserId}/enable`, "POST"))}>{chosenUser.status === "active" ? "Wyłącz konto" : "Włącz konto"}</button></div></div>
                <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void perform("Hasło ustawione. Przy następnym logowaniu wymagana będzie zmiana.", () => mutate(`/admin/users/${selectedUserId}/password`, "POST", { temporaryPassword })); setTemporaryPassword(""); }}><label className="admin-field">Nowe hasło tymczasowe<input type="password" autoComplete="new-password" value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} minLength={14} maxLength={1024} required /></label><button className="admin-quiet" disabled={busy}>Ustaw hasło i cofnij sesje</button></form>
                <button className="admin-quiet danger" disabled={busy} onClick={() => requestConfirmation({ title: "Cofnąć wszystkie sesje?", description: `Wszystkie aktywne sesje użytkownika ${chosenUser.username} zostaną natychmiast unieważnione.${chosenUser.username === me.username ? " Bieżąca sesja administratora również zostanie wylogowana." : ""}`, confirmLabel: "Cofnij wszystkie sesje", action: () => perform("Aktywne sesje cofnięte.", () => mutate(`/admin/users/${selectedUserId}/revoke-sessions`, "POST")) })}>Cofnij wszystkie sesje</button>
              </> : <p className="admin-muted">Wybierz konto w sekcji dostępów.</p>}</article>
            </div>
            <article className="admin-card admin-table-card"><div className="admin-card-head"><div><h3>Sesje użytkownika</h3><p>Sesje są sprawdzane przy każdym żądaniu.</p></div><span className="admin-counter">{sessions.filter((session) => !session.revokedAt && Date.parse(session.expiresAt) > Date.now()).length} aktywnych</span></div>
                <div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Sesje użytkowników; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Przeglądarka</th><th>Utworzona</th><th>Ostatnia aktywność</th><th>Wygasa</th><th>Status</th><th /></tr></thead><tbody>{sessions.map((session) => <tr key={session.sessionId}><td>{session.browserLabel}</td><td>{dateLabel(session.createdAt)}</td><td>{dateLabel(session.lastSeenAt)}</td><td>{dateLabel(session.expiresAt)}</td><td>{session.revokedAt ? "Cofnięta" : Date.parse(session.expiresAt) <= Date.now() ? "Wygasła" : session.isCurrent ? "Bieżąca sesja" : "Aktywna"}</td><td>{!session.revokedAt && Date.parse(session.expiresAt) > Date.now() && <button className="admin-quiet danger" disabled={busy} onClick={() => requestConfirmation({ title: "Cofnąć tę sesję?", description: session.isCurrent ? "Cofniesz bieżącą sesję administratora; po operacji trzeba będzie zalogować się ponownie." : `Sesja użytkownika ${chosenUser?.username ?? ""} zostanie natychmiast unieważniona.`, confirmLabel: "Cofnij sesję", action: () => perform("Sesja cofnięta.", () => mutate(`/admin/users/${selectedUserId}/sessions/${session.sessionId}/revoke`, "POST")) })}>{session.isCurrent ? "Cofnij bieżącą" : "Cofnij"}</button>}</td></tr>)}</tbody></table></div>
            </article>
          </section>

            <section id="operations" className="admin-section">
            <div className="admin-section-title"><div><p className="eyebrow">BIEŻĄCA PRACA</p><h2>Centrum operacyjne</h2></div><button className="admin-quiet" disabled={loadingOperations} onClick={() => void loadOperations(operationPage)}>Odśwież stan</button></div>
            {operations && <div className="admin-service-strip"><span>API <b>{readableStatus(operations.api)}</b></span><span>Baza <b>{readableStatus(operations.database)}</b></span><span>Redis <b>{readableStatus(operations.redis)}</b></span><span>Worker <b>{readableStatus(operations.worker)}</b></span><span>Portale <b>{readableStatus(operations.portalMode)} · {readableStatus(operations.portalConfig)}</b></span><span>Dispatcher <b>{operations.dispatch.pendingCount} oczekujących</b></span></div>}
            <article className="admin-card admin-table-card"><div className="admin-card-head"><div><h3>Ostatnie zadania</h3><p>Strona po 50 rekordów. Filtry są niezależne od ustawień narzędzia i raportów.</p></div><div className="admin-filter-inline"><select aria-label="Narzędzie zadania" value={selectedOperationToolId} onChange={(event) => { setSelectedOperationToolId(event.target.value); setOperationPage(1); }}><option value="">Wszystkie narzędzia</option>{tools.map((tool) => <option key={tool.toolId} value={tool.toolId}>{tool.displayName}</option>)}</select><select aria-label="Status zadania" value={selectedRunStatus} onChange={(event) => { setSelectedRunStatus(event.target.value); setOperationPage(1); }}><option value="">Wszystkie statusy</option>{["queued", "waiting_for_sms", "waiting_for_manual_data", "completed", "no_matching_policies", "failed", "cancelled"].map((status) => <option key={status} value={status}>{readableStatus(status)}</option>)}</select><button className="admin-quiet" disabled={loadingOperations} onClick={() => void loadOperations(1)}>Filtruj zadania</button></div></div><div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Zadania operacyjne; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Narzędzie</th><th>Zadanie</th><th>Status</th><th>Krok</th><th>Utworzono</th><th>Błąd</th></tr></thead><tbody>{runRows.map((run, index) => <tr key={String(run.id ?? index)}><td>{String(run.toolId ?? "—")}</td><td className="mono">{String(run.id ?? "").slice(0, 12)}</td><td>{readableStatus(String(run.status ?? "—"))}</td><td>{readableStatus(String(run.currentStep ?? "—"))}</td><td>{dateLabel(String(run.createdAt ?? ""))}</td><td className="mono">{String(run.errorCode ?? "—")}</td></tr>)}</tbody></table>{loadingOperations && <p className="admin-empty" role="status">Wczytywanie zadań…</p>}{runRows.length === 0 && !loadingOperations && <p className="admin-empty">Użyj filtrów, aby pobrać zadania.</p>}</div><nav className="admin-pagination" aria-label="Strony zadań"><button className="admin-quiet" disabled={loadingOperations || operationPage <= 1} onClick={() => void loadOperations(operationPage - 1)}>Poprzednia</button><span>Strona {operationPage}</span><button className="admin-quiet" disabled={loadingOperations || !operationHasMore} onClick={() => void loadOperations(operationPage + 1)}>Następna</button></nav></article>
            <div className="admin-card admin-table-card"><div className="admin-card-head"><div><h3>Kolejka interwencji</h3><p>Przydział nie zmienia stanu zadania. Konflikt rewizji trzeba odświeżyć przed kolejną zmianą.</p></div><div className="admin-intervention-controls"><label className="admin-field">Znajdź odbiorcę przydziału<input aria-label="Szukaj odbiorcy przydziału" type="search" maxLength={128} value={assigneeSearch} onChange={(event) => { setAssigneeSearch(event.target.value); setAssigneeCursor(null); setAssigneeUsers([]); }} placeholder="Login lub jego fragment" /></label>{assigneeCursor && <button className="admin-quiet" disabled={loadingAssignees} onClick={() => void loadMoreAssignees()}>{loadingAssignees ? "Wczytywanie…" : "Wczytaj dalszych odbiorców"}</button>}<div className="admin-filter-inline"><select aria-label="Status zgłoszenia" value={selectedStatus} onChange={(event) => { setSelectedStatus(event.target.value); setInterventionPage(1); }}><option value="open">Otwarte</option><option value="resolved">Rozwiązane</option><option value="all">Wszystkie</option></select><select aria-label="Narzędzie zgłoszenia" value={selectedInterventionToolId} onChange={(event) => { setSelectedInterventionToolId(event.target.value); setInterventionPage(1); }}><option value="">Wszystkie narzędzia</option>{tools.map((tool) => <option key={tool.toolId} value={tool.toolId}>{tool.displayName}</option>)}</select><select aria-label="Filtruj po osobie" value={selectedAssigneeId} onChange={(event) => { setSelectedAssigneeId(event.target.value); setInterventionPage(1); }}><option value="">Wszystkie osoby</option>{assigneeOptions.map((user) => <option key={user.userId} value={user.userId}>{user.username} · {user.role}</option>)}</select><select aria-label="Priorytet zgłoszenia" value={selectedPriority} onChange={(event) => { setSelectedPriority(event.target.value); setInterventionPage(1); }}><option value="">Wszystkie priorytety</option><option value="high">Wysoki</option><option value="normal">Normalny</option></select><button className="admin-quiet" disabled={loadingInterventions} onClick={() => void loadInterventions(1)}>Filtruj zgłoszenia</button></div></div></div>
              <div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Kolejka interwencji; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Priorytet / zgłoszenie</th><th>Zadanie</th><th>Osoba</th><th>Termin</th><th>Rewizja</th><th>Akcje</th></tr></thead><tbody>{interventions.map((item) => {
                const draft = assignmentDrafts[item.interventionId] ?? assignmentDraftFor(item);
                const dueCandidates = draft.dueAtEdited && draft.dueAt ? warsawDateTimeCandidates(draft.dueAt) : [];
                return <tr key={item.interventionId}>
                  <td><button className={`priority-chip ${item.priority}`} onClick={() => void changePriority(item)}>{readableStatus(item.priority)}</button><small className="admin-cell-sub">{item.kind} · {item.reasonCode ?? "bez kodu"} · wiersz {item.rowNumber}</small></td>
                  <td><span className="mono">{item.runId.slice(0, 8)}</span><small className="admin-cell-sub">{item.toolId} · {item.currentStep}</small></td>
                  <td><select aria-label={`Przypisana osoba · ${item.interventionId.slice(0, 8)}`} value={draft.assigneeUserId} onChange={(event) => setAssignmentDrafts((current) => ({ ...current, [item.interventionId]: { ...(current[item.interventionId] ?? assignmentDraftFor(item)), assigneeUserId: event.target.value } }))}><option value="">Nieprzypisane</option>{item.assigneeUserId && !assigneeOptions.some((user) => user.userId === item.assigneeUserId) && <option value={item.assigneeUserId}>{item.assigneeUsername ?? "Obecnie przypisany użytkownik"}</option>}{assigneeOptions.map((user) => <option key={user.userId} value={user.userId}>{user.username} · {user.role}</option>)}</select></td>
                  <td><div className="admin-date-field"><input aria-label={`Termin zgłoszenia · ${item.interventionId.slice(0, 8)}`} aria-describedby={`due-time-help-${item.interventionId}`} type="datetime-local" value={draft.dueAt} onChange={(event) => setAssignmentDrafts((current) => ({ ...current, [item.interventionId]: { ...(current[item.interventionId] ?? assignmentDraftFor(item)), dueAt: event.target.value, dueAtEdited: true, ambiguousChoice: "" } }))} /><small id={`due-time-help-${item.interventionId}`}>Europe/Warsaw. Nieedytowany termin zachowuje dokładny zapis.</small>
                    {draft.dueAtEdited && draft.dueAt && dueCandidates.length === 0 && <small className="admin-date-error" aria-live="polite">Ta godzina nie istnieje w Europe/Warsaw.</small>}
                    {dueCandidates.length > 1 && <label className="admin-field admin-offset-field">Offset UTC<select aria-label={`Offset UTC · ${item.interventionId.slice(0, 8)}`} value={draft.ambiguousChoice} onChange={(event) => setAssignmentDrafts((current) => ({ ...current, [item.interventionId]: { ...(current[item.interventionId] ?? assignmentDraftFor(item)), ambiguousChoice: event.target.value } }))}><option value="">Wybierz właściwy czas</option>{dueCandidates.map((candidate) => <option key={candidate} value={candidate}>{warsawUtcOffsetLabel(candidate)} · {candidate}</option>)}</select></label>}
                  </div></td>
                  <td>{item.revision}</td><td className="admin-action-cell"><button className="admin-button small" disabled={busy} onClick={() => void assign(item)}>Zapisz</button><button className="admin-quiet" onClick={() => void showActivity(item.interventionId)}>Historia</button></td>
                </tr>;
              })}</tbody></table>{loadingInterventions && <p className="admin-empty" role="status">Wczytywanie zgłoszeń…</p>}{interventions.length === 0 && !loadingInterventions && <p className="admin-empty">Brak zgłoszeń dla wybranego filtra.</p>}</div>
              <nav className="admin-pagination" aria-label="Strony zgłoszeń"><button className="admin-quiet" disabled={loadingInterventions || interventionPage <= 1} onClick={() => void loadInterventions(interventionPage - 1)}>Poprzednia</button><span>Strona {interventionPage}</span><button className="admin-quiet" disabled={loadingInterventions || !interventionHasMore} onClick={() => void loadInterventions(interventionPage + 1)}>Następna</button></nav>
              {activityFor && <div className="admin-activity"><div className="admin-card-head"><h3>Historia · {activityFor.slice(0, 8)}</h3><button className="admin-quiet" onClick={() => { setActivityFor(""); setActivity([]); }}>Zamknij</button></div>{activity.length ? <ul>{activity.map((entry, index) => <li key={String(entry.createdAt ?? index)}>{String(entry.eventType)} · {String(entry.actorUsername ?? "użytkownik")} · {dateLabel(String(entry.createdAt ?? ""))}</li>)}</ul> : <p className="admin-muted">Brak zapisanych zmian.</p>}</div>}
            </div>
          </section>

          <section id="automation" className="admin-section">
            <div className="admin-section-title"><div><p className="eyebrow">NOWE URUCHOMIENIA</p><h2>Ustawienia automatyzacji</h2></div><p>Zmiany wpływają na tworzenie nowych zadań. Już przyjęte zadania zachowują swój przebieg.</p></div>
            {settings && <form className="admin-card admin-settings" onSubmit={saveSettings}>
              <label className="admin-toggle"><input type="checkbox" checked={settings.enabledForNewRuns} onChange={(event) => setSettings({ ...settings, enabledForNewRuns: event.target.checked })} /><span><strong>Przyjmuj nowe zadania</strong><small>Wyłączenie zatrzymuje nowe starty, nie przerywa zadań w toku.</small></span></label>
              <div className="admin-form-row"><label className="admin-field">Narzędzie<select value={selectedToolId} onChange={(event) => setSelectedToolId(event.target.value)}>{tools.map((tool) => <option key={tool.toolId} value={tool.toolId}>{tool.displayName}</option>)}</select></label><label className="admin-field">Limit startów na godzinę<input type="number" min="1" max="10000" value={newRunLimit} onChange={(event) => setNewRunLimit(event.target.value)} placeholder="Bez limitu" /></label></div>
              <div className="admin-form-row"><label className="admin-field">Początek okna pracy<input type="time" value={localTime(settings.allowedLocalStart)} onChange={(event) => setSettings({ ...settings, allowedLocalStart: event.target.value || null })} /></label><label className="admin-field">Koniec okna pracy<input type="time" value={localTime(settings.allowedLocalEnd)} onChange={(event) => setSettings({ ...settings, allowedLocalEnd: event.target.value || null })} /></label><label className="admin-field">Strefa czasowa<input value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} maxLength={80} /></label></div>
              <div className="admin-settings-foot"><span>Strefa zapisu: {settings.timezone} · wersja {settings.version} · zapisano {dateLabel(settings.updatedAt)}</span><button className="admin-button" disabled={busy}>Zapisz ustawienia</button></div>
            </form>}
          </section>

          <section id="audit" className="admin-section">
            <div className="admin-section-title"><div><p className="eyebrow">ZDARZENIA ORGANIZACJI</p><h2>Audyt z wyszukiwaniem</h2></div><p>Wyniki są stronicowane. Metadane mogące zawierać dane klienta nie są zwracane.</p></div>
            <form className="admin-card admin-filter-form" onSubmit={(event) => { setAudit([]); void searchAudit(event); }}>
              <label className="admin-field">Od<input type="date" value={auditFrom} onChange={(event) => setAuditFrom(event.target.value)} required /></label><label className="admin-field">Do (wyłącznie)<input type="date" value={auditTo} onChange={(event) => setAuditTo(event.target.value)} required /></label><label className="admin-field">Aktor ID<input value={auditFilters.actorId} onChange={(event) => setAuditFilters({ ...auditFilters, actorId: event.target.value })} /></label><label className="admin-field">Czynność<input placeholder="np. run.created" value={auditFilters.action} onChange={(event) => setAuditFilters({ ...auditFilters, action: event.target.value })} /></label><label className="admin-field">Rodzaj zasobu<input value={auditFilters.resourceType} onChange={(event) => setAuditFilters({ ...auditFilters, resourceType: event.target.value })} /></label><label className="admin-field">ID zasobu<input value={auditFilters.resourceId} onChange={(event) => setAuditFilters({ ...auditFilters, resourceId: event.target.value })} /></label><label className="admin-field">Wynik<select value={auditFilters.outcome} onChange={(event) => setAuditFilters({ ...auditFilters, outcome: event.target.value })}><option value="">Dowolny</option><option value="succeeded">Powodzenie</option><option value="failed">Błąd</option><option value="denied">Odmowa</option></select></label><label className="admin-field">Narzędzie<select value={auditFilters.toolId} onChange={(event) => setAuditFilters({ ...auditFilters, toolId: event.target.value })}><option value="">Dowolne</option>{tools.map((tool) => <option key={tool.toolId} value={tool.toolId}>{tool.displayName}</option>)}</select></label><button className="admin-button" disabled={busy}>Szukaj zdarzeń</button>
            </form>
            <div className="admin-card admin-table-card"><div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Zdarzenia audytu; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Czas</th><th>Aktor</th><th>Czynność</th><th>Zasób</th><th>ID zasobu</th><th>Wynik</th></tr></thead><tbody>{audit.map((event) => <tr key={event.eventId}><td>{dateLabel(event.createdAt)}</td><td>{event.actorUsername ?? "System"}</td><td><code>{event.action}</code></td><td>{event.resourceType}</td><td className="mono">{event.resourceId ?? "—"}</td><td>{readableStatus(event.outcome)}</td></tr>)}</tbody></table>{audit.length === 0 && <p className="admin-empty">Ustaw zakres i wyszukaj zdarzenia.</p>}</div>{auditCursor && <button className="admin-quiet admin-load-more" onClick={() => void searchAudit(undefined, auditCursor)}>Wczytaj starsze</button>}</div>
          </section>

          <section id="reports" className="admin-section">
            <div className="admin-section-title"><div><p className="eyebrow">WYNIKI I CZAS OBSŁUGI</p><h2>Raporty i jakość pracy</h2></div><p>Miary ukończenia liczą wyniki po czasie zakończenia. „Brak polis” pozostaje osobną kategorią.</p></div>
            <form className="admin-card admin-filter-form report-filter" onSubmit={loadReports}><label className="admin-field">Od<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label><label className="admin-field">Do (wyłącznie)<input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></label><label className="admin-field">Narzędzie<select value={selectedToolId} onChange={(event) => setSelectedToolId(event.target.value)}><option value="">Wszystkie</option>{tools.map((tool) => <option key={tool.toolId} value={tool.toolId}>{tool.displayName}</option>)}</select></label><button className="admin-button" disabled={busy}>Przelicz zakres</button></form>
            {report && <>
              <div className="admin-report-kpis"><article><small>UTWORZONE</small><strong><StatValue value={report.counts.created} /></strong></article><article><small>UKOŃCZONE</small><strong><StatValue value={report.counts.completed} /></strong></article><article><small>BRAK PASUJĄCYCH POLIS</small><strong><StatValue value={report.counts.noPolicies} /></strong></article><article><small>BŁĘDY</small><strong><StatValue value={report.counts.failed} /></strong></article><article><small>W TOKU</small><strong><StatValue value={report.counts.inProgress} /></strong></article><article><small>POBRANE PLIKI</small><strong><StatValue value={report.counts.downloads} /></strong></article><article><small>WYGENEROWANE PLIKI</small><strong><StatValue value={report.counts.generated} /></strong></article><article><small>OTWARTE INTERWENCJE</small><strong><StatValue value={report.counts.openInterventions} /></strong></article></div>
              <div className="admin-grid"><article className="admin-card"><h3>Przepustowość dzienna</h3><p>Nowe zadania według dnia w strefie Europe/Warsaw.</p><div className="admin-bars" role="img" aria-label="Wykres liczby zadań utworzonych każdego dnia">{report.daily.map((point) => <div key={point.day}><span style={{ height: `${Math.max(4, point.created / maxDaily * 100)}%` }} title={`${point.created} utworzonych`} /><small>{point.day.slice(5)}</small></div>)}</div></article><article className="admin-card"><h3>Czas i skuteczność</h3><dl className="admin-definition-list"><div><dt>Skuteczność ukończenia</dt><dd>{report.completionRate === null ? "—" : `${(report.completionRate * 100).toFixed(1)}%`}</dd></div><div><dt>Mediana zadania</dt><dd>{report.durationSeconds.median === null ? "—" : `${Math.round(report.durationSeconds.median / 60)} min`}</dd></div><div><dt>90. percentyl</dt><dd>{report.durationSeconds.p90 === null ? "—" : `${Math.round(report.durationSeconds.p90 / 60)} min`}</dd></div><div><dt>Mediana rozwiązania interwencji</dt><dd>{report.medianResolvedInterventionSeconds === null ? "—" : `${Math.round(report.medianResolvedInterventionSeconds / 3600)} godz.`}</dd></div></dl><details><summary>Jak liczone są wskaźniki?</summary><ul>{Object.entries(report.definitions).map(([key, value]) => <li key={key}><strong>{key}:</strong> {value}</li>)}</ul></details></article></div>
              <article className="admin-card admin-table-card"><h3>Kody błędów</h3><div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Kody błędów; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Kod</th><th>Status</th><th>Liczba</th><th>Pierwszy</th><th>Ostatni</th></tr></thead><tbody>{failures.map((failure, index) => <tr key={`${String(failure.errorCode)}-${index}`}><td className="mono">{String(failure.errorCode ?? "bez kodu")}</td><td>{readableStatus(String(failure.status))}</td><td>{String(failure.count)}</td><td>{dateLabel(String(failure.firstSeenAt ?? ""))}</td><td>{dateLabel(String(failure.lastSeenAt ?? ""))}</td></tr>)}</tbody></table>{failures.length === 0 && <p className="admin-empty">W tym zakresie nie ma błędów.</p>}</div></article>
              <div className="admin-grid"><article className="admin-card admin-table-card"><h3>Interwencje</h3><div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Interwencje w raporcie; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Typ</th><th>Powód</th><th>Status</th><th>Liczba</th><th>Mediana rozwiązania</th><th>Otwarte</th></tr></thead><tbody>{interventionReport.map((item, index) => <tr key={`${String(item.kind)}-${String(item.reasonCode)}-${index}`}><td>{String(item.kind ?? "—")}</td><td className="mono">{String(item.reasonCode ?? "—")}</td><td>{readableStatus(String(item.status ?? "—"))}</td><td>{String(item.count ?? 0)}</td><td>{item.medianResolutionSeconds == null ? "—" : `${Math.round(Number(item.medianResolutionSeconds) / 3600)} godz.`}</td><td>{String(item.openCount ?? 0)}</td></tr>)}</tbody></table>{interventionReport.length === 0 && <p className="admin-empty">Brak interwencji w zakresie.</p>}</div></article><article className="admin-card admin-table-card"><h3>Tempo obsługi</h3><p>Agregaty według dnia utworzenia w Europe/Warsaw.</p><div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Przepustowość dzienna; przewiń w poziomie, aby zobaczyć wszystkie kolumny"><table><thead><tr><th>Dzień</th><th>Utworzone</th><th>Ukończone</th><th>Bez polis</th><th>Błędy</th><th>Mediana</th></tr></thead><tbody>{throughput.map((item, index) => <tr key={`${String(item.day)}-${index}`}><td>{dateLabel(String(item.day ?? ""))}</td><td>{String(item.created ?? 0)}</td><td>{String(item.completed ?? 0)}</td><td>{String(item.noPolicies ?? 0)}</td><td>{String(item.failed ?? 0)}</td><td>{item.medianRunSeconds == null ? "—" : `${Math.round(Number(item.medianRunSeconds) / 60)} min`}</td></tr>)}</tbody></table>{throughput.length === 0 && <p className="admin-empty">Brak danych przepustowości w zakresie.</p>}</div></article></div>
            </>}
          </section>
        </>}
      </div>
    </main>
    <AdminConfirmDialog confirmation={confirmation} busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => void confirmPendingAction()} />
  </div>;
}
