const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");

const toolId = "oc-policy-verification";
const importId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const batchId = importId;
const csrfToken = "synthetic-history-ui-csrf-token-12345678901234567890";
const listRequests = [];
const portProbe = createServer();
const screenshotDir = resolve(os.tmpdir(), "goldis-history-ui-smoke");
let deletionBlocked = false;
let deletionJobId = null;
const deletionRequests = [];
let activePage;
let smokeDebug = {};

async function freePort() {
  await new Promise((resolveListen, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolveListen); });
  const port = portProbe.address().port;
  await new Promise((resolveClose, reject) => portProbe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForServer(url, process) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { const response = await fetch(url); if (response.ok) return; } catch { /* Wait for the production server. */ }
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    activePage = page;
    const pageErrors = [];
    const apiRequests = [];
    const failedRequests = [];
    smokeDebug = { failedRequests, pageErrors, apiRequests };
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      apiRequests.push(path + url.search);
      let body = {};
      if (path === "/api/auth/me") body = {
        role: "admin", canDeleteData: true, username: "admin.demo", csrfToken, mustChangePassword: false,
        tools: [{ toolId, canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }],
      };
      else if (path === "/api/tools") body = { items: [{ toolId, displayName: "Weryfikacja polis OC", description: "Historia i praca z importami OC.", status: "available", access: { toolId, canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true } }] };
      else if (path === "/api/dashboard") body = { role: "admin", tools: [{ toolId, canExecute: true, canViewResults: true, canDownloadResults: true }],
        metrics: { operations: { total: 0, active: 0, attention: 0, completed: 0 }, myLeads: { total: 0, notContacted: 0, accepted: 0, notInterested: 0 },
          team: { unassigned: 0, assigned: 0, notContacted: 0, accepted: 0, notInterested: 0 } }, operations: [], actionRequired: [], unreadNotifications: 0 };
      else if (path === "/api/imports" && request.method() === "GET") {
        listRequests.push({ type: "imports", query: url.searchParams.toString() });
        const secondPage = url.searchParams.has("cursor");
        body = {
          items: [{ id: secondPage ? "33333333-3333-4333-8333-333333333333" : importId, toolId,
            fileName: secondPage ? "Baza 2.xlsx" : "Baza syntetyczna.xlsx", totalRows: 9, reviewCount: secondPage ? 0 : 2,
            createdAt: "2026-10-05T12:00:00.000Z", ownerLabel: "operator.demo" }],
          nextCursor: secondPage ? null : "cursor-import-2",
        };
      }
      else if (path === "/api/history/runs") {
        listRequests.push({ type: "runs", query: url.searchParams.toString() });
        body = { items: [], nextCursor: null };
      }
      else if (path === "/api/history/results") {
        listRequests.push({ type: "results", query: url.searchParams.toString() });
        body = { items: [{ id: runId, batchId, rowNumber: 18001, toolId, status: "no_matching_policies", referenceDate: "2026-10-05", errorCode: null,
          createdAt: "2026-10-05T12:00:00.000Z", policyCounts: { totalOcCount: 4, currentOcCount: 0 }, artifactAvailable: false }], nextCursor: null };
      }
      else if (path === "/api/deletions/preview" && request.method() === "POST") {
        const input = request.postDataJSON();
        deletionRequests.push({ type: "preview", input });
        assert.deepEqual(input, { targetType: "run", targetId: runId });
        body = { previewId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-10-09T14:00:00.000Z", targetType: "run", targetId: runId,
          requiresStepUp: true, summary: { counts: { sourceRows: 1, runs: 1, submissions: 0, artifacts: 0, files: 0, activeRuns: 0, sharedRunReferences: 0,
            activeOutbox: 0, stagedFiles: 0, pendingArtifacts: 0 }, blockers: deletionBlocked ? ["RUN_ACTIVE"] : [] } };
      }
      else if (path === "/api/auth/deletion-step-up" && request.method() === "POST") {
        const input = request.postDataJSON();
        deletionRequests.push({ type: "step-up", input });
        assert.equal(input.currentPassword, "Synthetic current password!");
        assert.equal(input.previewId, "44444444-4444-4444-8444-444444444444");
        body = { stepUpToken: "55555555-5555-4555-8555-555555555555.synthetic-token-secret-that-is-long-enough-to-test", expiresAt: "2026-10-09T14:04:00.000Z" };
      }
      else if (path === "/api/deletions/jobs" && request.method() === "POST") {
        const input = request.postDataJSON();
        deletionRequests.push({ type: "create", input });
        assert.equal(input.previewId, "44444444-4444-4444-8444-444444444444");
        assert.match(input.idempotencyKey, /^web-[0-9a-f-]{36}$/i);
        assert.match(request.headers()["x-csrf-token"] ?? "", /synthetic-history-ui/);
        deletionJobId = "66666666-6666-4666-8666-666666666666";
        body = { jobId: deletionJobId, targetType: "run", targetId: runId, status: "queued", version: 1, attemptCount: 0,
          fileCount: 0, filesRemoved: 0, errorCode: null, createdAt: "2026-10-09T13:59:00.000Z", updatedAt: "2026-10-09T13:59:00.000Z", finishedAt: null };
      }
      else if (path === `/api/deletions/jobs/${deletionJobId}`) {
        deletionRequests.push({ type: "poll" });
        body = { jobId: deletionJobId, targetType: "run", targetId: runId, status: "completed", version: 3, attemptCount: 1,
          fileCount: 0, filesRemoved: 0, errorCode: null, createdAt: "2026-10-09T13:59:00.000Z", updatedAt: "2026-10-09T13:59:02.000Z", finishedAt: "2026-10-09T13:59:02.000Z" };
      }
      else if (path === "/api/runs") body = [];
      else if (path === `/api/imports/${importId}`) body = { id: importId, fileName: "Baza syntetyczna.xlsx", totalRows: 9, invalidRows: 2, readyRows: 7, createdAt: "2026-10-05T12:00:00.000Z" };
      else if (path === `/api/imports/${importId}/preparations`) body = { preparations: [] };
      else if (path === `/api/imports/${importId}/preparation-workflows`) body = { workflows: [] };
      else if (path === `/api/imports/${importId}/enrichment`) body = { page: 1, pageSize: 50, totalRows: 9,
        summary: { missingRegonRows: 0, pendingCorrectionRows: 0, openConflictRows: 0, lookupStatuses: {} }, rows: [] };
      else if (path === `/api/imports/${batchId}/rows` || path === `/api/imports/${batchId}/rows?page=1&state=all`) body = [];
      else if (path === `/api/runs/${runId}`) body = {
        id: runId, batchId, rowNumber: 18001, toolId, status: "no_matching_policies", currentStep: "no_matching_policies",
        referenceDate: "2026-10-05", errorCode: null, manualDataVersion: 0, createdAt: "2026-10-05T12:00:00.000Z",
        policyCounts: { totalOcCount: 4, currentOcCount: 0 }, artifactAvailable: false, events: [], incident: null,
      };
      else if (path === "/api/interventions/summary") body = { openCount: 0, unreadCount: 0, smsCount: 0 };
      else if (path === "/api/interventions") body = { items: [], nextCursor: null };
      else if (path === "/api/health/automation") body = { automationReady: false, servicesReady: true, worker: "offline", portalMode: "off", portalConfig: "valid", message: "Test syntetyczny" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.goto(baseUrl);
    await page.waitForURL("**/dashboard");
    await page.getByRole("heading", { name: "Przegląd" }).waitFor({ state: "visible" });
    await page.goto(`${baseUrl}/tools`);
    await page.getByRole("heading", { name: "Automatyzacje" }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Otwórz narzędzie" }).waitFor({ state: "visible" });
    await page.goto(`${baseUrl}/imports`);
    await page.getByText("Baza syntetyczna.xlsx").waitFor({ state: "visible" });
    await page.getByLabel("Stan danych").selectOption("needs_review");
    await page.getByRole("button", { name: "Zastosuj filtry" }).click();
    await page.waitForFunction(() => new URLSearchParams(location.search).get("dataState") === "needs_review");
    await page.getByText("2 do przeglądu").waitFor({ state: "visible" });
    assert.ok(listRequests.some((entry) => entry.type === "imports" && entry.query.includes("dataState=needs_review")));

    await page.getByRole("button", { name: "Następna strona" }).click();
    await page.getByText("Baza 2.xlsx").waitFor({ state: "visible" });
    await page.waitForFunction(() => new URLSearchParams(location.search).has("cursor"));
    await page.getByRole("button", { name: "Poprzednia strona" }).click();
    await page.getByText("Baza syntetyczna.xlsx").waitFor({ state: "visible" });
    await page.goBack();
    await page.goBack();
    await page.goBack();
    await page.waitForFunction(() => !new URLSearchParams(location.search).has("dataState"));
    await page.getByLabel("Stan danych").selectOption("all");
    await page.goto(`${baseUrl}/imports/${importId}`);
    await page.waitForURL("**/tools/oc-policy-verification?import=*");
    await page.waitForTimeout(1200);
    await page.getByRole("heading", { name: "Przegląd bazy" }).waitFor({ state: "visible", timeout: 5000 });

    await page.goto(`${baseUrl}/results/history`);
    await page.getByText("Brak polis OC aktualnych na dzień sprawdzenia").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Przygotuj usunięcie wyniku" }).click();
    const deletionDialog = page.getByRole("dialog", { name: "Usuń wynik zadania" });
    await deletionDialog.getByText("Import źródłowy Excel pozostanie w systemie", { exact: false }).waitFor({ state: "visible" });
    await deletionDialog.getByLabel("Potwierdź swoje obecne hasło").fill("Synthetic current password!");
    await deletionDialog.getByRole("button", { name: "Potwierdź i zleć usunięcie" }).click();
    await deletionDialog.getByText("Wynik usunięty").waitFor({ state: "visible" });
    assert.deepEqual(deletionRequests.map((entry) => entry.type), ["preview", "step-up", "create", "poll"]);

    deletionBlocked = true;
    await page.reload();
    await page.goto(`${baseUrl}/results/history`);
    await page.getByRole("button", { name: "Przygotuj usunięcie wyniku" }).click();
    const blockedDialog = page.getByRole("dialog", { name: "Usuń wynik zadania" });
    await blockedDialog.getByText("Zadanie nadal działa.").waitFor({ state: "visible" });
    assert.equal(await blockedDialog.getByRole("button", { name: "Potwierdź i zleć usunięcie" }).isDisabled(), true,
      "blokada uniemożliwia utworzenie zlecenia");
    assert.equal(deletionRequests.filter((entry) => entry.type === "create").length, 1);
    await blockedDialog.getByRole("button", { name: "Zamknij podgląd" }).click();

    await page.getByRole("link", { name: "Otwórz wynik" }).click();
    await page.waitForURL(`**/tools/oc-policy-verification?run=${runId}`);
    await page.getByRole("heading", { name: "Wiersz 18001: Brak aktualnych polis OC" }).waitFor({ state: "visible", timeout: 5000 });
    assert.ok(listRequests.some((entry) => entry.type === "results"));
    assert.ok(listRequests.some((entry) => entry.type === "results" && entry.query.includes("limit=50")));
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript w katalogu i historiach");

    await page.goto(`${baseUrl}/runs`);
    await page.getByRole("heading", { name: "Historia zadań" }).waitFor({ state: "visible" });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "historia nie przewija poziomo przy 375 px");
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, "history-mobile.png"), fullPage: true, animations: "disabled" });
    console.log("HISTORY_UI_SMOKE_PASS catalog=true importFilter=true cursorPagination=true browserBack=true directImport=true zeroPolicyResult=true deletionPreviewStepUpJobPoll=true staleBlockerPreventsJob=true directRun=true responsive375=true screenshots=temp");
  } catch (error) {
    if (activePage) {
      mkdirSync(screenshotDir, { recursive: true });
      await activePage.screenshot({ path: resolve(screenshotDir, "history-failure.png"), fullPage: true }).catch(() => undefined);
      console.error("HISTORY_UI_SMOKE_DEBUG", JSON.stringify({ url: activePage.url(), body: await activePage.locator("body").innerText().catch(() => "unavailable"), ...smokeDebug }));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("HISTORY_UI_SMOKE_FAILED", error?.stack ?? error?.message ?? "unknown"); process.exitCode = 1; });
