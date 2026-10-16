const { mkdirSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve, join } = require("node:path");
const { chromium } = require("playwright");

const outDir = join(__dirname, "review-output-2026-10-12");
const webDir = resolve(__dirname, "../../../../apps/web");
const csrfToken = "synthetic-screenshot-csrf-token-2026";
const adminId = "11111111-1111-4111-8111-111111111111";
const managerId = "22222222-2222-4222-8222-222222222222";
const operatorId = "33333333-3333-4333-8333-333333333333";
const importId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const resultSetId = "66666666-6666-4666-8666-666666666666";
const leadId = "77777777-7777-4777-8777-777777777777";
const submissionId = "88888888-8888-4888-8888-888888888888";
const toolId = "oc-policy-verification";

const employees = [
  { userId: operatorId, username: "anna.nowak", role: "operator", status: "active", membershipStatus: "active", createdAt: "2026-09-16T09:00:00.000Z", lastLoginAt: "2026-10-11T08:32:00.000Z", activeSessionCount: 1, leadCount: 18, canExecuteOc: true },
  { userId: "99999999-9999-4999-8999-999999999999", username: "piotr.kowalski", role: "operator", status: "active", membershipStatus: "active", createdAt: "2026-09-12T10:00:00.000Z", lastLoginAt: "2026-10-10T15:20:00.000Z", activeSessionCount: 0, leadCount: 12, canExecuteOc: false },
  { userId: managerId, username: "ewa.zielinska", role: "manager", status: "active", membershipStatus: "active", createdAt: "2026-08-02T08:00:00.000Z", lastLoginAt: "2026-10-11T07:58:00.000Z", activeSessionCount: 1, leadCount: 6, canExecuteOc: true },
];

function lead(id, company, assignedTo = "anna.nowak", contactStatus = "not_contacted") {
  const assignedId = assignedTo === "anna.nowak" ? operatorId : assignedTo === "ewa.zielinska" ? managerId : null;
  return {
    id, resultSetId, automationId: toolId, operationId: runId, sourceImportId: importId,
    sourceRowIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], createdAt: "2026-10-10T14:15:00.000Z", referenceDate: "2026-10-10",
    company, nip: "5260250275", regon: "012345678", address: "ul. Przemysłowa 18", postalCode: "02-495", city: "Warszawa",
    decisionMakers: ["Marta Wiśniewska"], contacts: [{ type: "phone", value: "+48 22 555 01 20", sourceRowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { type: "email", value: "kontakt@transportowa.pl", sourceRowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    resultStatus: "completed", contactStatus, contactStatusVersion: 2, contactStatusUpdatedAt: contactStatus === "not_contacted" ? null : "2026-10-11T09:20:00.000Z",
    assignedToUserId: assignedId, assignedTo, assignedByUserId: managerId, assignedAt: assignedTo ? "2026-10-10T15:00:00.000Z" : null,
    runCount: 2, policyCount: 4, runs: [runId], canEditContactStatus: true,
    sourceRows: [{ rowNumber: 14, companyName: company, decisionMakerName: "Marta Wiśniewska", nip: "5260250275", regon: "012345678", address: "ul. Przemysłowa 18", postalCode: "02-495", city: "Warszawa", phone: "+48 22 555 01 20", email: "kontakt@transportowa.pl" }],
  };
}
const leads = [
  lead(leadId, "Transport i Logistyka Alfa sp. z o.o.", "anna.nowak", "not_contacted"),
  lead("99999999-9999-4999-8999-999999999998", "Mazovia Cargo S.A.", "piotr.kowalski", "offer_accepted"),
  lead("99999999-9999-4999-8999-999999999997", "Polskie Drogi Transport sp. z o.o.", null, "not_contacted"),
  lead("99999999-9999-4999-8999-999999999996", "Wschód Freight Group", "ewa.zielinska", "not_interested"),
];

function userFor(role) {
  const id = role === "admin" ? adminId : role === "manager" ? managerId : operatorId;
  const username = role === "admin" ? "admin.goldis" : role === "manager" ? "ewa.zielinska" : role === "reviewer" ? "reviewer.goldis" : role === "auditor" ? "auditor.goldis" : "anna.nowak";
  // The synthetic operator represents an employee with the OC execution grant.
  const canExecute = true;
  return { role, username, userId: id, csrfToken, mustChangePassword: false, canDeleteData: role === "admin", tools: [{ toolId, canDiscover: true, canExecute, canViewResults: true, canDownloadResults: true }] };
}

function appRun() {
  return { id: runId, batchId: importId, rowNumber: 14, toolId, status: "completed", currentStep: "completed", referenceDate: "2026-10-10", errorCode: null, controlState: "running", controlRevision: "2", controlAckRevision: "2", controlCheckpointStatus: null, createdAt: "2026-10-10T14:10:00.000Z", updatedAt: "2026-10-10T14:15:00.000Z", policyCounts: { totalOcCount: 4, currentOcCount: 3 }, artifactAvailable: true, events: [{ status: "queued", step: "queued", errorCode: null, createdAt: "2026-10-10T14:10:00.000Z" }, { status: "completed", step: "completed", errorCode: null, createdAt: "2026-10-10T14:15:00.000Z" }] };
}

function responseFor(path, url, method, role, request) {
  if (path === "/api/auth/me") return [role ? 200 : 401, role ? userFor(role) : { message: "Unauthenticated" }];
  if (path === "/api/tools" || path === "/api/admin/tools") return [200, { items: [{ toolId, displayName: "Weryfikacja polis OC", description: "Wyszukuj i weryfikuj aktualne polisy OC firm z importu Excel.", status: "available", access: { canExecute: true, canViewResults: true, canDownloadResults: true } }] }];
  if (path === "/api/dashboard") return [200, { role, tools: [{ toolId, canExecute: true, canViewResults: true, canDownloadResults: true }], metrics: { operations: { total: 8, active: 1, attention: 1, completed: 6 }, myLeads: { total: role === "manager" || role === "admin" ? 6 : 18, notContacted: 9, accepted: 5, notInterested: 4 }, team: role === "manager" || role === "admin" ? { unassigned: 42, assigned: 37, notContacted: 21, accepted: 10, notInterested: 6 } : null }, operations: [
    { id: runId, resultSetId, toolId, toolName: "Weryfikacja polis OC", sourceType: "import", sourceId: importId, batchId: importId, fileName: "Baza transportowa — październik.xlsx", status: "completed", createdAt: "2026-10-10T14:10:00.000Z", updatedAt: "2026-10-10T14:15:00.000Z", finishedAt: "2026-10-10T14:15:00.000Z", leadCount: 48, readyCount: 42, failedCount: 1 },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", resultSetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", toolId, toolName: "Weryfikacja polis OC", sourceType: "import", sourceId: importId, batchId: importId, fileName: "Flota — pilna kontrola.xlsx", status: "waiting_attention", createdAt: "2026-10-11T08:15:00.000Z", updatedAt: "2026-10-11T08:22:00.000Z", finishedAt: null, leadCount: 16, readyCount: 10, failedCount: 0 },
  ], actionRequired: [{ id: runId, toolName: "Weryfikacja polis OC", fileName: "Flota — pilna kontrola.xlsx", createdAt: "2026-10-11T08:22:00.000Z", href: `/runs/${runId}` }], unreadNotifications: 2 }];
  if (path === "/api/leads") return [200, { items: leads.map((item) => ({ ...item, canEditContactStatus: url.searchParams.get("scope") === "mine" ? true : role === "manager" || role === "admin" ? false : item.assignedToUserId === userFor(role).userId })), nextCursor: null }];
  if (path === "/api/leads/recipients") return [200, { items: [{ userId: operatorId, name: "anna.nowak", role: "operator" }, { userId: employees[1].userId, name: "piotr.kowalski", role: "operator" }, { userId: managerId, name: "ewa.zielinska", role: "manager" }] }];
  if (path === `/api/leads/${leadId}` || /^\/api\/leads\/[0-9a-f-]+$/.test(path)) {
    const found = leads.find((item) => item.id === path.split("/").pop()) ?? leads[0];
    return [200, { ...found, canEditContactStatus: found.assignedToUserId === userFor(role).userId }];
  }
  if (path === "/api/notifications" || path.startsWith("/api/notifications?")) return [200, { unreadCount: 2, items: [
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", eventType: "result_ready", title: "Wynik gotowy", message: "Operacja „Baza transportowa — październik.xlsx” zakończyła się. 42 firmy są gotowe do obsługi.", href: `/results/oc-policy-verification?resultSetId=${resultSetId}`, resultSetId, createdAt: "2026-10-11T09:10:00.000Z", readAt: null },
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", eventType: "action_required", title: "Wymagane działanie", message: "Zadanie oczekuje na wznowienie po potwierdzeniu logowania.", href: `/runs/${runId}`, resultSetId, createdAt: "2026-10-11T08:22:00.000Z", readAt: null },
  ] }];
  if (path === "/api/team/users" || path.startsWith("/api/team/users?")) return [200, { items: employees, nextCursor: null }];
  if (path === `/api/team/users/${operatorId}/access` || /\/api\/team\/users\/[0-9a-f-]+\/access$/.test(path)) return [200, { userId: operatorId, toolId, toolName: "Weryfikacja OC", canExecute: true, version: 2, resultsShared: true, canDownloadResults: true }];
  if (path === "/api/contact-reports/overview") return [200, { period: { from: url.searchParams.get("from"), to: url.searchParams.get("to"), basis: "lead_created_at", description: "Okres wybiera leady utworzone w tym czasie." }, resultSetId: null, summary: { total: 85, unassigned: 42, assigned: 43, notContacted: 21, accepted: 15, notInterested: 7 }, employees: employees.slice(0, 2).map((item, index) => ({ userId: item.userId, username: item.username, membershipStatus: "active", assigned: index ? 12 : 18, notContacted: index ? 6 : 9, accepted: index ? 4 : 5, notInterested: index ? 2 : 4 })) }];
  if (path === "/api/admin/reports/overview") return [200, { counts: { sourceRows: 130, canonicalGroups: 85, submissions: 12, actualRuns: 98, created: 98, completed: 82, noPolicies: 9, failed: 7, inProgress: 4, downloads: 51, generated: 76, openInterventions: 3 }, completionRate: 0.84, durationSeconds: { median: 170, p90: 430 }, medianResolvedInterventionSeconds: 1800, submissionsByStatus: { queued: 2, completed: 9 }, submissionGroupsByStateAndReason: [], daily: [], definitions: {} }];
  if (path === "/api/auth/sessions") return [200, { items: [{ sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff", createdAt: "2026-10-11T07:58:00.000Z", lastSeenAt: "2026-10-11T09:31:00.000Z", expiresAt: "2026-10-11T15:58:00.000Z", revokedAt: null, browserLabel: "Chrome · Windows", isCurrent: true }, { sessionId: "abababab-abab-4bab-8bab-abababababab", createdAt: "2026-10-09T11:12:00.000Z", lastSeenAt: "2026-10-10T16:45:00.000Z", expiresAt: "2026-10-09T19:12:00.000Z", revokedAt: null, browserLabel: "Edge · Windows", isCurrent: false }] }];
  if (path === "/api/imports" && method === "GET") return [200, { items: [{ id: importId, batchId: importId, toolId, fileName: "Baza transportowa — październik.xlsx", totalRows: 64, reviewCount: 3, createdAt: "2026-10-10T13:52:00.000Z", ownerLabel: "anna.nowak", status: "completed" }], nextCursor: null }];
  if (path === `/api/imports/${importId}`) return [200, { id: importId, totalRows: 64, invalidRows: 3, readyRows: 61, sha256: "a".repeat(64), fileName: "Baza transportowa — październik.xlsx", createdAt: "2026-10-10T13:52:00.000Z", ownerLabel: "anna.nowak", status: "completed" }];
  if (path === `/api/imports/${importId}/rows`) return [200, [
    { rowNumber: 14, companyName: "Transport i Logistyka Alfa sp. z o.o.", decisionMakerName: "Marta Wiśniewska", regon: "012345678", issues: [] },
    { rowNumber: 15, companyName: "Mazovia Cargo S.A.", decisionMakerName: "Jan Malinowski", regon: "123456789", issues: ["DUPLICATE_SOURCE_ROW"] },
    { rowNumber: 16, companyName: "Polskie Drogi Transport sp. z o.o.", decisionMakerName: null, regon: "", issues: ["REGON_EMPTY"] },
  ]];
  if (path === `/api/imports/${importId}/preparations`) return [200, { preparations: [{ preparationId: "20202020-2020-4202-8202-202020202020", batchId: importId, revision: 1, rulesVersion: "preparation-v1", sourceFingerprint: "b".repeat(64), status: "completed_with_attention", stage: "sealed", totalRows: 64, counts: { ready: 42, review: 3, skippedNoIdentifiers: 2, duplicates: 17, waitingRegistry: 0 }, version: 3, errorCode: null, createdAt: "2026-10-10T14:00:00.000Z", updatedAt: "2026-10-10T14:03:00.000Z", finishedAt: "2026-10-10T14:03:00.000Z", sealedAt: "2026-10-10T14:03:00.000Z" }] }];
  if (path === `/api/imports/${importId}/preparation-workflows`) return [200, { workflows: [] }];
  if (path === `/api/imports/${importId}/preparations/20202020-2020-4202-8202-202020202020/rows`) return [200, { preparationId: "20202020-2020-4202-8202-202020202020", status: "completed_with_attention", page: 1, pageSize: 50, total: 64, rows: [
    { rowNumber: 14, sourceRowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedRowVersion: 1, status: "ready", reasonCode: null, representativeRowNumber: null, normalizedName: "Transport i Logistyka Alfa sp. z o.o.", normalizedNip: "5260250275", effectiveRegon: "012345678", regonProvenance: "import" },
    { rowNumber: 16, sourceRowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedRowVersion: 1, status: "review", reasonCode: "REGON_LOOKUP_REQUIRED", representativeRowNumber: null, normalizedName: "Polskie Drogi Transport sp. z o.o.", normalizedNip: "5260250275", effectiveRegon: null, regonProvenance: "missing" },
    { rowNumber: 18, sourceRowId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", expectedRowVersion: 2, status: "duplicate", reasonCode: "DUPLICATE_SOURCE_ROW", representativeRowNumber: 14, normalizedName: "Transport i Logistyka Alfa sp. z o.o.", normalizedNip: "5260250275", effectiveRegon: "012345678", regonProvenance: "import" },
  ] }];
  if (path === `/api/imports/${importId}/enrichment`) return [200, { page: 1, pageSize: 50, totalRows: 1, summary: { missingRegonRows: 1, pendingCorrectionRows: 0, openConflictRows: 0, lookupStatuses: { matched: 1 } }, rows: [{ rowNumber: 16, companyName: "Polskie Drogi Transport sp. z o.o.", decisionMakerName: "Jakub Szymański", regonRaw: "", effectiveRegon: "987654321", rowVersion: 2, issues: [], state: "ready", source: "registry", correction: null, lookup: { status: "matched", reasonCode: null, providerName: "GUS BIR", providerVersion: "v1", checkedAt: "2026-10-10T14:01:00.000Z" }, conflict: null }] }];
  if (path === "/api/health/enrichment") return [200, { status: "not_ready", available: false, worker: "offline", provider: "configured", providerName: "GUS BIR", message: "Ostatnia weryfikacja: 16 wierszy. Wznawianie lookup wymaga aktywnego workera." }];
  if (path === `/api/imports/${importId}/enrichment-jobs`) return [200, { items: [] }];
  if (path === `/api/runs` && url.searchParams.has("batchId")) return [200, [appRun()]];
  if (path === `/api/runs/${runId}`) return [200, appRun()];
  if (path === "/api/health/automation") return [200, { automationReady: false, servicesReady: true, worker: "offline", portalMode: "off", portalConfig: "valid", message: "Import i przygotowanie danych są dostępne. Worker portali jest obecnie offline." }];
  if (path === "/api/interventions/summary") return [200, { openCount: 2, unreadCount: 1, smsCount: 1 }];
  if (path === "/api/interventions" || path.startsWith("/api/interventions?")) return [200, { items: [{ interventionId: "12121212-1212-4212-8212-121212121212", runId, batchId: importId, rowNumber: 14, kind: "sms", portal: "pzu", reasonCode: "SMS_TIMEOUT", fieldCode: null, status: "open", revision: 3, createdAt: "2026-10-11T08:22:00.000Z", updatedAt: "2026-10-11T08:22:00.000Z", challenge: null, isUnread: true, canSubmitSms: false, canResumeReview: false, assigneeUserId: managerId, isAssignedToMe: true, runStatus: "waiting_for_sms", canResumeAuth: true }], nextCursor: null }];
  if (path === "/api/history/runs") return [200, { items: [{ id: runId, batchId: importId, rowNumber: 14, toolId, status: "completed", referenceDate: "2026-10-10", errorCode: null, createdAt: "2026-10-10T14:10:00.000Z", policyCounts: { totalOcCount: 4, currentOcCount: 3 }, artifactAvailable: true, artifactId: resultSetId, deletionTargetType: "run", deletionTargetId: runId }], nextCursor: null }];
  if (path === "/api/history/results") return [200, { items: [{ id: runId, batchId: importId, rowNumber: 14, toolId, status: "completed", referenceDate: "2026-10-10", errorCode: null, createdAt: "2026-10-10T14:10:00.000Z", policyCounts: { totalOcCount: 4, currentOcCount: 3 }, artifactAvailable: true, artifactId: resultSetId, deletionTargetType: "artifact", deletionTargetId: resultSetId }], nextCursor: null }];
  if (path === "/api/deletions/jobs") return [200, { items: [] }];
  if (path === "/api/run-submissions/" + submissionId) return [200, { submissionId, importBatchId: importId, referenceDate: "2026-10-10", status: "waiting_attention", version: 4, counts: { selectedRows: 12, uniqueGroups: 10, items: { completed: 6, running: 2, waiting_attention: 1, excluded: 2, review: 1 }, groups: { accepted: 6, pending: 2, waiting: 1 } }, createdAt: "2026-10-10T14:03:00.000Z", updatedAt: "2026-10-10T14:12:00.000Z" }];
  if (path === `/api/run-submissions/${submissionId}/items`) return [200, { items: [
    { itemId: "13131313-1313-4313-8313-131313131313", rowNumber: 14, expectedRowVersion: 1, preparationState: "ready", reasonCode: null, admissionState: "accepted", groupReason: null, runId, runStatus: "completed", runErrorCode: null },
    { itemId: "14141414-1414-4414-8414-141414141414", rowNumber: 16, expectedRowVersion: 1, preparationState: "ready", reasonCode: null, admissionState: "waiting_capacity", groupReason: "HOURLY_RUN_LIMIT", runId: null, runStatus: null, runErrorCode: null },
  ], nextCursor: null }];
  if (path === "/api/review/corrections" || path === "/api/review/my-corrections") return [200, { items: [{ id: "15151515-1515-4515-8515-151515151515", status: "pending", createdAt: "2026-10-10T10:00:00.000Z", previousRegon: null, proposedRegon: "987654321", reason: "Potwierdzono dane firmy w rejestrze GUS.", rowNumber: 16, rowVersion: 2, companyName: "Polskie Drogi Transport sp. z o.o.", batchId: importId, toolId }], nextCursor: null, hasMore: false, limit: 50 }];
  if (path === "/api/review/conflicts") return [200, { items: [{ id: "16161616-1616-4616-8616-161616161616", status: "open", createdAt: "2026-10-10T10:15:00.000Z", reasonCode: "SAME_NIP_DIFFERENT_REGON", rowNumber: 18, rowVersion: 3, companyName: "Transport Mazowsze sp. z o.o.", effectiveRegon: "123456789", batchId: importId, toolId, candidates: [{ id: "17171717-1717-4717-8717-171717171717", businessName: "Transport Mazowsze", regon: "123456789" }] }], nextCursor: null, hasMore: false, limit: 50 }];
  if (path === "/api/audit/events") return [200, { items: [{ eventId: "18181818-1818-4818-8818-181818181818", actorUserId: managerId, actorUsername: "ewa.zielinska", action: "lead.allocated", resourceType: "lead", resourceId: leadId, outcome: "succeeded", createdAt: "2026-10-11T09:20:00.000Z" }, { eventId: "19191919-1919-4919-8919-191919191919", actorUserId: operatorId, actorUsername: "anna.nowak", action: "lead.contact_status_updated", resourceType: "lead", resourceId: leads[1].id, outcome: "succeeded", createdAt: "2026-10-11T09:10:00.000Z" }], nextCursor: null }];
  if (path === "/api/admin/overview") return [200, { userCount: 12, toolCount: 1, openInterventionCount: 3, activeRunCount: 4 }];
  if (path === "/api/admin/users" || path.startsWith("/api/admin/users?")) return [200, { items: [{ userId: adminId, username: "admin.goldis", role: "admin", status: "active", lastLoginAt: "2026-10-11T08:00:00.000Z", createdAt: "2026-04-01T09:00:00.000Z", activeSessionCount: 1 }, ...employees.map((item) => ({ userId: item.userId, username: item.username, role: item.role, status: item.status, lastLoginAt: item.lastLoginAt, createdAt: item.createdAt, activeSessionCount: item.activeSessionCount }))], nextCursor: null }];
  if (path === "/api/admin/runtime") return [200, { build: { version: "MVP", commit: "2026-10-11", imageDigest: null }, schema: { migrationCount: 53, latestMigration: "053-user-notifications", version: "053" } }];
  if (path === "/api/admin/operations/summary") return [200, { api: "online", database: "online", redis: "online", worker: "offline", portalMode: "off", portalConfig: "valid", automationReady: false, runCounts: { waiting_for_sms: 1, completed: 82 }, openInterventionCount: 3, dispatch: { pendingCount: 2, oldestCreatedAt: "2026-10-11T08:00:00.000Z" }, submissionGroups: { pendingCount: 2, oldestPendingAt: "2026-10-11T08:00:00.000Z", byStateAndReason: [{ status: "waiting_capacity", reasonCode: "HOURLY_RUN_LIMIT", count: 2 }] }, submissionCounts: { queued: 2, completed: 9 }, enrichment: { worker: { available: false, worker: "offline", provider: "gus-bir", providerName: "GUS BIR", message: "Worker wzbogacania offline" }, jobs: { pendingCount: 1, oldestPendingAt: "2026-10-11T08:00:00.000Z" }, providerBudgets: [{ providerName: "gus-bir", usageDate: "2026-10-11", dailyLimit: 6000, reservedRequests: 182, remainingRequests: 5818, limitReached: false, resetsAt: null }] } }];
  if (path === "/api/admin/operations/runs") return [200, { page: 1, hasMore: false, items: [appRun()] }];
  if (path === "/api/admin/interventions" || path.startsWith("/api/admin/interventions?")) return [200, { page: 1, hasMore: false, items: [{ interventionId: "12121212-1212-4212-8212-121212121212", runId, toolId, kind: "sms", portal: "pzu", reasonCode: "SMS_TIMEOUT", status: "open", priority: "high", dueAt: "2026-10-11T11:30:00.000Z", assigneeUserId: managerId, assigneeUsername: "ewa.zielinska", revision: 3, createdAt: "2026-10-11T08:22:00.000Z", rowNumber: 14, currentStep: "waiting_for_sms", runErrorCode: "SMS_TIMEOUT" }] }];
  if (/\/api\/admin\/users\/[0-9a-f-]+\/grants$/.test(path)) return [200, { userId: operatorId, role: "operator", canDeleteData: false, deletionGrantVersion: 0, items: [{ toolId, displayName: "Weryfikacja polis OC", status: "available", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true, version: 2 }] }];
  if (/\/api\/admin\/users\/[0-9a-f-]+\/sessions$/.test(path)) return [200, { items: [{ sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff", createdAt: "2026-10-11T08:00:00.000Z", lastSeenAt: "2026-10-11T09:00:00.000Z", expiresAt: "2026-10-11T16:00:00.000Z", revokedAt: null, browserLabel: "Chrome · Windows", isCurrent: false }] }];
  if (/\/api\/admin\/tools\/[^/]+\/settings$/.test(path)) return [200, { enabledForNewRuns: true, maxNewRunsPerHour: 12, allowedLocalStart: "07:00:00", allowedLocalEnd: "19:00:00", timezone: "Europe/Warsaw", version: 4, updatedAt: "2026-10-10T12:00:00.000Z" }];
  if (path === "/api/admin/reports/failures") return [200, { items: [{ errorCode: "PORTAL_TIMEOUT", status: "failed", count: 3, firstSeenAt: "2026-10-09T09:00:00.000Z", lastSeenAt: "2026-10-11T08:00:00.000Z" }] }];
  if (path === "/api/admin/reports/interventions") return [200, { items: [{ kind: "sms", status: "open", reasonCode: "SMS_TIMEOUT", count: 3, medianResolutionSeconds: 1800, openCount: 1 }] }];
  if (path === "/api/admin/reports/throughput") return [200, { items: [{ day: "2026-10-10", created: 18, completed: 15, noPolicies: 2, failed: 1, medianRunSeconds: 170 }] }];
  return [200, { items: [], nextCursor: null, page: 1, hasMore: false }];
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolveListen); });
  const value = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return value;
}
async function waitForServer(url, process) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { if ((await fetch(url)).ok) return; } catch { /* Next.js is starting. */ }
    await new Promise((delay) => setTimeout(delay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(port)], { cwd: webDir, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, NODE_ENV: "production", PORT: String(port) } });
  let browser;
  const captured = [];
  const failures = [];
  try {
    await waitForServer(base, server);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1, timezoneId: "Europe/Warsaw", locale: "pl-PL" });
    let activeRole = null;
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const [status, body] = responseFor(url.pathname, url, route.request().method(), activeRole, route.request());
      await route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => failures.push({ url: page.url(), error: error.message }));

    async function capture({ name, title, path, role, fullPage = true, waitFor }) {
      activeRole = role ?? null;
      const errorsBefore = failures.length;
      await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
      if (waitFor) await page.locator(waitFor).waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);
      await page.locator("h1").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(750);
      await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
      const file = `${name}.png`;
      await page.screenshot({ path: join(outDir, file), fullPage, animations: "disabled" });
      captured.push({ name, title, role: role ?? "bez logowania", path, file, fullPage, viewport: "1440×1040" });
      const pageText = await page.locator("body").innerText().catch(() => "");
      if (pageText.includes("Nie udało się pobrać") || pageText.includes("unexpected synthetic request")) failures.push({ url: page.url(), error: "Ekran zawiera błąd ładowania fixture" });
      if (failures.length > errorsBefore) console.warn(`SCREENSHOT_PAGE_ERRORS ${name}: ${JSON.stringify(failures.slice(errorsBefore))}`);
      console.log(`CAPTURED ${file} ${page.url()}`);
    }

    await capture({ name: "01-logowanie", title: "Logowanie", path: "/", role: null });
    await capture({ name: "02-dashboard-pracownik", title: "Przegląd — pracownik", path: "/dashboard", role: "operator" });
    await capture({ name: "03-dashboard-menedzer", title: "Przegląd — menedżer", path: "/dashboard", role: "manager" });
    await capture({ name: "04-katalog-automatyzacji-pracownik", title: "Katalog automatyzacji — pracownik", path: "/tools", role: "operator" });
    await capture({ name: "05-katalog-automatyzacji-menedzer", title: "Katalog automatyzacji — menedżer", path: "/tools", role: "manager" });
    await capture({ name: "06-narzedzie-oc", title: "Automatyzacja OC — import i start", path: "/tools/oc-policy-verification", role: "operator" });
    await capture({ name: "07-import-wyniki-i-zadania", title: "Import — podgląd wyników i zadań", path: `/tools/oc-policy-verification?import=${importId}`, role: "operator" });
    await capture({ name: "08-wyniki-pula-menedzer", title: "Wyniki — wspólna pula i przydzielanie", path: "/results/oc-policy-verification", role: "manager" });
    await capture({ name: "09-wyniki-pula-pracownik", title: "Wyniki — wspólna pula pracownika", path: "/results/oc-policy-verification", role: "operator" });
    await capture({ name: "10-moje-wyniki", title: "Moje wyniki", path: "/my-results", role: "operator" });
    await capture({ name: "11-szczegoly-leadu", title: "Szczegóły firmy / leadu", path: `/my-results/${leadId}`, role: "operator" });
    await capture({ name: "12-historia-importow", title: "Historia importów", path: "/imports", role: "manager" });
    await capture({ name: "13-historia-zadan", title: "Historia zadań", path: "/runs", role: "manager" });
    await capture({ name: "14-historia-wynikow", title: "Historia wyników", path: "/results/history", role: "manager" });
    await capture({ name: "15-szczegoly-zadania", title: "Szczegóły uruchomienia", path: `/runs/${runId}`, role: "manager" });
    await capture({ name: "16-szczegoly-zgloszenia", title: "Szczegóły zgłoszenia", path: `/submissions/${submissionId}`, role: "manager" });
    await capture({ name: "17-weryfikacja-danych", title: "Weryfikacja danych — recenzent", path: "/review", role: "reviewer" });
    await capture({ name: "18-weryfikacja-danych-pracownik", title: "Moje korekty — pracownik", path: "/review", role: "operator" });
    await capture({ name: "19-dziennik-audytu-recenzent", title: "Dziennik aktywności — recenzent", path: "/audit", role: "reviewer" });
    await capture({ name: "20-dziennik-audytu-audytor", title: "Dziennik aktywności — audytor", path: "/audit", role: "auditor" });
    await capture({ name: "21-powiadomienia", title: "Powiadomienia", path: "/notifications", role: "operator" });
    await capture({ name: "22-zespol", title: "Zespół i konta pracowników", path: "/team", role: "manager" });
    await capture({ name: "23-dostepy-do-narzedzi", title: "Dostępy do narzędzi", path: "/access", role: "manager" });
    await capture({ name: "24-raporty", title: "Raporty", path: "/reports", role: "manager" });
    await capture({ name: "25-panel-admina", title: "Panel administracyjny — pełna strona", path: "/admin", role: "admin" });
    for (const section of ["resources", "accounts", "operations", "automation", "audit", "reports"]) {
      await page.locator(`#${section}`).scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const file = `25-admin-${section}.png`;
      await page.screenshot({ path: join(outDir, file), fullPage: false, animations: "disabled" });
      captured.push({ name: `admin-${section}`, title: `Administracja — ${section}`, role: "admin", path: `/admin#${section}`, file, fullPage: false, viewport: "1440×1040" });
    }
    await capture({ name: "26-konto-i-bezpieczenstwo", title: "Konto i bezpieczeństwo", path: "/account", role: "operator" });
    await capture({ name: "27-pula-wynikow-alias", title: "Wyniki — ścieżka /results", path: "/results", role: "manager" });
    await capture({ name: "28-szczegoly-leadu-z-puli", title: "Szczegóły leadu ze wspólnej puli", path: `/leads/${leadId}`, role: "manager" });
    await capture({ name: "29-weryfikacja-konflikty", title: "Weryfikacja danych — konflikty encji", path: "/review?tab=conflicts", role: "reviewer" });

    writeFileSync(join(outDir, "screenshots.json"), JSON.stringify({ generatedAt: new Date().toISOString(), source: "lokalny build aplikacji; dane demonstracyjne mockowane przez Playwright", viewport: "1440×1040", captured }, null, 2), "utf8");
    if (failures.length) writeFileSync(join(outDir, "capture-errors.json"), JSON.stringify(failures, null, 2), "utf8");
    console.log(`DONE screenshots=${captured.length} pageErrors=${failures.length}`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
