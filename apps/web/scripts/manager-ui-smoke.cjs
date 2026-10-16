const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const userId = "11111111-1111-4111-8111-111111111111";
const csrfToken = "synthetic-csrf-token-for-manager-ui-smoke-1234567890";
const probe = createServer();

async function port() {
  await new Promise((listen, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", listen); });
  const value = probe.address().port;
  await new Promise((close, reject) => probe.close((error) => error ? reject(error) : close()));
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

async function confirmCurrentPassword(page) {
  const dialog = page.getByRole("dialog", { name: "Potwierdź swoją tożsamość" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByLabel("Obecne hasło").fill("Synthetic-Current-Password-2026!");
  await dialog.getByRole("button", { name: "Potwierdź i wykonaj" }).click();
}

async function main() {
  const listenPort = await port();
  const base = `http://127.0.0.1:${listenPort}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(listenPort)], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, NODE_ENV: "production", PORT: String(listenPort) },
  });
  let browser;
  try {
    await waitForServer(base, server);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    let role = "manager";
    const calls = [];
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/^\/api/, "");
      const json = async (payload, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
      if (path === "/admin/privileged-confirmations" && request.method() === "POST") return json({ token: "77777777-7777-4777-8777-777777777777.synthetic-step-up-token-123456789012345678901234567890123" });
      if (path === "/auth/me") return json({ username: "manager", role, csrfToken, mustChangePassword: false });
      if (path === "/tools") return json({ items: [{ toolId: "oc-policy-verification", displayName: "Weryfikacja polis OC", description: "Sprawdź polisy OC firm z importu.", status: "available", access: { canExecute: role !== "operator", canViewResults: true, canDownloadResults: true } }] });
      if (path === "/imports") return json({ items: [], nextCursor: null });
      if (path === "/team/users") return role === "manager" || role === "admin"
        ? json({ items: [{ userId, username: "anna.nowak", status: "active", membershipStatus: "active", createdAt: "2026-10-01T10:00:00.000Z", lastLoginAt: "2026-10-10T10:00:00.000Z", activeSessionCount: 1, leadCount: 12, canExecuteOc: false }] })
        : json({ message: "Forbidden" }, 403);
      if (path === `/team/users/${userId}/access` && request.method() === "GET") return json({ userId, toolId: "oc-policy-verification", toolName: "Weryfikacja OC", canExecute: false, version: 0, resultsShared: true, canDownloadResults: true });
      if (path === `/team/users/${userId}/access` && request.method() === "PUT") {
        calls.push({ method: "PUT", path, body: request.postDataJSON() });
        return json({ userId, toolId: "oc-policy-verification", canExecute: request.postDataJSON().canExecute, version: 1 });
      }
      if (path === "/contact-reports/overview") return json({ period: { from: url.searchParams.get("from"), to: url.searchParams.get("to"), basis: "lead_created_at", description: "Okres wybiera leady utworzone w tym czasie; statusy pokazują ich bieżący stan, a nie historię połączeń." }, resultSetId: null, summary: { total: 21, unassigned: 4, assigned: 17, notContacted: 10, accepted: 5, notInterested: 2 }, employees: [{ userId, username: "anna.nowak", membershipStatus: "active", assigned: 12, notContacted: 6, accepted: 4, notInterested: 2 }] });
      if (path === "/admin/reports/overview") return json({ counts: { created: 8, completed: 6, noPolicies: 1, failed: 1, openInterventions: 2, generated: 6 }, completionRate: 0.75, durationSeconds: { median: 120, p90: 240 }, medianResolvedInterventionSeconds: 30 });
      return json({ message: `Unexpected API path ${path}` }, 404);
    });

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/team`);
    await page.getByRole("heading", { name: "Pracownicy", exact: true }).waitFor();
    await page.getByText("anna.nowak", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Zarządzaj" }).click();
    await page.getByRole("button", { name: "Wyłącz konto" }).waitFor();
    await page.getByLabel("Nowe hasło tymczasowe").waitFor();

    await page.goto(`${base}/access`);
    await page.getByRole("heading", { name: "Dostępy do narzędzi" }).waitFor();
    await page.locator(".access-switch").click();
    await confirmCurrentPassword(page);
    await page.getByRole("status").filter({ hasText: "Zapisano uprawnienie uruchamiania" }).waitFor();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.canExecute, true);
    assert.equal(calls[0].body.expectedVersion, 0);
    assert.ok(calls[0].body.confirmationToken && calls[0].body.idempotencyKey);

    await page.goto(`${base}/reports`);
    await page.getByRole("heading", { name: "Wyniki kontaktu" }).waitFor();
    await page.getByText("Zainteresowani", { exact: true }).waitFor();
    await page.getByText("anna.nowak", { exact: true }).waitFor();
    await page.getByText("Brak pasujących polis", { exact: true }).waitFor();

    await page.goto(`${base}/tools`);
    await page.getByRole("heading", { name: "Automatyzacje", exact: true }).waitFor();
    await page.getByRole("link", { name: /Otwórz narzędzie/ }).waitFor();

    await page.goto(`${base}/imports`);
    await page.getByRole("heading", { name: "Historia importów", exact: true }).waitFor();
    await page.locator(".lead-sidebar").waitFor();
    assert.equal(await page.locator(".lead-sidebar").count(), 1, "legacy imports route should use the shared sidebar once");
    await page.locator(".legacy-topbar").waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/imports`);
    await page.getByRole("heading", { name: "Historia importów", exact: true }).waitFor();
    await page.getByRole("button", { name: "Otwórz menu nawigacji" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Otwórz menu nawigacji" }).count(), 1, "legacy mobile route should have one menu trigger");
    await page.goto(`${base}/access`);
    await page.getByRole("button", { name: "Otwórz menu nawigacji" }).click();
    await page.getByRole("dialog", { name: "Nawigacja" }).waitFor();
    assert.equal(await page.locator("html").evaluate((element) => element.scrollWidth <= window.innerWidth), true, "mobile page should not overflow horizontally");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Nawigacja" }).waitFor({ state: "detached" });

    role = "operator";
    await page.goto(`${base}/tools`);
    await page.getByRole("heading", { name: "Automatyzacje", exact: true }).waitFor();
    await page.getByRole("link", { name: /Przeglądaj wyniki/ }).waitFor();
    await page.goto(`${base}/team`);
    await page.getByRole("heading", { name: "Ta sekcja jest dostępna dla menedżera" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Utwórz konto" }).count(), 0);
    assert.deepEqual(errors, []);
    console.log("manager-ui-smoke: passed manager pages, tool catalog permissions, access mutation, reports, mobile drawer and employee denial");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
