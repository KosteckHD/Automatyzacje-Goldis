"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const resultSetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const alternateResultSetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const managerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const employeeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const csrfToken = "synthetic-lead-ui-csrf-token-123456789012345";
const probe = createServer();

async function freePort() {
  await new Promise((resolveListen, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolveListen); });
  const value = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return value;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { if ((await fetch(url)).ok) return; } catch { /* Next.js is starting. */ }
    await new Promise((delay) => setTimeout(delay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

function lead(index, assignedToUserId = null) {
  const digit = String((index % 9) + 1);
  return {
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`, resultSetId, automationId: "oc-policy-verification",
    operationId: `operation-${index}`, sourceImportId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sourceRowIds: [],
    createdAt: "2026-10-11T10:00:00.000Z", referenceDate: "2026-10-11", company: `Firma testowa ${index}`,
    nip: `${digit.repeat(10)}`, regon: `${digit.repeat(9)}`, address: "Testowa 1", postalCode: "00-001", city: "Warszawa",
    decisionMakers: [], contacts: [], resultStatus: "ready", contactStatus: "not_contacted", contactStatusVersion: 1,
    contactStatusUpdatedAt: null, assignedToUserId, assignedTo: assignedToUserId ? "operator.demo" : null,
    assignedByUserId: assignedToUserId ? managerId : null, assignedAt: assignedToUserId ? "2026-10-11T11:00:00.000Z" : null,
    runCount: 1, policyCount: 0, runs: [], canEditContactStatus: Boolean(assignedToUserId),
  };
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  });
  let browser;
  try {
    await waitForServer(base, server);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const pageErrors = [];
    const apiCalls = [];
    const allocationRequests = [];
    const summaryScopes = [];
    let role = "manager";
    let availableCount = 80;
    let alternateAvailableCount = 40;
    let poolConflictOnce = false;
    let noRecipients = false;
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });
      apiCalls.push({ path: url.pathname, method: request.method(), role });
      if (url.pathname === "/api/auth/me") return json({ role, username: `${role}.demo`, userId: role === "manager" ? managerId : employeeId, tenantId, csrfToken, mustChangePassword: false });
      if (url.pathname === "/api/notifications") return json({ items: [], unreadCount: 0, nextCursor: null });
      if (url.pathname === "/api/leads/recipients") return role === "manager" || role === "admin"
        ? json({ items: noRecipients ? [] : [{ userId: employeeId, name: "operator.demo", role: "operator" }, { userId: managerId, name: "manager.demo", role: "manager" }] })
        : json({ message: "Forbidden" }, 403);
      if (url.pathname === "/api/leads/allocation-summary") {
        const scope = url.searchParams.get("resultSetId");
        summaryScopes.push(scope);
        return role === "manager" || role === "admin"
          ? json({ availableCount: scope === alternateResultSetId ? alternateAvailableCount : availableCount, resultSetId: scope, checkedAt: "2026-10-12T08:00:00.000Z" })
          : json({ message: "Forbidden" }, 403);
      }
      if (url.pathname === "/api/leads" && request.method() === "GET") {
        const items = Array.from({ length: 25 }, (_, index) => lead(index + 1, url.searchParams.get("scope") === "mine" ? employeeId : null));
        return json({ items, nextCursor: null });
      }
      if (url.pathname === "/api/leads/allocations" && request.method() === "POST") {
        const body = request.postDataJSON();
        allocationRequests.push(body);
        assert.equal(request.headers()["x-csrf-token"], csrfToken, "allocation POST includes the CSRF token");
        if (allocationRequests.length === 1) {
          availableCount -= body.count;
          return route.abort("failed");
        }
        if (poolConflictOnce) {
          poolConflictOnce = false;
          alternateAvailableCount = 39;
          return json({ code: "LEAD_POOL_CHANGED", availableCount: alternateAvailableCount, message: "Inny menedżer zmienił pulę." }, 409);
        }
        return json({ allocationId: "allocation-synthetic-01", recipientUserId: body.recipientUserId, count: body.count, replayed: true });
      }
      if (url.pathname === "/api/review/my-corrections") return json({ items: [], nextCursor: null, hasMore: false, limit: 50 });
      return json({ message: `Unexpected API path ${url.pathname}` }, 404);
    });

    await page.goto(`${base}/results/oc-policy-verification?resultSetId=${resultSetId}`);
    await page.getByRole("heading", { name: "Wyniki automatyzacji OC" }).waitFor({ state: "visible" });
    await page.getByText("Dostępne do przydziału: 80", { exact: false }).waitFor({ state: "visible" });
    await page.getByText("25 na stronie", { exact: true }).waitFor({ state: "visible" });
    await page.getByLabel("Odbiorca").selectOption(employeeId);
    await page.getByLabel("Liczba leadów").fill("81");
    assert.equal(await page.getByRole("button", { name: "Sprawdź przydział" }).isDisabled(), true,
      "a request larger than total availability cannot be reviewed");
    assert.equal(allocationRequests.length, 0, "invalid counts do not write an allocation");
    await page.getByLabel("Liczba leadów").fill("3");
    await page.getByRole("button", { name: "Sprawdź przydział" }).click();
    await page.getByRole("group", { name: "Podsumowanie przydziału" }).waitFor({ state: "visible" });
    await page.getByText("Zestaw wyników AAAAAAAA", { exact: true }).waitFor({ state: "visible" });
    assert.equal(allocationRequests.length, 0, "opening the summary does not allocate leads");
    await page.getByRole("button", { name: "Wróć do edycji" }).click();
    await page.getByLabel("Liczba leadów").fill("3");
    await page.getByRole("button", { name: "Sprawdź przydział" }).click();
    await page.getByRole("button", { name: "Potwierdź przydział" }).click();
    await page.locator(".lead-allocation").getByRole("alert").waitFor({ state: "visible" });
    assert.equal(allocationRequests.length, 1, "first confirmed request is sent once");
    assert.deepEqual(allocationRequests[0], { recipientUserId: employeeId, count: 3, resultSetId, idempotencyKey: allocationRequests[0].idempotencyKey });
    assert.ok(allocationRequests[0].idempotencyKey.length >= 16);

    const summaryReadsBeforeScopeChange = summaryScopes.length;
    await page.goto(`${base}/results/oc-policy-verification?resultSetId=${alternateResultSetId}`);
    await page.getByRole("group", { name: "Podsumowanie przydziału" }).waitFor({ state: "visible" });
    await page.getByText("Zestaw wyników AAAAAAAA", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Do rozstrzygnięcia pozostaje operacja w zakresie Zestaw wyników AAAAAAAA.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(summaryScopes.length, summaryReadsBeforeScopeChange, "an unresolved allocation blocks a new scope and its availability read");
    await page.getByRole("button", { name: "Sprawdź ponownie tę samą operację" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Sprawdź ponownie tę samą operację" }).click();
    await page.getByRole("status").getByText(/Przydzielono 3 leady odbiorcy operator\.demo\. Numer przydziału: allocation-synthetic-01/).waitFor({ state: "visible" });
    assert.equal(allocationRequests.length, 2, "an uncertain result can be resolved by a replay");
    assert.deepEqual(allocationRequests[1], allocationRequests[0], "retry uses the same scope, recipient, count and idempotency key");
    await page.getByText("Dostępne do przydziału: 40", { exact: false }).waitFor({ state: "visible" });
    assert.ok(summaryScopes.slice(0, summaryReadsBeforeScopeChange).every((scope) => scope === resultSetId), "the original allocation preview stays scoped to its result set");
    assert.ok(summaryScopes.includes(alternateResultSetId), "the new scope is checked only after the previous operation is resolved");

    poolConflictOnce = true;
    await page.getByLabel("Liczba leadów").fill("2");
    await page.getByRole("button", { name: "Sprawdź przydział" }).click();
    await page.getByRole("button", { name: "Potwierdź przydział" }).click();
    await page.locator(".lead-allocation").getByRole("alert").getByText(/Inny menedżer zmienił pulę/).waitFor({ state: "visible" });
    await page.getByText("Dostępne do przydziału: 39", { exact: false }).waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("Liczba leadów").inputValue(), "2", "pool conflict preserves the user's requested count");
    assert.equal(allocationRequests.length, 3, "a pool conflict is reported without silently submitting another allocation");
    await page.getByRole("button", { name: "Sprawdź przydział" }).click();
    await page.getByRole("group", { name: "Podsumowanie przydziału" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Wróć do edycji" }).click();
    assert.equal(allocationRequests.length, 3, "returning from a refreshed preview still does not write an allocation");

    role = "operator";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/my-results`);
    await page.getByRole("heading", { name: "Moje wyniki" }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".lead-allocation").count(), 0, "operator never sees the assignment form");
    await page.getByRole("button", { name: "Otwórz menu nawigacji" }).click();
    await page.getByRole("dialog", { name: "Nawigacja" }).getByRole("link", { name: "Moje korekty" }).click();
    await page.getByRole("heading", { name: "Moje propozycje korekt" }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".admin-rail").count(), 0, "the review route keeps the shared shell on mobile");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "mobile review route has no horizontal page overflow");
    assert.equal(apiCalls.some((call) => call.path === "/api/leads/allocation-summary" && call.method === "GET" && call.role === "operator"), false,
      "operator never requests manager-only pool availability");
    role = "manager";
    alternateAvailableCount = 0;
    noRecipients = true;
    await page.goto(`${base}/results/oc-policy-verification?resultSetId=${alternateResultSetId}`);
    await page.getByText("W tym zakresie nie ma teraz wolnych leadów.").waitFor({ state: "visible" });
    await page.getByText("Brak aktywnych pracowników lub menedżerów do przydziału.").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Sprawdź przydział" }).isDisabled(), true,
      "empty pool and absent recipients block the review step");
    assert.equal(allocationRequests.length, 3, "empty state never mutates the allocation pool");
    assert.ok(summaryScopes.every((scope) => scope === resultSetId || scope === alternateResultSetId), "each availability read stays within the selected result set");
    assert.deepEqual(pageErrors, [], "no browser runtime errors");
    console.log("lead-ui-smoke: passed scoped availability, preview without mutation, uncertain-response replay, role navigation and mobile layout; API fixtures are synthetic");
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolveExit) => server.once("exit", resolveExit));
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
