const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const batchId = "33333333-3333-4333-8333-333333333333";
const runId = "22222222-2222-4222-8222-222222222222";
const csrfToken = "synthetic-tool-grants-csrf-token-123456789";
const portProbe = createServer();

async function freePort() {
  await new Promise((resolveListen, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolveListen); });
  const port = portProbe.address().port;
  await new Promise((resolveClose, reject) => portProbe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForServer(url, server) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { if ((await fetch(url)).ok) return; } catch { /* Retry while Next.js starts. */ }
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    const externalRequests = [];
    const calls = [];
    let mode = "none";
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.origin !== baseUrl) externalRequests.push(url.origin); });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      calls.push({ path, method });
      let body = {};
      let status = 200;
      const access = mode === "execute"
        ? { toolId: "oc-policy-verification", canDiscover: true, canExecute: true, canViewResults: false, canDownloadResults: false }
        : mode === "view"
          ? { toolId: "oc-policy-verification", canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: false }
          : null;
      if (path === "/api/auth/me") { body = { role: "operator", username: "synthetic.operator", csrfToken, tools: access ? [access] : [] }; if (mode === "login") status = 401; }
      else if (path === "/api/auth/login" && method === "POST") { status = 401; body = { message: "Niepoprawne dane logowania" }; }
      else if (path === "/api/auth/logout" && method === "POST") body = { ok: true };
      else if (path === "/api/health/automation") body = { automationReady: false, servicesReady: false, worker: "offline", portalMode: "off", portalConfig: "valid", message: "Tryb testowy" };
      else if (path === "/api/interventions/summary") body = { openCount: 0, unreadCount: 0, smsCount: 0 };
      else if (path === "/api/interventions") body = { items: [], nextCursor: null };
      else if (path === `/api/imports/${batchId}`) body = { id: batchId, totalRows: 1, invalidRows: 0, readyRows: 1, sha256: "a".repeat(64) };
      else if (path === `/api/imports/${batchId}/rows`) body = [{ rowNumber: 2, companyName: "Transport Test sp. z o.o.", decisionMakerName: "Anna Testowa", regon: "123456789", issues: [] }];
      else if (path === `/api/imports/${batchId}/enrichment`) body = { page: 1, pageSize: 50, totalRows: 0, summary: { missingRegonRows: 0, pendingCorrectionRows: 0, openConflictRows: 0, lookupStatuses: {} }, rows: [] };
      else if (path === "/api/imports" && method === "POST") body = { id: batchId, totalRows: 1, invalidRows: 0, readyRows: 1, sha256: "b".repeat(64) };
      else if (path === "/api/runs" && method === "GET") body = mode === "view" ? [{ id: runId, rowNumber: 18001, status: "completed", currentStep: "completed", referenceDate: "2026-10-01", errorCode: null, createdAt: "2026-10-02T08:00:00.000Z", artifactAvailable: true }] : [];
      else if (path === `/api/runs/${runId}`) body = { id: runId, rowNumber: 18001, status: "completed", currentStep: "completed", referenceDate: "2026-10-01", errorCode: null, createdAt: "2026-10-02T08:00:00.000Z", artifactAvailable: true, events: [] };
      else { body = { message: "Unexpected synthetic request" }; status = 404; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store" } });
    });

    const screenshotDir = resolve(__dirname, "../../../docs/design/goldis/implemented");
    mkdirSync(screenshotDir, { recursive: true });
    mode = "login";
    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "Zaloguj się" }).waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(screenshotDir, "login-desktop.png"), fullPage: true, animations: "disabled" });
    await page.getByLabel("Użytkownik").fill("synthetic.operator");
    await page.getByLabel("Hasło").fill("synthetic-only-password");
    await page.getByRole("button", { name: "Przejdź do panelu" }).click();
    await page.getByRole("alert").filter({ hasText: "Sprawdź login i hasło" }).waitFor({ state: "visible" });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "ekran logowania nie przewija się poziomo przy 375 px");
    await page.screenshot({ path: resolve(screenshotDir, "login-mobile.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "ekran logowania nie przewija się poziomo przy 320 px");
    await page.setViewportSize({ width: 1440, height: 1000 });

    calls.length = 0;
    mode = "none";
    await page.goto(`${baseUrl}/tools/oc-policy-verification?import=${batchId}`);
    await page.getByRole("heading", { name: "Brak dostępu do narzędzia" }).waitFor({ state: "visible" });
    assert.equal(calls.some((item) => item.path.startsWith(`/api/imports/${batchId}`)), false, "brak grantu odkrywania nie pobiera importu po URL");
    assert.deepEqual(calls.map((item) => item.path), ["/api/auth/me"], "bez grantu nie są pobierane dane operacyjne");

    mode = "execute";
    calls.length = 0;
    await page.goto(`${baseUrl}/tools/oc-policy-verification`);
    await page.locator(".upload-card").waitFor({ state: "visible" });
    assert.equal(await page.locator("#workspace-result").count(), 0, "wykonanie bez odczytu nie pokazuje wyników");
    await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("synthetic-only") });
    await page.getByRole("button", { name: "Sprawdź i zaimportuj" }).click();
    await page.getByRole("heading", { name: "Kontrola pojedynczego wiersza" }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#workspace-runs form").count(), 1, "grant wykonania pokazuje uruchamianie");
    assert.equal(await page.locator(".run-list, .run-detail, .enrichment-section, .download-link").count(), 0, "grant wykonania nie pokazuje historii, danych ani plików");
    assert.equal(calls.some((item) => item.path.startsWith(`/api/imports/${batchId}/rows`)), false, "wykonanie bez odczytu nie pobiera wierszy");

    mode = "view";
    await page.goto(`${baseUrl}/tools/oc-policy-verification?import=${batchId}`);
    await page.locator("#workspace-result .table-note").waitFor({ state: "visible" });
    assert.equal(await page.locator("#workspace-runs form").count(), 0, "grant odczytu bez wykonania ukrywa start zadania");
    await page.getByRole("button", { name: /Wiersz 18001/ }).click();
    await page.getByRole("heading", { name: /Wiersz 18001: Zakończono/ }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".download-link").count(), 0, "grant odczytu bez pobierania ukrywa artefakt");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: resolve(screenshotDir, "workspace-desktop.png"), fullPage: true, animations: "disabled" });

    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "dokument nie przewija się poziomo przy 375 px");
    await page.screenshot({ path: resolve(screenshotDir, "workspace-mobile.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "dokument nie przewija się poziomo przy 320 px");
    await page.setViewportSize({ width: 375, height: 812 });
    const menuToggle = page.getByRole("button", { name: "Otwórz menu nawigacji" });
    await menuToggle.click();
    const drawer = page.getByRole("dialog", { name: "Nawigacja" });
    await drawer.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.closest(".mobile-nav-drawer") !== null);
    assert.equal(await drawer.evaluate((node) => node.contains(document.activeElement)), true, "otwarcie menu przenosi fokus do dialogu");
    await page.screenshot({ path: resolve(screenshotDir, "workspace-mobile-menu.png"), animations: "disabled" });
    await drawer.getByRole("button", { name: "Zamknij menu nawigacji" }).focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await drawer.getByRole("button", { name: "Wyloguj" }).evaluate((node) => node === document.activeElement), true, "fokus zapętla się wewnątrz menu");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("mobile-menu-toggle"));
    assert.equal(await menuToggle.getAttribute("aria-expanded"), "false", "Escape zamyka menu");
    assert.equal(await menuToggle.evaluate((node) => node === document.activeElement), true, "zamknięcie menu przywraca fokus do przycisku");
    await menuToggle.click();
    await page.getByRole("dialog", { name: "Nawigacja" }).getByRole("link", { name: "Wyniki", exact: true }).click();
    assert.equal(new URL(page.url()).hash, "#workspace-result", "wybór nawigacji przechodzi do wybranej sekcji");
    await page.waitForFunction(() => document.activeElement?.id === "workspace-result");
    assert.equal(await page.locator("#workspace-result").evaluate((node) => node === document.activeElement), true, "po zamknięciu menu fokus przechodzi na cel nawigacji");
    await page.setViewportSize({ width: 768, height: 900 });
    assert.equal(await menuToggle.isVisible(), true, "drawer pozostaje dostępny na tablecie");
    await page.setViewportSize({ width: 1024, height: 768 });
    assert.equal(await menuToggle.isVisible(), false, "szeroki widok pokazuje nawigację boczną");
    assert.equal(await page.getByRole("navigation", { name: "Główna nawigacja" }).first().isVisible(), true, "nawigacja desktopowa pozostaje widoczna");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "dokument nie przewija się poziomo przy 1024 px");
    await page.setViewportSize({ width: 1920, height: 1080 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "dokument nie przewija się poziomo przy 1920 px");
    await page.setViewportSize({ width: 375, height: 812 });
    await menuToggle.click();
    await page.getByRole("dialog", { name: "Nawigacja" }).getByRole("button", { name: "Wyloguj" }).click();
    await page.getByRole("heading", { name: "Zaloguj się" }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.body.style.overflow), "", "wylogowanie z menu zwalnia blokadę scrolla");
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript");
    assert.deepEqual(externalRequests, [], "fonty i zasoby UI nie ładują się z zewnętrznej domeny");
    console.log("TOOL_GRANTS_UI_SMOKE_PASS discovery=true executeOnly=true viewOnly=true downloadSeparate=true mobileDrawer=true focusTrap=true mobileLogout=true responsive320To1920=true noExternalRequests=true screenshots=true syntheticOnly=true");
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("TOOL_GRANTS_UI_SMOKE_FAILED", error?.stack ?? error?.message ?? "unknown"); process.exitCode = 1; });
