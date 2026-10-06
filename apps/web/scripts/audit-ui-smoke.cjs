const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

let activePage;
let role = "reviewer";
const auditRequests = [];
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
    try { const response = await fetch(url); if (response.ok) return; } catch { /* Wait for server startup. */ }
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
    page.setDefaultTimeout(7000);
    const pageErrors = [];
    const requestUrls = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => requestUrls.push(request.url()));
    page.on("console", (message) => { if (message.type() === "error") console.error("AUDIT_UI_CONSOLE", message.text()); });
    page.on("requestfailed", (request) => console.error("AUDIT_UI_REQUEST_FAILED", request.url(), request.failure()?.errorText));
    page.on("response", (response) => { if (response.status() >= 400) console.error("AUDIT_UI_HTTP", response.status(), response.url()); });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let body = {};
      if (url.pathname === "/api/auth/me") body = { role, username: `${role}.demo`, csrfToken: "synthetic-audit-csrf-token", mustChangePassword: false, tools: [] };
      else if (url.pathname === "/api/audit/events") {
        auditRequests.push(url.searchParams.toString());
        body = url.searchParams.has("cursor")
          ? { items: [{ eventId: "77777777-7777-4777-8777-777777777777", actorUsername: "operator.demo", action: "import.created", resourceType: "import", resourceId: "99999999-9999-4999-8999-999999999998", outcome: "succeeded", createdAt: "2026-10-01T08:00:00.000Z" }], nextCursor: null }
          : { items: [{ eventId: "66666666-6666-4666-8666-666666666666", actorUsername: "reviewer.demo", action: "run.created", resourceType: "run", resourceId: "88888888-8888-4888-8888-888888888888", outcome: "succeeded", createdAt: "2026-10-02T08:00:00.000Z" }], nextCursor: "synthetic-next-cursor" };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.goto(baseUrl);
    await page.getByRole("link", { name: "Audyt", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Audyt", exact: true }).click();
    await page.getByRole("heading", { name: "Dziennik audytu" }).waitFor({ state: "visible" });
    await page.locator(".audit-event-main code").filter({ hasText: "run.created" }).waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("Czynność").locator("option[value='user.created']").count(), 0, "reviewer nie dostaje filtrów administracyjnych");
    assert.equal(await page.getByLabel("Aktor ID").count(), 0, "reviewer nie dostaje filtra aktora");
    assert.equal(await page.getByLabel("Rodzaj zasobu").locator("option[value='settings']").count(), 0, "reviewer nie dostaje kategorii ustawień");

    const initialAuditRequestCount = auditRequests.length;
    await page.getByLabel("Od dnia (Warszawa)").fill("2026-10-01");
    await page.getByLabel("Do dnia (Warszawa)").fill("2026-10-03");
    await page.getByLabel("Czynność").selectOption("run.created");
    await page.getByLabel("Rodzaj zasobu").selectOption("run");
    await page.waitForTimeout(100);
    assert.equal(auditRequests.length, initialAuditRequestCount, "draft filtrów nie wykonuje zapytań przed submit");
    const filteredResponse = page.waitForResponse((response) => response.url().includes("/api/audit/events") && response.url().includes("action=run.created"));
    await page.getByRole("button", { name: "Szukaj zdarzeń" }).click();
    await filteredResponse;
    await page.waitForFunction(() => new URLSearchParams(location.search).get("fromDay") === "2026-10-01");
    await page.waitForFunction(() => [...document.querySelectorAll("time")].some((node) => node.dateTime === "2026-10-02T08:00:00.000Z"));
    const filtered = new URLSearchParams(auditRequests.at(-1));
    assert.equal(filtered.get("from"), "2026-09-30T22:00:00.000Z");
    assert.equal(filtered.get("to"), "2026-10-03T22:00:00.000Z");
    assert.equal(filtered.get("action"), "run.created");
    assert.equal(filtered.get("resourceType"), "run");

    await page.getByRole("button", { name: "Starsze" }).click();
    await page.waitForFunction(() => new URLSearchParams(location.search).has("cursor"));
    await page.locator(".audit-event-main code").filter({ hasText: "import.created" }).waitFor({ state: "visible" });
    await page.goBack();
    await page.locator(".audit-event-main code").filter({ hasText: "run.created" }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !new URLSearchParams(location.search).has("cursor"));

    role = "auditor";
    await page.goto(baseUrl);
    await page.getByRole("link", { name: "Audyt", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Audyt", exact: true }).click();
    await page.getByRole("heading", { name: "Dziennik audytu" }).waitFor({ state: "visible" });
    await page.getByLabel("Czynność").locator("option[value='user.created']").waitFor({ state: "attached" });
    assert.equal(await page.getByLabel("Aktor ID").count(), 1, "auditor ma pełne filtry dziennika");
    assert.equal(await page.getByRole("link", { name: "Importy", exact: true }).count(), 0, "auditor nie widzi historii operacyjnych w menu");

    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "dziennik nie przewija poziomo przy 375 px");
    const screenshotDir = resolve(__dirname, "../../../docs/design/goldis/implemented");
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, "audit-mobile.png"), fullPage: true, animations: "disabled" });

    role = "operator";
    const beforeOperator = auditRequests.length;
    await page.goto(baseUrl);
    assert.equal(await page.getByRole("link", { name: "Audyt", exact: true }).count(), 0, "operator nie otrzymuje linku do audytu");
    await page.goto(`${baseUrl}/audit`);
    await page.getByText("Twoja rola nie ma dostępu do dziennika audytu.").waitFor({ state: "visible" });
    await page.waitForTimeout(100);
    assert.equal(auditRequests.length, beforeOperator, "operator nie wysyła zapytania do endpointu audytu");
    assert.equal(await page.getByRole("link", { name: "Audyt", exact: true }).count(), 0, "operator nie widzi linku do audytu na stronie odmowy");

    assert.ok(requestUrls.every((url) => new URL(url).origin === baseUrl), "żądania smoke nie wychodzą poza testowy host");
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript");
    console.log("AUDIT_UI_SMOKE_PASS navigationRoles=true reviewerFilters=true warsawDateRange=true cursorPagination=true browserBack=true auditorFilters=true operatorDenied=true responsive375=true noExternalRequests=true screenshots=true");
  } catch (error) {
    if (activePage) {
      const screenshotDir = resolve(__dirname, "../../../docs/design/goldis/implemented");
      mkdirSync(screenshotDir, { recursive: true });
      await activePage.screenshot({ path: resolve(screenshotDir, "audit-failure.png"), fullPage: true }).catch(() => undefined);
      console.error("AUDIT_UI_SMOKE_DEBUG", JSON.stringify({ url: activePage.url(), body: await activePage.locator("body").innerText().catch(() => "unavailable") }));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("AUDIT_UI_SMOKE_FAILED", error?.stack ?? error?.message ?? "unknown"); process.exitCode = 1; });
