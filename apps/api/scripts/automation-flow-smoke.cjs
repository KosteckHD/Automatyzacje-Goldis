const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { createServer: createProbeServer } = require("node:net");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

async function availableLoopbackPort() {
  const probe = createProbeServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const value = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return value;
}

async function waitForNext(url, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("REAL_API_NEXT_SERVER_EXITED");
    try { if ((await fetch(url)).ok) return; } catch { /* Next.js is starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("REAL_API_NEXT_SERVER_TIMEOUT");
}

/** Real API, guards, outbox, BullMQ, production processor, browser adapters and exporter. */
module.exports = async function automationFlowSmoke() {
  if (process.env.GOLDIS_TEST_REDIS_DISPOSABLE !== "1") throw new Error("AUTOMATION_DISPOSABLE_REDIS_REQUIRED");
  const redisUrl = new URL(process.env.REDIS_URL ?? "");
  if (redisUrl.protocol !== "redis:" || !["127.0.0.1", "localhost"].includes(redisUrl.hostname)) throw new Error("AUTOMATION_LOCAL_REDIS_REQUIRED");
  const webPort = await availableLoopbackPort();
  const webOrigin = `http://localhost:${webPort}`;
  const { Pool } = require("pg"); const { Worker, Queue } = require("bullmq");
  const { createHttpApplication } = require("../dist/infrastructure/http/index");
  const models = require("../dist/infrastructure/database/db"); const { hashPassword } = require("../dist/features/auth/index");
  const { BrowserSession } = require("../../worker/dist/infrastructure/browser/browser");
  const { OneTimeCodeInbox, startWorkerCodeReceiver } = require("../../worker/dist/features/authentication/code-inbox");
  const { LiveRunProcessor } = require("../../worker/dist/features/execution/live-run");
  const { WorkerResultForwarder } = require("../../worker/dist/features/results/result-forwarder");
  const { WorkerResultStagingStore } = require("../../worker/dist/infrastructure/staging/result-staging");
  const { createProductionRunProcessor } = require("../../worker/dist/run-worker");
  const root = await mkdtemp(join(tmpdir(), "goldis-automation-flow-"));
  const password = `Synthetic-only-${randomBytes(20).toString("hex")}!`;
  const overrides = {
    SESSION_SECRET: randomBytes(32).toString("hex"), WORKER_AUTH_SECRET: randomBytes(32).toString("hex"),
    LOGIN_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1", PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": randomBytes(32).toString("base64") })).toString("base64"),
    ARTIFACT_REQUIRE_ENCRYPTION: "1", ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    ARTIFACT_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": randomBytes(32).toString("base64") })).toString("base64"),
    WORKER_STAGING_DIR: join(root, "staging"), WORKER_STAGING_KEY_VERSION: "1", WORKER_STAGING_KEY_V1: randomBytes(32).toString("base64url"),
    API_EXPORT_DIR: join(root, "exports"), NODE_ENV: "development", PUBLIC_APP_ORIGIN: webOrigin,
    GOLDIS_ADMIN_USER: "Synthetic.Flow.Admin", GOLDIS_ADMIN_PASSWORD: password, PZU_LOGIN: "synthetic-pzu-user", COMPENSA_LOGIN: "synthetic-compensa-user",
  };
  const envKeys = [...Object.keys(overrides), "PUBLIC_APP_ORIGIN", "WORKER_INTERNAL_URL", "WORKER_RESULT_API_URL"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])); Object.assign(process.env, overrides);
  const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), db: Number(redisUrl.pathname.slice(1) || 0), maxRetriesPerRequest: null };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const inbox = new OneTimeCodeInbox();
  const shutdown = new AbortController();
  let app, receiver, worker, queue, browser, webServer, webBrowser, webPage;
  let currentScenario = "authenticated";
  let observedSmsSubmissions = 0;
  let observedResends = 0;
  const counts = { starts: 0, saves: 0, ufg: 0 };
  const failures = [];
  pool.on("connect", (client) => {
    const query = client.query.bind(client);
    client.query = (...args) => {
      if (typeof args[args.length - 1] === "function") return query(...args);
      return query(...args).catch((error) => {
        console.error("AUTOMATION_FIXTURE_SQL_FAILURE", error.code, String(args[0]).replace(/\s+/g, " ").slice(0, 110));
        throw error;
      });
    };
  });
  const session = { authenticated: '[data-screen="home"]', loginForm: '[data-screen="login"]', usernameInput: '[name="username"]',
    passwordInput: '[name="password"]', loginSubmit: '[data-login]', smsChallenge: '[data-screen="sms"]', smsCodeInput: '[name="code"]',
    smsCodeSubmit: '[data-submit-sms]', smsRememberDevice: '#remember', smsResendCode: '#resend', smsCodeExpired: '#expired', smsCodeRejected: '#rejected', accessDenied: '[data-screen="denied"]' };
  const config = {
    pzu: { entryUrl: "https://pzu-fixture.test/everest", allowedOrigins: ["https://pzu-fixture.test"], session, adapterVersion: "e2e-v1",
      everest: { searchInput: '#search', resultRows: '#results tr', noResults: '#empty', optionalOverlay: { container: '#ad', dismissButton: '[data-dismiss]' },
        fields: { accountType: '.kind', personName: '.person', pesel: '.pesel' } } },
    compensa: { entryUrl: "https://compensa-fixture.test/home", allowedOrigins: ["https://compensa-fixture.test"], session,
      registrationNumber: "RST22339", adapterVersion: "e2e-v1", parserVersion: "e2e-v1",
      form: { communicationTile: '#compensa-communication-tile', startDialog: '#start-dialog', identifierInput: '[name="insuredIdentifier"]',
        registrationInput: '[name="vehicleRegistration"]', startCommunication: '#start-communication', insuredDataSection: '#insured-data', roleSelect: '[name="role"]',
        firstNameInput: '[name="firstName"]', lastNameInput: '[name="lastName"]', peselInput: '[name="pesel"]', postalCodeInput: '[name="postalCode"]', countyInput: '[name="county"]', saveButton: '#save-insured' },
      save: { insuredDataSection: '#insured-data', caseReference: '#offer-reference', saveButton: '#save-insured', savedConfirmation: '#saved-confirmation' },
      ufg: { caseReference: '#offer-reference', verifyUfgButton: '#verify-ufg', summaryTable: '#ufg-summary', openUfgSummary: '#open-ufg-summary' } },
  };
  const home = (empty) => `<main data-screen="home">Synthetic Everest</main><div id="ad"><button data-dismiss onclick="document.querySelector('#ad').remove()">Close known ad</button></div>
    <input id="search" onkeydown="if(event.key!=='Enter')return;setTimeout(()=>{document.querySelector('#results').innerHTML=${empty ? "''" : "'<tr><td class=kind>Osoba fizyczna</td><td class=person>Ala Testowa Synthetic Company</td><td class=pesel>90010100016</td></tr>'"};document.querySelector('#empty').hidden=${!empty};},150)">
    <div id="empty" hidden>No results</div><table><tbody id="results"></tbody></table>`;
  let compensaHtml = await readFile(resolve(__dirname, "../../worker/src/testing/fixtures/compensa-portal.html"), "utf8");
  // Reflect the user's required choice of role in the start dialog, before the search.
  compensaHtml = compensaHtml.replace('<select name="role">', '<select name="formRole">').replace('<h2>Compensa Komunikacja</h2>', '<h2>Compensa Komunikacja</h2><select name="role"><option>Właściciel</option><option>Ubezpieczający</option></select>');
  async function waitUntil(probe, description, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await probe(); if (result) return result; if (failures.length) throw new Error(`AUTOMATION_WORKER_FAILURE_${failures[0]}`); await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`AUTOMATION_TIMEOUT_${description}`);
  }
  try {
    // This database is disposable. Prevent old migration fixtures from entering this flow.
    await models.AutomationRun.update({ status: "cancelled", currentStep: "cancelled" }, { where: {} });
    await models.RunDispatchOutbox.update({ status: "cancelled" }, { where: {} });
    await models.AuthChallenge.update({ status: "invalidated" }, { where: {} });
    const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
    const now = new Date(); const userId = randomUUID();
    const operatorUserId = randomUUID();
    const operatorUsername = "Synthetic.Flow.Operator";
    const operatorPassword = `Synthetic-operator-${randomBytes(20).toString("hex")}!`;
    const additionalRoleAccounts = [];
    await models.User.create({ userId, username: overrides.GOLDIS_ADMIN_USER, usernameNormalized: overrides.GOLDIS_ADMIN_USER.toLowerCase(),
      passwordHash: await hashPassword(password), status: "active", mustChangePassword: false, createdAt: now, updatedAt: now });
    await models.TenantMembership.create({ userId, tenantId: tenant.tenantId, role: "admin", status: "active", createdAt: now, updatedAt: now });
    await models.User.create({ userId: operatorUserId, username: operatorUsername, usernameNormalized: operatorUsername.toLowerCase(),
      passwordHash: await hashPassword(operatorPassword), status: "active", mustChangePassword: false, createdAt: now, updatedAt: now });
    await models.TenantMembership.create({ userId: operatorUserId, tenantId: tenant.tenantId, role: "operator", status: "active", createdAt: now, updatedAt: now });
    for (const role of ["manager", "reviewer", "auditor"]) {
      const account = { role, username: `Synthetic.Flow.${role}`, password: `Synthetic-${role}-${randomBytes(20).toString("hex")}!` };
      const accountUserId = randomUUID();
      await models.User.create({ userId: accountUserId, username: account.username, usernameNormalized: account.username.toLowerCase(),
        passwordHash: await hashPassword(account.password), status: "active", mustChangePassword: false, createdAt: now, updatedAt: now });
      await models.TenantMembership.create({ userId: accountUserId, tenantId: tenant.tenantId, role, status: "active", createdAt: now, updatedAt: now });
      account.userId = accountUserId;
      if (role === "reviewer") {
        await models.ToolGrant.create({ tenantId: tenant.tenantId, toolId: "oc-policy-verification", userId: accountUserId,
          canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: true, grantedBy: userId,
          createdAt: now, updatedAt: now, version: 1 });
      }
      additionalRoleAccounts.push(account);
    }
    await models.Tool.update({ status: "available" }, { where: { toolId: "oc-policy-verification" } });
    await models.ToolSettings.update({ enabledForNewRuns: true, allowedLocalStart: null, allowedLocalEnd: null, maxNewRunsPerHour: null }, { where: { tenantId: tenant.tenantId, toolId: "oc-policy-verification" } });
    receiver = await startWorkerCodeReceiver({ host: "127.0.0.1", port: 0, serviceSecret: process.env.WORKER_AUTH_SECRET, inbox });
    process.env.WORKER_INTERNAL_URL = `http://127.0.0.1:${receiver.address.port}`;
    const { AppModule } = require("../dist/composition/module");
    app = await createHttpApplication(AppModule, { logger: false, abortOnError: false }); await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl(); process.env.WORKER_RESULT_API_URL = origin;
    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { origin: webOrigin, "content-type": "application/json" }, body: JSON.stringify({ username: overrides.GOLDIS_ADMIN_USER, password }) });
    assert.equal(login.status, 201);
    const sessionBody = await login.json(); const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const headers = { cookie, origin: webOrigin, "x-csrf-token": sessionBody.csrfToken, "content-type": "application/json" };
    browser = new BrowserSession({ profileDirectory: join(root, "profile") });
    const live = new LiveRunProcessor({
      pool, browser, inbox, config,
      resultForwarder: new WorkerResultForwarder(process.env),
      staging: new WorkerResultStagingStore(process.env),
      environment: process.env,
    });
    const context = await browser.open();
    await context.exposeBinding("fixtureSmsSubmitted", () => { observedSmsSubmissions++; });
    await context.exposeBinding("fixtureResend", () => { observedResends++; });
    await context.exposeBinding("fixtureAction", (_source, action) => { if (action in counts) counts[action]++; });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "pzu-fixture.test") {
        let html = home(currentScenario === "not_found");
        if (currentScenario.startsWith("sms")) html = `<main data-screen="sms"><input name="code"><input id="remember" type="checkbox"><span id="expired" hidden>Expired</span><span id="rejected" hidden>Invalid code</span><button id="resend" hidden onclick="window.fixtureResend();document.querySelector('#expired').hidden=true;document.querySelector('#rejected').hidden=true;this.hidden=true">Resend once</button><button data-submit-sms onclick="window.fixtureSmsSubmitted();if(document.querySelector('[name=code]').value==='000000'){document.querySelector('#rejected').hidden=false;document.querySelector('#resend').hidden=false;return;}window.wasRemembered=document.querySelector('#remember').checked;document.body.innerHTML=${JSON.stringify(home(false)).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Submit</button></main>`;
        return route.fulfill({ status: 200, contentType: "text/html", body: html });
      }
      if (url.hostname === "compensa-fixture.test") {
        const tracking = `<script>document.querySelector('#start-communication').addEventListener('click',()=>window.fixtureAction('starts'));document.querySelector('#save-insured').addEventListener('click',()=>window.fixtureAction('saves'));document.querySelector('#verify-ufg').addEventListener('click',()=>window.fixtureAction('ufg'));</script>`;
        return route.fulfill({ status: 200, contentType: "text/html", body: compensaHtml + tracking });
      }
      await route.abort();
    });
    worker = new Worker("oc-verification", createProductionRunProcessor(pool, live, browser.sessionId, undefined, shutdown.signal), { connection, concurrency: 1 });
    worker.on("error", () => failures.push("QUEUE")); worker.on("failed", (_job, error) => {
      failures.push(/^[A-Z][A-Z0-9_:-]+$/.test(error?.message ?? "") ? error.message : "JOB");
    });
    queue = new Queue("oc-verification", { connection }); await worker.waitUntilReady();
    const webRoot = resolve(__dirname, "../../web");
    const webRequire = createRequire(resolve(webRoot, "package.json"));
    const workerRequire = createRequire(resolve(__dirname, "../../worker/package.json"));
    const nextBin = webRequire.resolve("next/dist/bin/next");
    const nextOutput = [];
    webServer = spawn(process.execPath, [nextBin, "dev", "-p", String(webPort)], {
      cwd: webRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, API_INTERNAL_URL: origin, NEXT_TELEMETRY_DISABLED: "1", PORT: String(webPort) },
    });
    for (const stream of [webServer.stdout, webServer.stderr]) stream.on("data", (chunk) => {
      nextOutput.push(String(chunk));
      if (nextOutput.join("").length > 12_000) nextOutput.splice(0, nextOutput.length - 1);
    });
    await waitForNext(webOrigin, webServer);
    const { chromium: uiChromium } = workerRequire("playwright");
    webBrowser = await uiChromium.launch({ headless: true });
    const uiContext = await webBrowser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
    webPage = await uiContext.newPage();
    const uiErrors = [];
    const uiExternalRequests = [];
    const uiApiResponses = [];
    webPage.on("pageerror", (error) => uiErrors.push(error.message));
    webPage.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (!["127.0.0.1", "localhost"].includes(requestUrl.hostname)) uiExternalRequests.push(requestUrl.origin);
    });
    webPage.on("response", (response) => {
      const responseUrl = new URL(response.url());
      if (responseUrl.pathname.startsWith("/api/")) uiApiResponses.push({ path: responseUrl.pathname, method: response.request().method(), status: response.status() });
    });
    currentScenario = "sms";
    for (const portal of ["pzu", "compensa"]) await (await browser.page(portal)).goto(config[portal].entryUrl);
    await webPage.goto(webOrigin, { waitUntil: "domcontentloaded" });
    try {
      await webPage.getByRole("heading", { name: "Zaloguj się" }).waitFor({ timeout: 30_000 });
    } catch (error) {
      console.error("REAL_API_UI_LOGIN_SCREEN", JSON.stringify({
        url: webPage.url(),
        title: await webPage.title().catch(() => ""),
        body: (await webPage.locator("body").innerText().catch(() => "")).slice(0, 1_500),
        apiResponses: uiApiResponses,
        pageErrors: uiErrors,
        nextOutput: nextOutput.join("").slice(-8_000),
      }));
      throw error;
    }
    await webPage.getByLabel("Użytkownik").fill(overrides.GOLDIS_ADMIN_USER);
    await webPage.getByLabel("Hasło").fill(password);
    const uiLoginPromise = webPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/login", { timeout: 30_000 });
    await webPage.getByRole("button", { name: "Przejdź do panelu" }).click();
    const uiLoginResponse = await uiLoginPromise;
    assert.equal(uiLoginResponse.status(), 201, "real UI login should use the API");
    await webPage.waitForURL((url) => url.pathname === "/dashboard", { timeout: 30_000 });
    await webPage.goto(`${webOrigin}/tools/oc-policy-verification`, { waitUntil: "domcontentloaded" });
    await webPage.getByRole("heading", { name: "Weryfikacja danych transportowych" }).waitFor({ timeout: 30_000 });
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Realizacja");
    worksheet.addRow(["Nazwa", "REGON", "Osoba Decyzyjna", "Adres", "Kod Pocztowy", "Miasto", "Komórka", "Telefon", "Email"]);
    worksheet.addRow(["Synthetic Company", "123456785", "Ala Testowa", "Synthetic 1", "00-000", "Synthetic", "600000000", "600000000", "synthetic@example.test"]);
    const workbookBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const uploadResponsePromise = webPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/imports"
      && response.request().method() === "POST", { timeout: 30_000 });
    await webPage.locator('input[type="file"]').setInputFiles({
      name: `browser-flow-${randomUUID()}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbookBuffer,
    });
    await webPage.getByRole("button", { name: "Sprawdź i zaimportuj" }).click();
    const uploadResponse = await uploadResponsePromise;
    if (uploadResponse.status() !== 201) throw new Error(`REAL_UI_UPLOAD_FAILED_${uploadResponse.status()}_${await uploadResponse.text()}`);
    const imported = await uploadResponse.json();
    assert.equal(imported.totalRows, 1);
    await webPage.locator("#workspace-result").waitFor({ timeout: 30_000 });
    const preparationResponsePromise = webPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/imports/${imported.id}/preparations`
      && response.request().method() === "POST", { timeout: 30_000 });
    await webPage.getByRole("button", { name: "Sprawdź i przygotuj import" }).click();
    const preparationResponse = await preparationResponsePromise;
    if (preparationResponse.status() !== 201) throw new Error(`REAL_UI_PREPARATION_FAILED_${preparationResponse.status()}_${await preparationResponse.text()}`);
    const preparation = await preparationResponse.json();
    await webPage.getByText("Ta rewizja jest zamknięta.", { exact: false }).waitFor({ timeout: 60_000 });
    const uiRunResponsePromise = webPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs"
      && response.request().method() === "POST", { timeout: 30_000 });
    await webPage.getByLabel("Numer wiersza w Excelu").fill("2");
    await webPage.getByRole("button", { name: "Sprawdź gotowość wiersza" }).click();
    const uiRunResponse = await uiRunResponsePromise;
    if (uiRunResponse.status() !== 201) throw new Error(`REAL_UI_RUN_FAILED_${uiRunResponse.status()}_${await uiRunResponse.text()}`);
    const uiRun = await uiRunResponse.json();
    await webPage.getByRole("button", { name: "Wpisz kod SMS dla wiersza 2" }).waitFor({ timeout: 60_000 });
    await webPage.getByRole("button", { name: "Wpisz kod SMS dla wiersza 2" }).click();
    const smsDialog = webPage.getByRole("dialog", { name: "Wprowadź kod SMS" });
    await smsDialog.getByLabel("Kod weryfikacyjny").fill("654321");
    const uiSmsResponsePromise = webPage.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/auth-challenges/")
      && new URL(response.url()).pathname.endsWith("/code") && response.request().method() === "POST", { timeout: 30_000 });
    await smsDialog.getByRole("button", { name: "Przekaż kod" }).click();
    const uiSmsResponse = await uiSmsResponsePromise;
    assert.equal(uiSmsResponse.status(), 202, "real UI SMS handoff should reach the API");
    await webPage.getByRole("heading", { name: /Wiersz 2: Zakończono/ }).waitFor({ timeout: 120_000 });
    const downloadPromise = webPage.waitForEvent("download", { timeout: 30_000 });
    await webPage.getByRole("link", { name: "Pobierz wynik Excel" }).click();
    const uiDownload = await downloadPromise;
    const downloadedPath = await uiDownload.path();
    assert.ok(downloadedPath && uiDownload.suggestedFilename().toLowerCase().endsWith(".xlsx"), "real UI should download the completed workbook");
    const downloadedWorkbook = new ExcelJS.Workbook();
    await downloadedWorkbook.xlsx.load(await readFile(downloadedPath));
    assert.ok(downloadedWorkbook.worksheets.length > 0, "download should be a readable Excel workbook");
    await webPage.getByRole("link", { name: "Administracja" }).click();
    await webPage.getByRole("heading", { name: /Dostęp i jakość pracy/ }).waitFor({ timeout: 30_000 });
    await webPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/operations/summary" && response.status() === 200, { timeout: 30_000 });
    await webPage.goto(`${webOrigin}/tools/oc-policy-verification?import=${imported.id}`, { waitUntil: "domcontentloaded" });
    const uiLogoutStatus = await webPage.evaluate(async () => {
      const meResponse = await fetch("/api/auth/me", { credentials: "same-origin" });
      const me = await meResponse.json();
      const response = await fetch("/api/auth/logout", {
        method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": me.csrfToken },
      });
      return response.status;
    });
    assert.equal(uiLogoutStatus, 201);
    await webPage.getByRole("heading", { name: "Zaloguj się" }).waitFor({ timeout: 30_000 });
    const uiUnauthStatus = await webPage.evaluate(async () => (await fetch("/api/admin/users")).status);
    assert.equal(uiUnauthStatus, 401, "real UI logout must invalidate API access");
    currentScenario = "browser-role-boundary";
    await webPage.getByLabel("Użytkownik").fill(operatorUsername);
    await webPage.getByLabel("Hasło").fill(operatorPassword);
    const operatorLoginPromise = webPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/login", { timeout: 30_000 });
    await webPage.getByRole("button", { name: "Przejdź do panelu" }).click();
    const operatorLoginResponse = await operatorLoginPromise;
    assert.equal(operatorLoginResponse.status(), 201, "real UI should authenticate the synthetic operator");
    await webPage.locator(".topbar-user").filter({ hasText: "Operator" }).waitFor({ state: "attached", timeout: 30_000 });
    const operatorSession = await webPage.evaluate(async () => (await (await fetch("/api/auth/me", { credentials: "same-origin" })).json()));
    assert.equal(operatorSession.role, "operator", "real UI session should carry the operator role");
    assert.equal(await webPage.getByRole("link", { name: "Administracja" }).count(), 0,
      "operator navigation must not expose the admin link");
    assert.equal(await webPage.getByRole("link", { name: "Audyt" }).count(), 0,
      "operator navigation must not expose audit reserved for elevated roles");
    const operatorAdminStatus = await webPage.evaluate(async () => (await fetch("/api/admin/operations/summary")).status);
    assert.equal(operatorAdminStatus, 403, "operator must be denied admin API access");
    const auditRange = { from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const operatorAuditStatus = await webPage.evaluate(async ({ from, to }) => {
      const query = new URLSearchParams({ from, to, limit: "50" });
      return (await fetch(`/api/audit/events?${query}`, { credentials: "same-origin" })).status;
    }, auditRange);
    assert.equal(operatorAuditStatus, 403, "operator must be denied audit API access");
    const operatorMutationName = `Synthetic.Flow.Denied.operator.${randomUUID()}`;
    const operatorMutationStatus = await webPage.evaluate(async ({ csrfToken, username, password, idempotencyKey }) => (await fetch("/api/admin/users", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ username, password, role: "operator", confirmationToken: null, idempotencyKey }),
    })).status, { csrfToken: operatorSession.csrfToken, username: operatorMutationName, password: `Synthetic-denied-${randomBytes(20).toString("hex")}!`, idempotencyKey: randomUUID() });
    assert.equal(operatorMutationStatus, 403, "operator must be denied admin mutations");
    assert.equal(await models.User.findOne({ where: { usernameNormalized: operatorMutationName.toLowerCase() } }), null,
      "denied operator mutation must not create a user");
    const operatorRunsBefore = await models.AutomationRun.count({ where: { batchId: imported.id } });
    const operatorRunCreateStatus = await webPage.evaluate(async ({ csrfToken, batchId }) => (await fetch("/api/runs", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ batchId, rowNumber: 2 }),
    })).status, { csrfToken: operatorSession.csrfToken, batchId: imported.id });
    assert.equal(operatorRunCreateStatus, 404, "operator must not learn about or start a run on an import it does not own");
    assert.equal(await models.AutomationRun.count({ where: { batchId: imported.id } }), operatorRunsBefore,
      "denied operator run creation must not persist a run");
    await webPage.goto(`${webOrigin}/admin`, { waitUntil: "domcontentloaded" });
    await webPage.getByRole("heading", { name: "Brak dostępu" }).waitFor({ timeout: 30_000 });
    await webPage.getByRole("alert").filter({ hasText: "Ta strona jest dostępna wyłącznie dla administratora." }).waitFor({ timeout: 30_000 });
    const roleBoundaryResults = ["operator"];
    const roleAuditResults = ["operator:403"];
    const roleRunResults = ["operator:404"];
    await webPage.goto(`${webOrigin}/audit`, { waitUntil: "domcontentloaded" });
    await webPage.getByRole("heading", { name: "Dziennik audytu" }).waitFor({ timeout: 30_000 });
    await webPage.getByRole("alert").filter({ hasText: "Twoja rola nie ma dostępu do dziennika audytu." }).waitFor({ timeout: 30_000 });
    const roleLabels = { manager: "Menedżer", reviewer: "Recenzent", auditor: "Audytor" };
    for (const account of additionalRoleAccounts) {
      const uiRoleLogoutStatus = await webPage.evaluate(async () => {
        const me = await (await fetch("/api/auth/me", { credentials: "same-origin" })).json();
        return (await fetch("/api/auth/logout", {
          method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": me.csrfToken },
        })).status;
      });
      assert.equal(uiRoleLogoutStatus, 201);
      await webPage.goto(webOrigin, { waitUntil: "domcontentloaded" });
      await webPage.getByRole("heading", { name: "Zaloguj się" }).waitFor({ timeout: 30_000 });
      await webPage.getByLabel("Użytkownik").fill(account.username);
      await webPage.getByLabel("Hasło").fill(account.password);
      const roleLoginPromise = webPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/login", { timeout: 30_000 });
      await webPage.getByRole("button", { name: "Przejdź do panelu" }).click();
      const roleLoginResponse = await roleLoginPromise;
      assert.equal(roleLoginResponse.status(), 201, `real UI should authenticate ${account.role}`);
      await webPage.locator(".lead-role-pill").filter({ hasText: roleLabels[account.role] }).first().waitFor({ state: "attached", timeout: 30_000 });
      const roleSession = await webPage.evaluate(async () => (await (await fetch("/api/auth/me", { credentials: "same-origin" })).json()));
      assert.equal(roleSession.role, account.role, `real UI session should carry the ${account.role} role`);
      assert.equal(await webPage.getByRole("link", { name: "Administracja" }).count(), 0,
        `${account.role} navigation must not expose the admin link`);
      assert.ok(await webPage.getByRole("link", { name: "Dziennik aktywności" }).count() >= 1,
        `${account.role} navigation should expose its permitted audit link`);
      const auditResponsePromise = webPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/audit/events", { timeout: 30_000 });
      await webPage.getByRole("link", { name: "Dziennik aktywności" }).first().click();
      await webPage.getByRole("heading", { name: "Dziennik audytu" }).waitFor({ timeout: 30_000 });
      const auditResponse = await auditResponsePromise;
      assert.equal(auditResponse.status(), 200, `${account.role} must be allowed to read audit events`);
      const auditPayload = await auditResponse.json();
      assert.ok(Array.isArray(auditPayload.items), `${account.role} audit response should contain a safe item list`);
      if (account.role === "reviewer") {
        assert.equal(auditPayload.items.some((event) => event.action === "run.created" && event.resourceType === "run"), true,
          "reviewer should see an audited run from a tool with an active result grant");
        assert.equal(auditPayload.items.some((event) => event.action === "user.created" || event.resourceType === "user"), false,
          "reviewer must not see administrator account changes");
      }
      roleAuditResults.push(`${account.role}:${auditResponse.status()}`);
      const runsBefore = await models.AutomationRun.count({ where: { batchId: imported.id } });
      const runCreateStatus = await webPage.evaluate(async ({ csrfToken, batchId }) => (await fetch("/api/runs", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ batchId, rowNumber: 2 }),
      })).status, { csrfToken: roleSession.csrfToken, batchId: imported.id });
      const expectedRunStatus = account.role === "manager" ? 404 : 403;
      assert.equal(runCreateStatus, expectedRunStatus, `${account.role} without run permission or execution grant must not start an admin import`);
      assert.equal(await models.AutomationRun.count({ where: { batchId: imported.id } }), runsBefore,
        `denied ${account.role} run creation must not persist a run`);
      roleRunResults.push(`${account.role}:${runCreateStatus}`);
      const roleAdminStatus = await webPage.evaluate(async () => (await fetch("/api/admin/operations/summary")).status);
      assert.equal(roleAdminStatus, 403, `${account.role} must be denied admin API access`);
      const mutationName = `Synthetic.Flow.Denied.${account.role}.${randomUUID()}`;
      const mutationStatus = await webPage.evaluate(async ({ csrfToken, username, password, idempotencyKey }) => (await fetch("/api/admin/users", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ username, password, role: "operator", confirmationToken: null, idempotencyKey }),
      })).status, { csrfToken: roleSession.csrfToken, username: mutationName, password: `Synthetic-denied-${randomBytes(20).toString("hex")}!`, idempotencyKey: randomUUID() });
      assert.equal(mutationStatus, 403, `${account.role} must be denied admin mutations`);
      assert.equal(await models.User.findOne({ where: { usernameNormalized: mutationName.toLowerCase() } }), null,
        `denied ${account.role} mutation must not create a user`);
      await webPage.goto(`${webOrigin}/admin`, { waitUntil: "domcontentloaded" });
      await webPage.getByRole("heading", { name: "Brak dostępu" }).waitFor({ timeout: 30_000 });
      await webPage.getByRole("alert").filter({ hasText: "Ta strona jest dostępna wyłącznie dla administratora." }).waitFor({ timeout: 30_000 });
      roleBoundaryResults.push(account.role);
    }
    assert.deepEqual(uiExternalRequests, [], "real UI flow should not contact external services");
    assert.deepEqual(uiErrors, [], "real UI flow should have no uncaught page errors");
    assert.equal(uiApiResponses.some((item) => item.path === `/api/imports/${imported.id}/preparations/${preparation.preparationId}/rows` && item.status === 200), true,
      "real UI should read prepared rows from the API");
    assert.ok(uiRun.id, "real UI run response should expose its persisted run ID");
    console.log(`BROWSER_BACKEND_FLOW_PASS login=${uiLoginResponse.status()} upload=${uploadResponse.status()} preparation=${preparationResponse.status()} run=${uiRunResponse.status()} sms=${uiSmsResponse.status()} artifact=${uiDownload.suggestedFilename().endsWith(".xlsx") ? 200 : 0} adminOperations=200 logout=${uiLogoutStatus} unauthenticated=${uiUnauthStatus} nonAdminRoles=${roleBoundaryResults.join(",")} adminRead=403 adminMutation=403 adminPage=denied auditRoles=${roleAuditResults.join(",")} runCreateRoles=${roleRunResults.join(",")} reviewerScoped=true externalRequests=0 pageErrors=0`);
    currentScenario = "authenticated";
    for (const scenario of ["authenticated", "sms", "sms_rejected_reentry", "sms_rejected_resend", "sms_timeout", "sms_retry_limit", "not_found"]) {
      currentScenario = scenario;
      const priorCounts = { ...counts };
      const priorSms = observedSmsSubmissions; const priorResends = observedResends;
      for (const portal of ["pzu", "compensa"]) await (await browser.page(portal)).goto(config[portal].entryUrl);
      const batchId = randomUUID(); const sourceRowId = randomUUID(); const createdAt = new Date();
      await models.ImportBatch.create({ id: batchId, tenantId: tenant.tenantId, ownerUserId: userId, toolId: "oc-policy-verification",
        fileName: "synthetic-e2e.xlsx", sha256: randomBytes(32).toString("hex"), totalRows: 1, invalidRows: 0, createdAt });
      await models.SourceRow.create({ id: sourceRowId, batchId, rowNumber: 2, companyName: "Synthetic Company", decisionMakerName: "Ala Testowa",
        nipRaw: "", address: "Synthetic 1", postalCode: "00-000", city: "Synthetic", regonRaw: "998877664", regon: "998877664", effectiveRegon: "998877664", issues: [] });
      const preparationResponse = await fetch(`${origin}/api/imports/${batchId}/preparations`, {
        method: "POST", headers, body: JSON.stringify({ idempotencyKey: `synthetic-automation-${randomUUID()}` }),
      });
      assert.equal(preparationResponse.status, 201,
        `AUTOMATION_PREPARATION_REJECTED_${await preparationResponse.clone().text()}`);
      const preparation = await preparationResponse.json();
      const sealedPreparation = await waitUntil(async () => {
        const response = await fetch(`${origin}/api/imports/${batchId}/preparations/${preparation.preparationId}`, { headers });
        assert.equal(response.status, 200);
        const current = await response.json();
        if (current.status === "failed") throw new Error(`AUTOMATION_PREPARATION_FAILED_${current.errorCode ?? "UNKNOWN"}`);
        return current.sealedAt && ["completed", "completed_with_attention"].includes(current.status) ? current : null;
      }, "IMPORT_PREPARATION_SEAL");
      const preparedRowsResponse = await fetch(
        `${origin}/api/imports/${batchId}/preparations/${sealedPreparation.preparationId}/rows?page=1&state=ready`, { headers },
      );
      assert.equal(preparedRowsResponse.status, 200);
      const preparedRows = await preparedRowsResponse.json();
      assert.equal(preparedRows.rows.some((row) => row.sourceRowId === sourceRowId), true,
        "the synthetic source row must be executable in the sealed preparation");
      const created = await fetch(`${origin}/api/runs`, { method: "POST", headers, body: JSON.stringify({ batchId, rowNumber: 2 }) });
      assert.equal(created.status, 201, `AUTOMATION_CREATE_REJECTED_${await created.clone().text()}`); const createdBody = await created.json(); const runId = createdBody.id;
      assert.ok(runId, "run HTTP response must expose its ID");
      if (scenario.startsWith("sms")) {
        const readChallenge = async () => {
          const response = await fetch(`${origin}/api/auth-challenges?runId=${runId}`, { headers });
          assert.equal(response.status, 200);
          const raw = await response.text(); const body = raw ? JSON.parse(raw) : null;
          return body?.challengeId ? body : null;
        };
        let challenge = await waitUntil(readChallenge, "SMS_CHALLENGE");
        assert.ok(Date.parse(challenge.expiresAt) - Date.now() > 240_000);
        if (scenario.startsWith("sms_rejected")) {
          const rejectedId = challenge.challengeId;
          const originalDeadline = Date.parse(challenge.expiresAt);
          const wrong = await fetch(`${origin}/api/auth-challenges/${rejectedId}/code`, { method: "POST", headers, body: JSON.stringify({ runId, code: "000000" }) });
          assert.equal(wrong.status, 202);
          challenge = await waitUntil(async () => {
            const next = await readChallenge();
            return next?.challengeId !== rejectedId && next?.reasonCode === "SMS_CODE_REJECTED" ? next : null;
          }, "SMS_REJECTED_NEW_HANDOFF");
          assert.ok(Date.parse(challenge.expiresAt) <= originalDeadline);
          assert.equal(challenge.attemptCount, 1);
          assert.equal(observedResends - priorResends, 0);
          const notifications = await (await fetch(`${origin}/api/interventions?status=open`, { headers })).json();
          const notification = notifications.items.find((item) => item.runId === runId);
          assert.equal(notification.reasonCode, "SMS_CODE_REJECTED");
          assert.equal(notification.isUnread, true); assert.equal(notification.canSubmitSms, true); assert.equal(notification.canResumeAuth, true);
          if (scenario === "sms_rejected_resend") {
            const oldId = challenge.challengeId;
            const attempts = await Promise.all([1, 2].map(() => fetch(`${origin}/api/runs/${runId}/resume-auth`, { method: "POST", headers, body: "{}" })));
            assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 409]);
            challenge = await waitUntil(async () => {
              const next = await readChallenge(); return next && next.challengeId !== oldId ? next : null;
            }, "SMS_REJECTED_RESEND_HANDOFF");
            assert.equal(challenge.reasonCode, "SMS_REQUIRED");
            assert.equal(observedResends - priorResends, 1);
            assert.equal((await fetch(`${origin}/api/auth-challenges/${oldId}/code`, { method: "POST", headers, body: JSON.stringify({ runId, code: "654321" }) })).status, 409);
          }
        }
        const expireChallenge = async (active) => {
          // Time-travel only the disposable DB and fixture; do not sleep for five real minutes.
          await models.AuthChallenge.update({ expiresAt: new Date(Date.now() - 1) }, { where: { challengeId: active.challengeId } });
          await (await browser.page("pzu")).evaluate(() => { document.querySelector('#expired').hidden = false; document.querySelector('#resend').hidden = false; });
          await readChallenge(); inbox.invalidate(active.challengeId);
          await waitUntil(async () => {
            const run = await models.AutomationRun.findByPk(runId);
            return run.status === "waiting_for_manual_data" && !run.executionId;
          }, "SMS_TIMEOUT_RELEASE");
        };
        if (scenario === "sms_timeout" || scenario === "sms_retry_limit") {
          const expiredId = challenge.challengeId;
          await expireChallenge(challenge);
          const resumed = await fetch(`${origin}/api/runs/${runId}/resume-auth`, { method: "POST", headers, body: "{}" });
          assert.equal(resumed.status, 201);
          challenge = await waitUntil(readChallenge, "SMS_RETRY_CHALLENGE"); assert.notEqual(challenge.challengeId, expiredId);
          assert.equal(observedResends - priorResends, 1);
          const stale = await fetch(`${origin}/api/auth-challenges/${expiredId}/code`, { method: "POST", headers, body: JSON.stringify({ runId, code: "654321" }) });
          assert.ok([409, 410].includes(stale.status));
          if (scenario === "sms_retry_limit") {
            const secondExpiredId = challenge.challengeId;
            await expireChallenge(challenge);
            const secondRetry = await fetch(`${origin}/api/runs/${runId}/resume-auth`, { method: "POST", headers, body: "{}" });
            assert.equal(secondRetry.status, 201);
            challenge = await waitUntil(readChallenge, "SMS_SECOND_RETRY_CHALLENGE");
            assert.notEqual(challenge.challengeId, secondExpiredId);
            assert.equal(observedResends - priorResends, 2);
            await expireChallenge(challenge);
            const overLimit = await fetch(`${origin}/api/runs/${runId}/resume-auth`, { method: "POST", headers, body: "{}" });
            assert.equal(overLimit.status, 409);
            assert.equal(observedResends - priorResends, 2);
          }
        }
        if (scenario !== "sms_retry_limit") {
          const submitted = await fetch(`${origin}/api/auth-challenges/${challenge.challengeId}/code`, { method: "POST", headers, body: JSON.stringify({ runId, code: "654321" }) });
          assert.equal(submitted.status, 202);
          assert.equal((await fetch(`${origin}/api/auth-challenges/${challenge.challengeId}/code`, { method: "POST", headers, body: JSON.stringify({ runId, code: "654321" }) })).status, 409);
        }
      }
      const done = await waitUntil(async () => {
        const run = await models.AutomationRun.findByPk(runId);
        return run && ["completed", "identity_review", "waiting_for_manual_data", "failed"].includes(run.status) ? run : null;
      }, scenario.toUpperCase());
      const expectedDoneStatus = scenario === "not_found" ? "failed"
        : scenario === "sms_retry_limit" ? "waiting_for_manual_data" : "completed";
      if (done.status !== expectedDoneStatus) {
        const pzuPage = await browser.page("pzu");
        const search = pzuPage.locator(config.pzu.everest.searchInput);
        const runEvents = await models.RunEvent.findAll({
          where: { runId }, order: [["createdAt", "ASC"]],
          attributes: ["status", "step", "errorCode", "metadata"],
        });
        const pzuState = {
          url: pzuPage.url(),
          searchCount: await search.count(),
          searchValue: await search.inputValue().catch(() => null),
          resultRows: await pzuPage.locator(config.pzu.everest.resultRows).count(),
          emptyVisible: await pzuPage.locator(config.pzu.everest.noResults).first().isVisible().catch(() => false),
        };
        console.error("AUTOMATION_RUN_TERMINAL_MISMATCH", JSON.stringify({ scenario, status: done.status,
          currentStep: done.currentStep, errorCode: done.errorCode, workerFailures: failures, pzuState,
          events: runEvents.map((event) => ({ status: event.status, step: event.step, errorCode: event.errorCode,
            portal: event.metadata?.portal, kind: event.metadata?.kind, reasonCode: event.metadata?.reasonCode })) }));
      }
      if (scenario === "not_found" || scenario === "sms_retry_limit") {
        assert.equal(done.status, scenario === "not_found" ? "failed" : "waiting_for_manual_data");
        if (scenario === "not_found") assert.equal(done.errorCode, "IDENTITY_NOT_FOUND");
        assert.equal(counts.starts, priorCounts.starts);
        assert.equal(await models.ExportArtifact.count({ where: { runId } }), 0);
      } else {
        assert.equal(done.status, "completed", `AUTOMATION_RUN_NOT_COMPLETED_${done.currentStep}_${done.errorCode ?? "NO_ERROR_CODE"}`);
        assert.equal(counts.starts - priorCounts.starts, 1); assert.equal(counts.saves - priorCounts.saves, 1); assert.equal(counts.ufg - priorCounts.ufg, 1);
        const compensa = await browser.page("compensa");
        assert.equal(await compensa.locator('[name="insuredIdentifier"]').inputValue(), "90010100016");
        assert.equal(await compensa.locator('[name="vehicleRegistration"]').inputValue(), "RST22339");
        assert.equal((await models.OcSnapshot.findByPk(runId)).totalCount, 3);
        const download = await fetch(`${origin}/api/runs/${runId}/artifact`, { headers }); assert.equal(download.status, 200);
        const ExcelJS = require("exceljs"); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()));
        assert.ok(workbook.worksheets.some((sheet) => sheet.getSheetValues().flat(2).includes("90010100016")));
      }
      await waitUntil(async () => !(await models.AutomationRun.findByPk(runId)).executionId, "LEASE_RELEASE");
      const jobs = await queue.getJobs(["completed", "failed", "active", "waiting"]);
      for (const job of jobs) assert.deepEqual(Object.keys(job.data), ["runId"]);
      if (scenario === "sms" || scenario === "sms_timeout") {
        assert.equal(observedSmsSubmissions - priorSms, 1); assert.equal(await (await browser.page("pzu")).evaluate(() => window.wasRemembered), true);
        const events = await models.RunEvent.findAll({ where: { runId } });
        const challenges = await models.AuthChallenge.findAll({ where: { runId } });
        assert.equal(JSON.stringify([...events, ...challenges]).includes('"654321"'), false);
      }
      if (scenario === "sms_timeout" || scenario === "sms_retry_limit") {
        assert.equal((await models.AutomationRun.findByPk(runId)).pzuSmsRetryCount, scenario === "sms_retry_limit" ? 2 : 1);
      }
      console.log(`AUTOMATION_FLOW_SCENARIO_PASS scenario=${scenario} realHTTP=true realQueue=true productionProcessor=true realDB=true browser=fixture`);
    }
    console.log("AUTOMATION_FLOW_SMOKE_PASS authenticated=true smsPlatformHandoff=true rejectedReentry=true rejectedResend=true concurrentResendFenced=true timeoutResume=true resendLimit=one knownAd=true notFoundStopsCompensa=true xlsx=true livePortals=false modalUI=true realFrontendApi=true");
  } catch (error) {
    console.error("AUTOMATION_FLOW_CASE_FAILED", currentScenario, error.message);
    throw error;
  } finally {
    shutdown.abort();
    if (webBrowser) await webBrowser.close();
    if (webServer && webServer.exitCode === null) {
      await new Promise((resolveExit) => {
        const timer = setTimeout(resolveExit, 5_000);
        webServer.once("exit", () => { clearTimeout(timer); resolveExit(); });
        webServer.kill();
      });
    }
    if (worker) await worker.pause(true);
    if (receiver) await receiver.close(); else inbox.close();
    if (worker) await worker.close();
    if (browser) await browser.close();
    if (app) await app.close();
    if (queue) { await queue.obliterate({ force: true }); await queue.close(); }
    await pool.end();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
};
