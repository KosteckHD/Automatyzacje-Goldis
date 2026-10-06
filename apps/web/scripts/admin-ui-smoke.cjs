const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const csrfToken = "synthetic-admin-ui-csrf-token-12345678901234567890";
const adminId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";
const user101Id = "99999999-9999-4999-8999-999999999999";
const toolId = "oc-policy-verification";
const interventionId = "44444444-4444-4444-8444-444444444444";
const interventionPageTwoId = "88888888-8888-4888-8888-888888888888";
const userRoleOverrides = new Map();
const userStatusOverrides = new Map();
let assignmentConflictOnce = true;
let operationFailureOnce = true;
const firstHundredUsers = [
  { userId: adminId, username: "admin.demo", role: "admin", status: "active", lastLoginAt: null, createdAt: "2026-10-01T09:00:00.000Z", activeSessionCount: 1 },
  { userId: operatorId, username: "operator.demo", role: "operator", status: "active", lastLoginAt: null, createdAt: "2026-10-01T08:00:00.000Z", activeSessionCount: 1 },
  ...Array.from({ length: 98 }, (_, index) => ({
    userId: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    username: `operator.member.${String(index + 3).padStart(3, "0")}`, role: "operator", status: "active", lastLoginAt: null,
    createdAt: new Date(Date.UTC(2026, 8, 30, 0, 0, 0) - index * 1000).toISOString(), activeSessionCount: 0,
  })),
];
const user101 = { userId: user101Id, username: "operator.member.101", role: "operator", status: "active", lastLoginAt: null, createdAt: "2026-09-29T09:00:00.000Z", activeSessionCount: 0 };
const portProbe = createServer();

async function freePort() {
  await new Promise((resolveListen, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolveListen); });
  const port = portProbe.address().port;
  await new Promise((resolveClose, reject) => portProbe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForServer(url, process) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { const response = await fetch(url); if (response.ok) return; } catch { /* The production server is starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  });
  let browser;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: "UTC" });
    const pageErrors = [];
    const writes = [];
    const reads = [];
    const pageRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const path = url.pathname;
      let body = {};
      let status = 200;
      if (path === "/api/auth/me") body = { role: "admin", username: "admin.demo", csrfToken, mustChangePassword: false };
      else if (path === "/api/admin/overview") body = { userCount: 2, toolCount: 1, openInterventionCount: 1, activeRunCount: 1 };
      else if (path === "/api/admin/users" && method === "GET") {
        const cursor = url.searchParams.get("cursor");
        const search = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const allUsers = [...firstHundredUsers, user101].map((user) => ({
          ...user, role: userRoleOverrides.get(user.userId) ?? user.role,
          status: userStatusOverrides.get(user.userId) ?? user.status,
        }));
        const searched = search ? allUsers.filter((user) => user.username.toLowerCase().includes(search)) : null;
        body = cursor === "users-page-2"
          ? { items: [allUsers[allUsers.length - 1]], nextCursor: null }
          : { items: searched ?? firstHundredUsers.map((user) => ({ ...user, role: userRoleOverrides.get(user.userId) ?? user.role, status: userStatusOverrides.get(user.userId) ?? user.status })), nextCursor: searched ? null : "users-page-2" };
      }
      else if (path === "/api/admin/tools" || path === "/api/tools") body = { items: [{ toolId, displayName: "Weryfikacja polis OC", description: "synthetic", status: "available" }] };
      else if (path === "/api/admin/operations/summary") body = { api: "online", database: "online", redis: "online", worker: "offline", portalMode: "off", portalConfig: "valid", automationReady: false, runCounts: { waiting_for_sms: 1 }, openInterventionCount: 1, dispatch: { pendingCount: 0, oldestCreatedAt: null } };
      else if (path === "/api/admin/operations/runs") {
        const pageNumber = Number(url.searchParams.get("page") ?? "1");
        pageRequests.push(`operations:${pageNumber}`);
        if (operationFailureOnce && pageNumber === 1) { operationFailureOnce = false; status = 503; body = { message: "Syntetyczna niedostępność centrum operacyjnego" }; }
        else body = { page: pageNumber, hasMore: pageNumber === 1, items: [{ id: pageNumber === 1 ? "33333333-3333-4333-8333-333333333333" : "77777777-7777-4777-8777-777777777777", toolId, status: "waiting_for_sms", currentStep: "waiting_for_sms", rowNumber: 18001 + pageNumber, createdAt: "2026-10-02T08:00:00.000Z", errorCode: null }] };
      }
      else if (path === "/api/admin/interventions") {
        reads.push(url.searchParams.toString());
        const pageNumber = Number(url.searchParams.get("page") ?? "1");
        pageRequests.push(`interventions:${pageNumber}`);
        body = { page: pageNumber, hasMore: pageNumber === 1, items: [{ interventionId: pageNumber === 1 ? interventionId : interventionPageTwoId, runId: pageNumber === 1 ? "33333333-3333-4333-8333-333333333333" : "55555555-5555-4555-8555-555555555555", toolId, kind: "sms", portal: "pzu", reasonCode: "SMS_TIMEOUT", status: "open", priority: "normal", dueAt: "2026-10-05T12:00:00.123Z", assigneeUserId: null, assigneeUsername: null, revision: 2, createdAt: "2026-10-02T08:00:00.000Z", rowNumber: 18001 + pageNumber, currentStep: "waiting_for_sms", runErrorCode: "SMS_RETRY_REQUIRED" }] };
      }
      else if (path.endsWith(`/users/${adminId}/grants`) || path.endsWith(`/users/${operatorId}/grants`) || /\/users\/[0-9a-f-]+\/grants$/.test(path)) body = { userId: operatorId, role: "operator", items: [{ toolId, displayName: "Weryfikacja polis OC", status: "available", canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: false, version: 3 }] };
      else if (/\/users\/[0-9a-f-]+\/sessions$/.test(path)) body = { items: [{ sessionId: "55555555-5555-4555-8555-555555555555", createdAt: "2026-10-02T07:00:00.000Z", lastSeenAt: "2026-10-02T08:00:00.000Z", expiresAt: "2026-10-02T15:00:00.000Z", revokedAt: null, browserLabel: "Chrome · Windows", isCurrent: false }] };
      else if (method === "GET" && /\/admin\/tools\/[^/]+\/settings$/.test(path)) body = { enabledForNewRuns: true, maxNewRunsPerHour: 5, allowedLocalStart: "08:00:00", allowedLocalEnd: "18:00:00", timezone: "Europe/Warsaw", version: 2, updatedAt: "2026-10-02T08:00:00.000Z" };
      else if (/\/admin\/interventions\/[0-9a-f-]+\/activity$/.test(path)) body = { items: [{ eventType: "assigned", actorUsername: "admin.demo", createdAt: "2026-10-02T08:00:00.000Z" }] };
      else if (path === "/api/audit/events") body = { items: [{ eventId: "66666666-6666-4666-8666-666666666666", actorUserId: adminId, actorUsername: "admin.demo", action: "tool.grant.updated", resourceType: "tool", resourceId: toolId, outcome: "succeeded", createdAt: "2026-10-02T08:00:00.000Z" }], nextCursor: null };
      else if (path === "/api/admin/reports/overview") body = { counts: { created: 4, completed: 2, noPolicies: 1, failed: 1, inProgress: 0, downloads: 3, generated: 2, openInterventions: 1 }, completionRate: 0.5, durationSeconds: { median: 300, p90: 600 }, medianResolvedInterventionSeconds: 1800, daily: [{ day: "2026-10-02", created: 4, completed: 2, noPolicies: 1, failed: 1 }], definitions: { created: "run.created_at w zakresie", completionRate: "według finished_at" } };
      else if (path === "/api/admin/reports/failures") body = { items: [] };
      else if (path === "/api/admin/reports/interventions") body = { items: [{ kind: "sms", status: "open", reasonCode: "SMS_TIMEOUT", count: 1, medianResolutionSeconds: null, openCount: 1 }] };
      else if (path === "/api/admin/reports/throughput") body = { items: [{ day: "2026-10-02", created: 4, completed: 2, noPolicies: 1, failed: 1, medianRunSeconds: 300 }] };
      else if (method === "PATCH" && /\/admin\/tools\/[^/]+\/settings$/.test(path)) {
        writes.push({ path, method, headers: request.headers(), payload: request.postDataJSON() });
        body = { enabledForNewRuns: true, maxNewRunsPerHour: 4, allowedLocalStart: "08:00:00", allowedLocalEnd: "18:00:00", timezone: "Europe/Warsaw", version: 3, updatedAt: "2026-10-02T08:05:00.000Z" };
      }
      else if (method === "PATCH" && path.endsWith(`/interventions/${interventionId}/assignment`) && assignmentConflictOnce) {
        assignmentConflictOnce = false;
        writes.push({ path, method, headers: request.headers(), payload: request.postDataJSON() });
        status = 409;
        body = { message: "Zgłoszenie zmieniło się w innej sesji" };
      }
      else if (method === "PATCH" && /\/admin\/users\/[0-9a-f-]+\/role$/.test(path)) {
        writes.push({ path, method, headers: request.headers(), payload: request.postDataJSON() });
        userRoleOverrides.set(path.split("/").at(-2), request.postDataJSON().role);
        body = { ok: true };
      }
      else if (method === "POST" && /\/admin\/users\/[0-9a-f-]+\/disable$/.test(path)) {
        writes.push({ path, method, headers: request.headers(), payload: request.postDataJSON() });
        userStatusOverrides.set(path.split("/").at(-2), "disabled");
        body = { ok: true };
      }
      else if (method === "POST" && /\/admin\/users\/[0-9a-f-]+\/enable$/.test(path)) {
        writes.push({ path, method, headers: request.headers(), payload: request.postDataJSON() });
        userStatusOverrides.set(path.split("/").at(-2), "active");
        body = { ok: true };
      }
      else if (method !== "GET") {
        writes.push({ path, method, headers: request.headers(), payload: request.postDataJSON() });
        body = method === "POST" && path === "/api/admin/users" ? { userId: "77777777-7777-4777-8777-777777777777", username: "new.operator", status: "active", role: "operator", mustChangePassword: true } : { ok: true };
      } else { body = { message: `Unexpected API request: ${method} ${path}` }; status = 404; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store" } });
    });

    await page.goto(`${baseUrl}/admin`);
    await page.getByRole("heading", { name: "Dostęp i jakość pracy pod kontrolą." }).waitFor({ state: "visible" });
    await page.locator("label.admin-field").filter({ hasText: /^Użytkownik/ }).locator("select").selectOption(operatorId);
    const execute = page.getByLabel("Uruchamianie");
    await execute.waitFor({ state: "visible" });
    await execute.check();
    await page.getByRole("button", { name: "Zapisz grant" }).click();
    await page.getByRole("status").filter({ hasText: "Uprawnienia zapisane" }).waitFor({ state: "visible" });
    const grantWrite = writes.find((item) => item.path.endsWith(`/users/${operatorId}/grants/${toolId}`) && item.method === "PUT");
    assert.equal(grantWrite?.payload.expectedVersion, 3, "zapis grantu używa wersji CAS");
    assert.equal(grantWrite?.headers["x-csrf-token"], csrfToken, "grant zawiera CSRF");

    const revokeGrant = page.getByRole("button", { name: "Cofnij dostęp" });
    await revokeGrant.click();
    const grantDialog = page.getByRole("alertdialog");
    await grantDialog.waitFor({ state: "visible" });
    await grantDialog.getByRole("button", { name: "Anuluj" }).click();
    assert.equal(writes.filter((item) => item.path.endsWith(`/grants/${toolId}/revoke`)).length, 0, "anulowanie cofnięcia grantu nie wysyła mutacji");
    assert.equal(await revokeGrant.evaluate((element) => element === document.activeElement), true, "zamknięcie dialogu zwraca fokus do akcji wywołującej");
    await revokeGrant.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cofnij dostęp" }).click();
    await page.getByRole("status").filter({ hasText: "Grant cofnięty" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith(`/grants/${toolId}/revoke`)).length, 1, "potwierdzenie grantu wysyła dokładnie jedną mutację");

    await page.getByRole("button", { name: "Wczytaj kolejnych użytkowników" }).click();
    const userSelect = page.locator("label.admin-field").filter({ hasText: /^Użytkownik/ }).locator("select");
    await userSelect.getByRole("option", { name: /operator\.member\.101/ }).waitFor({ state: "attached" });
    await userSelect.selectOption(user101Id);
    await page.getByText("operator.member.101", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Wyłącz konto" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Wyłącz konto" }).click();
    await page.getByRole("status").filter({ hasText: "Konto wyłączone" }).waitFor({ state: "visible" });
    assert.equal(await userSelect.inputValue(), user101Id, "wybrany 101. użytkownik pozostaje wybrany po odświeżeniu strony");
    await page.getByRole("button", { name: "Włącz konto" }).click();
    await page.getByRole("status").filter({ hasText: "Konto włączone" }).waitFor({ state: "visible" });
    assert.equal(await userSelect.inputValue(), user101Id, "wybrany użytkownik spoza strony pozostaje dostępny po mutacji");
    await userSelect.selectOption(operatorId);

    const roleSelect = page.locator("#accounts .admin-form-row select");
    await roleSelect.selectOption("reviewer");
    assert.equal(writes.filter((item) => item.path.endsWith("/role")).length, 0, "wybór roli nie zapisuje jej automatycznie");
    await page.getByRole("button", { name: "Zapisz rolę" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Anuluj" }).click();
    assert.equal(writes.filter((item) => item.path.endsWith("/role")).length, 0, "anulowanie zmiany roli nie wysyła mutacji");
    await page.getByRole("button", { name: "Zapisz rolę" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Zapisz rolę" }).click();
    await page.getByRole("status").filter({ hasText: "Rola zaktualizowana" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith("/role")).length, 1, "potwierdzenie roli wysyła jedną zmianę z API");

    const disablesBeforeOperator = writes.filter((item) => item.path.endsWith("/disable")).length;
    await page.getByRole("button", { name: "Wyłącz konto" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Anuluj" }).click();
    assert.equal(writes.filter((item) => item.path.endsWith("/disable")).length, disablesBeforeOperator, "anulowanie wyłączenia konta nie wysyła mutacji");
    await page.getByRole("button", { name: "Wyłącz konto" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Wyłącz konto" }).click();
    await page.getByRole("status").filter({ hasText: "Konto wyłączone" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith("/disable")).length, disablesBeforeOperator + 1, "potwierdzenie wyłącza konto dokładnie raz");

    const enablesBeforeOperator = writes.filter((item) => item.path.endsWith("/enable")).length;
    await page.getByRole("button", { name: "Włącz konto" }).click();
    await page.getByRole("status").filter({ hasText: "Konto włączone" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith("/enable")).length, enablesBeforeOperator + 1, "włączenie konta nie wymaga dodatkowego dialogu");

    await page.getByRole("button", { name: "Cofnij wszystkie sesje" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Anuluj" }).click();
    assert.equal(writes.filter((item) => item.path.endsWith("/revoke-sessions")).length, 0, "anulowanie cofnięcia sesji nie wysyła mutacji");
    await page.getByRole("button", { name: "Cofnij wszystkie sesje" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cofnij wszystkie sesje" }).click();
    await page.getByRole("status").filter({ hasText: "Aktywne sesje cofnięte" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith("/revoke-sessions")).length, 1, "potwierdzenie cofa sesje jednym żądaniem");

    await page.getByLabel("Login", { exact: true }).fill("new.operator");
    await page.locator("#accounts form").first().locator('input[type="password"]').fill("Synthetic-Temp-Password-2026!");
    await page.getByRole("button", { name: "Utwórz konto" }).click();
    await page.getByRole("status").filter({ hasText: "Konto utworzone" }).waitFor({ state: "visible" });
    assert.ok(writes.some((item) => item.path === "/api/admin/users" && item.payload.password === "Synthetic-Temp-Password-2026!"));

    await page.locator("#operations").scrollIntoViewIfNeeded();
    const failedOperationsRequest = page.waitForResponse((response) => response.url().includes("/api/admin/operations/runs?") && response.url().includes("page=1"));
    await page.getByRole("button", { name: "Filtruj zadania" }).click();
    assert.equal((await failedOperationsRequest).status(), 503, "panel odbiera kontrolowany błąd niedostępnej listy");
    await page.getByRole("alert").filter({ hasText: "Syntetyczna niedostępność centrum operacyjnego" }).waitFor({ state: "visible" });
    const retriedOperationsRequest = page.waitForResponse((response) => response.url().includes("/api/admin/operations/runs?") && response.url().includes("page=1"));
    await page.getByRole("button", { name: "Filtruj zadania" }).click();
    assert.equal((await retriedOperationsRequest).status(), 200, "po błędzie można ponowić pobranie listy");
    await page.getByRole("navigation", { name: "Strony zadań" }).getByText("Strona 1").waitFor({ state: "visible" });
    await page.getByRole("navigation", { name: "Strony zadań" }).getByRole("button", { name: "Następna" }).click();
    await page.getByRole("navigation", { name: "Strony zadań" }).getByText("Strona 2").waitFor({ state: "visible" });
    assert.ok(pageRequests.includes("operations:2"), "paginacja zadań pobiera drugą stronę z API");
    await page.getByRole("navigation", { name: "Strony zadań" }).getByRole("button", { name: "Poprzednia" }).click();
    await page.getByRole("navigation", { name: "Strony zadań" }).getByText("Strona 1").waitFor({ state: "visible" });
    await page.getByLabel("Filtruj po osobie").selectOption(operatorId);
    await page.getByLabel("Priorytet zgłoszenia").selectOption("high");
    const filterRequest = page.waitForRequest((request) => request.url().includes("/api/admin/interventions?")
      && request.url().includes(`assigneeUserId=${operatorId}`) && request.url().includes("priority=high"));
    await page.getByRole("button", { name: "Filtruj zgłoszenia" }).click();
    await filterRequest;
    assert.ok(reads.some((query) => query.includes(`assigneeUserId=${operatorId}`) && query.includes("priority=high")));
    const assigneeSelect = page.getByLabel(`Przypisana osoba · ${interventionId.slice(0, 8)}`);
    const recipientSearch = page.getByLabel("Szukaj odbiorcy przydziału");
    const recipientSearchResponse = page.waitForResponse((response) => response.url().includes("/api/admin/users?") && response.url().includes("q=member.101"));
    await recipientSearch.fill("member.101");
    await recipientSearchResponse;
    await assigneeSelect.getByRole("option", { name: /operator\.member\.101/ }).waitFor({ state: "attached" });
    await assigneeSelect.selectOption(user101Id);
    assert.equal(await assigneeSelect.inputValue(), user101Id, "wyszukiwanie odbiorcy obejmuje użytkownika poza pierwszą setką");
    const operatorSearchResponse = page.waitForResponse((response) => response.url().includes("/api/admin/users?") && response.url().includes("q=operator.demo"));
    await recipientSearch.fill("operator.demo");
    await operatorSearchResponse;
    await assigneeSelect.selectOption(operatorId);
    assert.equal(await assigneeSelect.inputValue(), operatorId, "wybrany operator pozostaje w kontrolce przydziału");
    const dueAtInput = page.getByLabel(`Termin zgłoszenia · ${interventionId.slice(0, 8)}`);
    assert.equal(await dueAtInput.inputValue(), "2026-10-05T14:00", "UTC jest renderowane jako lokalny czas Warszawy nawet w przeglądarce UTC");
    await page.waitForTimeout(50);
    const interventionRow = page.getByRole("row").filter({ hasText: "33333333" });
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Zgłoszenie zmieniło się" }).waitFor({ state: "visible" });
    assert.equal(await assigneeSelect.inputValue(), operatorId, "konflikt rewizji zachowuje lokalny przydział do świadomego ponowienia");
    assert.equal(await dueAtInput.inputValue(), "2026-10-05T14:00", "konflikt rewizji zachowuje edycję terminu");
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Przydział zapisany" }).waitFor({ state: "visible" });
    const assignment = writes.find((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`));
    assert.equal(assignment?.payload.expectedRevision, 2, "przydział używa rewizji zgłoszenia");
    assert.equal(assignment?.payload.assigneeUserId, operatorId, JSON.stringify(assignment));
    assert.equal(assignment?.payload.dueAt, "2026-10-05T12:00:00.123Z", "zmiana samego przydziału zachowuje dokładny termin ISO wraz z milisekundami");

    await dueAtInput.fill("2026-10-05T15:30");
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Przydział zapisany" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`)).at(-1)?.payload.dueAt, "2026-10-05T13:30:00.000Z", "edytowany termin wysyła moment przeliczony ze strefy Warszawy");

    const assignmentCountBeforeInvalid = writes.filter((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`)).length;
    await dueAtInput.fill("2026-03-29T02:30");
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Ta godzina nie istnieje" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`)).length, assignmentCountBeforeInvalid, "nieistniejąca godzina nie wysyła mutacji");

    await dueAtInput.fill("2026-10-25T02:30");
    const offsetSelect = page.getByLabel(`Offset UTC · ${interventionId.slice(0, 8)}`);
    await offsetSelect.waitFor({ state: "visible" });
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "występuje dwa razy" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`)).length, assignmentCountBeforeInvalid, "niejednoznaczna godzina wymaga wyboru offsetu przed mutacją");
    await offsetSelect.selectOption("2026-10-25T00:30:00.000Z");
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Przydział zapisany" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`)).at(-1)?.payload.dueAt, "2026-10-25T00:30:00.000Z", "wybór wcześniejszego offsetu jesiennej zmiany czasu jest zachowany");

    await dueAtInput.fill("2026-10-25T02:30");
    await page.getByLabel(`Offset UTC · ${interventionId.slice(0, 8)}`).selectOption("2026-10-25T01:30:00.000Z");
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Przydział zapisany" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`)).at(-1)?.payload.dueAt, "2026-10-25T01:30:00.000Z", "wybór późniejszego offsetu jesiennej zmiany czasu jest zachowany");

    await dueAtInput.fill("");
    await interventionRow.getByRole("button", { name: "Zapisz", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Przydział zapisany" }).waitFor({ state: "visible" });
    assert.equal(writes.filter((item) => item.path.endsWith(`/interventions/${interventionId}/assignment`)).at(-1)?.payload.dueAt, null, "wyczyszczenie terminu zapisuje null");

    await page.getByRole("navigation", { name: "Strony zgłoszeń" }).getByRole("button", { name: "Następna" }).click();
    await page.getByRole("navigation", { name: "Strony zgłoszeń" }).getByText("Strona 2").waitFor({ state: "visible" });
    assert.ok(pageRequests.includes("interventions:2"), "paginacja zgłoszeń pobiera drugą stronę z API");
    await page.getByRole("navigation", { name: "Strony zgłoszeń" }).getByRole("button", { name: "Poprzednia" }).click();
    await page.getByRole("navigation", { name: "Strony zgłoszeń" }).getByText("Strona 1").waitFor({ state: "visible" });

    await page.locator("#automation").scrollIntoViewIfNeeded();
    await page.getByLabel("Limit startów na godzinę").fill("4");
    await page.getByRole("button", { name: "Zapisz ustawienia" }).click();
    await page.getByRole("status").filter({ hasText: "Ustawienia automatyzacji zapisane" }).waitFor({ state: "visible" });
    const settingsWrite = writes.find((item) => item.path.endsWith(`/tools/${toolId}/settings`));
    assert.equal(settingsWrite?.payload.maxNewRunsPerHour, 4, JSON.stringify(settingsWrite));
    assert.equal(settingsWrite?.payload.expectedVersion, 2, "ustawienia używają wersji CAS");

    await page.locator("#audit").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Szukaj zdarzeń" }).click();
    await page.getByText("tool.grant.updated").waitFor({ state: "visible" });
    await page.getByRole("navigation", { name: "Sekcje administracji" }).getByRole("link", { name: "Raporty jakości" }).click();
    await page.waitForFunction(() => document.querySelector('.admin-rail nav a[href="#reports"]')?.getAttribute("aria-current") === "location");
    await page.getByRole("button", { name: "Przelicz zakres" }).click();
    await page.getByText("WYGENEROWANE PLIKI").waitFor({ state: "visible" });
    assert.ok(writes.some((item) => item.path === "/api/admin/users" && item.headers["x-csrf-token"] === csrfToken));
    assert.ok(writes.every((item) => item.headers["x-csrf-token"] === csrfToken), "każda administracyjna mutacja przesyła CSRF");
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript w panelu");
    const screenshotDir = resolve(__dirname, "../../../docs/design/goldis/implemented");
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, "admin-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "panel admina nie przewija się poziomo przy 375 px");
    assert.equal(await page.getByText("Przewiń menu w bok, aby zobaczyć wszystkie sekcje.").isVisible(), true, "mobilne menu admina pokazuje podpowiedź przewijania");
    await page.screenshot({ path: resolve(screenshotDir, "admin-mobile.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "panel admina nie przewija się poziomo przy 320 px");
    await page.setViewportSize({ width: 1024, height: 768 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "panel admina nie przewija się poziomo przy 1024 px");
    await page.setViewportSize({ width: 1920, height: 1080 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "panel admina nie przewija się poziomo przy 1920 px");
    console.log("ADMIN_UI_SMOKE_PASS grantsCas=true user101Pagination=true user101SelectionSurvivesMutations=true assigneeSearch=true adminConfirmCancelAndConfirm=true confirmationFocusReturn=true assignmentRevisionConflictRecovery=true warsawTimeRoundTrip=true dueAtClear=true dstGapRejected=true dstBothOffsetsExplicit=true operationsAndInterventionPagination=true service503Recovery=true settingsCas=true auditSearch=true reports=true csrf=true responsive320To1920=true screenshots=true");
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("ADMIN_UI_SMOKE_FAILED", error?.stack ?? error?.message ?? "unknown"); process.exitCode = 1; });
