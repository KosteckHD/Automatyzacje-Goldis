const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const toolId = "oc-policy-verification";
const importId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const batchId = importId;
const csrfToken = "synthetic-history-ui-csrf-token-12345678901234567890";
const listRequests = [];
const portProbe = createServer();
let activePage;

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
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      apiRequests.push(path + url.search);
      let body = {};
      if (path === "/api/auth/me") body = {
        role: "admin", username: "admin.demo", csrfToken, mustChangePassword: false,
        tools: [{ toolId, canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }],
      };
      else if (path === "/api/tools") body = { items: [{ toolId, displayName: "Weryfikacja polis OC", description: "Historia i praca z importami OC.", status: "available", access: { toolId, canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true } }] };
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
      else if (path === "/api/runs") body = [];
      else if (path === `/api/imports/${importId}`) body = { id: importId, fileName: "Baza syntetyczna.xlsx", totalRows: 9, invalidRows: 2, readyRows: 7, createdAt: "2026-10-05T12:00:00.000Z" };
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
    await page.getByRole("heading", { name: "Wybierz obszar pracy" }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: /Weryfikacja polis OC/ }).waitFor({ state: "visible" });
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

    await page.goto(`${baseUrl}/results`);
    await page.getByText("Brak polis OC aktualnych na dzień sprawdzenia").waitFor({ state: "visible" });
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
    const screenshotDir = resolve(__dirname, "../../../docs/design/goldis/implemented");
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, "history-mobile.png"), fullPage: true, animations: "disabled" });
    console.log("HISTORY_UI_SMOKE_PASS catalog=true importFilter=true cursorPagination=true browserBack=true directImport=true zeroPolicyResult=true directRun=true responsive375=true screenshots=true");
  } catch (error) {
    if (activePage) {
      const screenshotDir = resolve(__dirname, "../../../docs/design/goldis/implemented");
      mkdirSync(screenshotDir, { recursive: true });
      await activePage.screenshot({ path: resolve(screenshotDir, "history-failure.png"), fullPage: true }).catch(() => undefined);
      console.error("HISTORY_UI_SMOKE_DEBUG", JSON.stringify({ url: activePage.url(), body: await activePage.locator("body").innerText().catch(() => "unavailable") }));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("HISTORY_UI_SMOKE_FAILED", error?.stack ?? error?.message ?? "unknown"); process.exitCode = 1; });
