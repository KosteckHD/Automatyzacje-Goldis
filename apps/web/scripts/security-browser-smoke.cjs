"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "../../..");
const webDir = path.join(root, "apps/web");
const webRequire = createRequire(path.join(webDir, "package.json"));
const workerRequire = createRequire(path.join(root, "apps/worker/package.json"));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SECURITY_BROWSER_PORT_INVALID");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntilReady(child, url, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`SECURITY_BROWSER_SERVER_EXITED:${output.join("\n")}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch { /* Next is still starting. */ }
    await delay(200);
  }
  throw new Error(`SECURITY_BROWSER_SERVER_TIMEOUT:${output.join("\n")}`);
}

async function main() {
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}/`;
  const output = [];
  const nextEntry = webRequire.resolve("next");
  const nextBin = path.resolve(path.dirname(nextEntry), "../bin/next");
  const serverEnv = { ...process.env, API_INTERNAL_URL: "http://127.0.0.1:1", NODE_ENV: "production" };
  for (const key of [
    "DATABASE_URL", "REDIS_URL", "SESSION_SECRET", "LOGIN_RATE_LIMIT_SECRET", "GOLDIS_ADMIN_PASSWORD",
    "WORKER_AUTH_SECRET", "WORKER_STAGING_KEY_V1", "PESEL_ENCRYPTION_KEYS_BASE64", "GUS_BIR_USER_KEY",
  ]) delete serverEnv[key];
  const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: webDir,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  let browser;
  try {
    await waitUntilReady(child, url, output);
    const { chromium } = workerRequire("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cspErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Content Security Policy")) cspErrors.push(message.text());
    });
    let documentHeaders;
    await page.route(url, async (route) => {
      const response = await route.fetch();
      documentHeaders = response.headers();
      const html = (await response.text()).replace("<head>", "<head><script>window.__goldisCspProbe=1</script>");
      await route.fulfill({ response, body: html });
    });
    await page.goto(url);
    await page.waitForTimeout(150);

    let activityProbeHeaders = [];
    await page.route("**/api/security-activity-probe", async (route) => {
      activityProbeHeaders.push(route.request().headers());
      await route.fulfill({ status: 204, body: "" });
    });
    await page.evaluate(() => fetch("/api/security-activity-probe"));
    await page.mouse.click(8, 8);
    await page.evaluate(() => fetch("/api/security-activity-probe"));

    const injected = await page.evaluate(() => window.__goldisCspProbe ?? null);
    const nonce = await page.locator("script[nonce]").first().evaluate((script) => script.nonce);
    const csp = documentHeaders?.["content-security-policy"] ?? "";
    const scriptPolicy = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src ")) ?? "";
    assert.equal(injected, null, "HTML inline script without the response nonce must not execute");
    assert.ok(cspErrors.length > 0, "browser should report the blocked inline script");
    assert.ok(nonce && scriptPolicy.includes(`'nonce-${nonce}'`), "response nonce must match rendered scripts");
    assert.doesNotMatch(scriptPolicy, /'unsafe-inline'|'unsafe-eval'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(documentHeaders?.["cache-control"], "private, no-store");
    assert.equal(documentHeaders?.["x-frame-options"], "DENY");
    assert.equal(documentHeaders?.["x-content-type-options"], "nosniff");
    assert.equal(activityProbeHeaders.length, 2, "both activity probe requests should reach the local fixture");
    assert.equal(activityProbeHeaders[0]["x-goldis-user-activity"], undefined, "background requests must not count as user activity");
    assert.equal(activityProbeHeaders[1]["x-goldis-user-activity"], "1", "a trusted UI interaction should signal recent activity");
    const recoveryToken = "A".repeat(43);
    let resetBody = null;
    await page.route("**/api/auth/reset-password", async (route) => {
      resetBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    const resetResponse = await page.goto(`${url}reset-hasla#token=${recoveryToken}`);
    assert.equal(resetResponse?.headers()["referrer-policy"], "no-referrer");
    assert.equal(resetResponse?.headers()["cache-control"], "private, no-store");
    await page.waitForFunction(() => window.location.hash === "");
    assert.equal(page.url(), `${url}reset-hasla`, "fragment token must be removed from browser history after hydration");
    await page.getByLabel("Nowe hasło", { exact: true }).fill("Synthetic browser recovery password 2026!");
    await page.getByLabel("Powtórz nowe hasło", { exact: true }).fill("Synthetic browser recovery password 2026!");
    await page.getByRole("button", { name: "Ustaw nowe hasło" }).click();
    await page.getByRole("status").waitFor();
    assert.deepEqual(resetBody, { token: recoveryToken, newPassword: "Synthetic browser recovery password 2026!" });
    assert.equal(page.url(), `${url}reset-hasla`, "recovery token must not enter request URL");

    let verifyRequests = 0;
    await page.route("**/api/auth/verify-recovery-email", async (route) => {
      verifyRequests += 1;
      assert.deepEqual(route.request().postDataJSON(), { token: recoveryToken });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    const verifyResponse = await page.goto(`${url}potwierdz-email#token=${recoveryToken}`);
    assert.equal(verifyResponse?.headers()["referrer-policy"], "no-referrer");
    await page.waitForFunction(() => window.location.hash === "");
    await page.waitForTimeout(100);
    assert.equal(verifyRequests, 0, "opening a verification link must not consume it automatically");
    await page.getByRole("button", { name: "Potwierdź adres e-mail" }).click();
    await page.getByRole("status").waitFor();
    assert.equal(verifyRequests, 1, "verification occurs only after an explicit user click");

    const commissionPage = await browser.newPage();
    let scenario = "unavailable";
    const starts = [];
    await commissionPage.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const respond = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (pathname === "/api/auth/me") return scenario === "unauthorized"
        ? respond({ error: "UNAUTHORIZED" }, 401)
        : respond({ csrfToken: "synthetic-browser-csrf", tools: [{ toolId: "commission-comparison", canExecute: true, canDownloadResults: true }] });
      const base = "/api/tools/commission-comparison";
      if (pathname === `${base}/files`) return scenario === "unavailable" ? respond({ error: "SERVICE_UNAVAILABLE" }, 503) : respond({ items: [
        { fileId: "crm", sourceType: "CRM", fileName: "fixture-crm.xlsx", sizeBytes: 100, uploadedAt: "2026-11-01T00:00:00Z" },
        { fileId: "asf", sourceType: "ASF", fileName: "fixture-asf.xlsx", sizeBytes: 100, uploadedAt: "2026-11-01T00:00:00Z" },
      ] });
      if (pathname === `${base}/dictionary/versions`) return respond({ canEdit: false, items: [{ dictionaryVersionId: "v1", versionNumber: 1, status: "published", isActive: true }] });
      if (pathname === `${base}/dictionary/versions/v1`) return respond({ preset: { client_dictionary: { entries: [] } } });
      if (pathname === `${base}/runs` && request.method() === "POST") {
        assert.equal(request.headers()["x-csrf-token"], "synthetic-browser-csrf");
        starts.push(request.postDataJSON());
        return starts.length === 1 ? respond({ error: "SERVICE_UNAVAILABLE" }, 503) : respond({ runId: "fixture-run" }, 201);
      }
      if (pathname === `${base}/runs`) return respond({ items: [] });
      if (pathname === `${base}/runs/fixture-run`) return respond({ run: { runId: "fixture-run", start: "2026-11-01", end: "2026-11-06", status: "completed", counters: {} }, result: null });
      return respond({ items: [] });
    });
    await commissionPage.goto(`${url}tools/commission-comparison`);
    await commissionPage.locator('main [role="alert"]').waitFor();
    assert.equal(await commissionPage.getByRole("link", { name: "Przejdź do logowania" }).count(), 0, "a resource 503 must not turn an authenticated session into a logout");
    scenario = "unauthorized";
    await commissionPage.reload();
    const login = commissionPage.getByRole("link", { name: "Przejdź do logowania" });
    await login.waitFor();
    const loginUrl = new URL(await login.getAttribute("href"), url);
    assert.equal(loginUrl.pathname, "/");
    assert.equal(loginUrl.searchParams.get("returnTo"), "/tools/commission-comparison");
    scenario = "ready";
    await commissionPage.reload();
    await commissionPage.getByRole("checkbox", { name: "Uwzględnij fixture-crm.xlsx" }).check();
    await commissionPage.getByRole("checkbox", { name: "Uwzględnij fixture-asf.xlsx" }).check();
    await commissionPage.getByLabel("Od dnia", { exact: true }).fill("2026-11-01");
    await commissionPage.getByLabel("Do dnia", { exact: true }).fill("2026-11-06");
    await commissionPage.getByRole("button", { name: "Uruchom porównanie" }).click();
    await commissionPage.locator('main [role="alert"]').waitFor();
    await commissionPage.getByRole("button", { name: "Uruchom porównanie" }).click();
    await commissionPage.getByRole("status").filter({ hasText: "Analiza została przyjęta" }).waitFor();
    assert.equal(starts.length, 2);
    assert.ok(starts[0].idempotencyKey);
    assert.equal(starts[0].idempotencyKey, starts[1].idempotencyKey, "retrying the same input must reuse the idempotency key");
    assert.deepEqual(starts[0].fileIds, ["crm", "asf"]);
    await commissionPage.close();
    process.stdout.write("security-browser-smoke: CSP, nonce, no-store, anti-frame, idle activity, recovery handling, commission session errors and idempotent retry verified\n");
  } finally {
    await browser?.close();
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3_000)]);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
