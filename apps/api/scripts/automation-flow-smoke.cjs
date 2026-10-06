const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

/** Real API, guards, outbox, BullMQ, production processor, browser adapters and exporter. */
module.exports = async function automationFlowSmoke() {
  if (process.env.GOLDIS_TEST_REDIS_DISPOSABLE !== "1") throw new Error("AUTOMATION_DISPOSABLE_REDIS_REQUIRED");
  const redisUrl = new URL(process.env.REDIS_URL ?? "");
  if (redisUrl.protocol !== "redis:" || !["127.0.0.1", "localhost"].includes(redisUrl.hostname)) throw new Error("AUTOMATION_LOCAL_REDIS_REQUIRED");
  const { Pool } = require("pg"); const { Worker, Queue } = require("bullmq");
  const { NestFactory } = require("@nestjs/core");
  const models = require("../dist/db"); const { hashPassword } = require("../dist/password-hash");
  const { BrowserSession } = require("../../worker/dist/browser");
  const { OneTimeCodeInbox, startWorkerCodeReceiver } = require("../../worker/dist/code-inbox");
  const { LiveRunProcessor } = require("../../worker/dist/live-run");
  const { WorkerResultForwarder } = require("../../worker/dist/result-forwarder");
  const { WorkerResultStagingStore } = require("../../worker/dist/result-staging");
  const { createProductionRunProcessor } = require("../../worker/dist/run-worker");
  const root = await mkdtemp(join(tmpdir(), "goldis-automation-flow-"));
  const password = `Synthetic-only-${randomBytes(20).toString("hex")}!`;
  const overrides = {
    SESSION_SECRET: randomBytes(32).toString("hex"), WORKER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1", PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": randomBytes(32).toString("base64") })).toString("base64"),
    WORKER_STAGING_DIR: join(root, "staging"), WORKER_STAGING_KEY_VERSION: "1", WORKER_STAGING_KEY_V1: randomBytes(32).toString("base64url"),
    API_EXPORT_DIR: join(root, "exports"), NODE_ENV: "development", PUBLIC_APP_ORIGIN: "http://localhost:3000",
    GOLDIS_ADMIN_USER: "Synthetic.Flow.Admin", GOLDIS_ADMIN_PASSWORD: password, PZU_LOGIN: "synthetic-pzu-user", COMPENSA_LOGIN: "synthetic-compensa-user",
  };
  const envKeys = [...Object.keys(overrides), "PUBLIC_APP_ORIGIN", "WORKER_INTERNAL_URL", "WORKER_RESULT_API_URL"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])); Object.assign(process.env, overrides);
  const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), db: Number(redisUrl.pathname.slice(1) || 0), maxRetriesPerRequest: null };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const inbox = new OneTimeCodeInbox();
  const shutdown = new AbortController();
  let app, receiver, worker, queue, browser;
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
  let compensaHtml = await readFile(resolve(__dirname, "../../worker/test-fixtures/compensa-portal.html"), "utf8");
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
    await models.User.create({ userId, username: overrides.GOLDIS_ADMIN_USER, usernameNormalized: overrides.GOLDIS_ADMIN_USER.toLowerCase(),
      passwordHash: await hashPassword(password), status: "active", mustChangePassword: false, createdAt: now, updatedAt: now });
    await models.TenantMembership.create({ userId, tenantId: tenant.tenantId, role: "admin", status: "active", createdAt: now, updatedAt: now });
    await models.Tool.update({ status: "available" }, { where: { toolId: "oc-policy-verification" } });
    await models.ToolSettings.update({ enabledForNewRuns: true, allowedLocalStart: null, allowedLocalEnd: null, maxNewRunsPerHour: null }, { where: { tenantId: tenant.tenantId, toolId: "oc-policy-verification" } });
    receiver = await startWorkerCodeReceiver({ host: "127.0.0.1", port: 0, serviceSecret: process.env.WORKER_AUTH_SECRET, inbox });
    process.env.WORKER_INTERNAL_URL = `http://127.0.0.1:${receiver.address.port}`;
    const { AppModule } = require("../dist/module");
    app = await NestFactory.create(AppModule, { logger: false }); app.setGlobalPrefix("api"); await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl(); process.env.PUBLIC_APP_ORIGIN = origin; process.env.WORKER_RESULT_API_URL = origin;
    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: overrides.GOLDIS_ADMIN_USER, password }) });
    assert.equal(login.status, 201);
    const sessionBody = await login.json(); const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const headers = { cookie, origin, "x-csrf-token": sessionBody.csrfToken, "content-type": "application/json" };
    browser = new BrowserSession({ profileDirectory: join(root, "profile") }); const context = await browser.open();
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
    const live = new LiveRunProcessor({ pool, browser, inbox, config, resultForwarder: new WorkerResultForwarder(), staging: new WorkerResultStagingStore() });
    worker = new Worker("oc-verification", createProductionRunProcessor(pool, live, browser.sessionId, undefined, shutdown.signal), { connection, concurrency: 1 });
    worker.on("error", () => failures.push("QUEUE")); worker.on("failed", (_job, error) => {
      failures.push(/^[A-Z][A-Z0-9_:-]+$/.test(error?.message ?? "") ? error.message : "JOB");
    });
    queue = new Queue("oc-verification", { connection }); await worker.waitUntilReady();
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
            await expireChallenge(challenge);
            assert.equal((await fetch(`${origin}/api/runs/${runId}/resume-auth`, { method: "POST", headers, body: "{}" })).status, 409);
            assert.equal(observedResends - priorResends, 1);
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
      if (scenario === "not_found" || scenario === "sms_retry_limit") {
        assert.equal(done.status, scenario === "not_found" ? "identity_review" : "waiting_for_manual_data"); assert.equal(counts.starts, priorCounts.starts);
        assert.equal(await models.ExportArtifact.count({ where: { runId } }), 0);
      } else {
        assert.equal(done.status, "completed");
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
        assert.equal((await models.AutomationRun.findByPk(runId)).pzuSmsRetryCount, 1);
      }
      console.log(`AUTOMATION_FLOW_SCENARIO_PASS scenario=${scenario} realHTTP=true realQueue=true productionProcessor=true realDB=true browser=fixture`);
    }
    console.log("AUTOMATION_FLOW_SMOKE_PASS authenticated=true smsPlatformHandoff=true rejectedReentry=true rejectedResend=true concurrentResendFenced=true timeoutResume=true resendLimit=one knownAd=true notFoundStopsCompensa=true xlsx=true livePortals=false modalUI=false");
  } catch (error) {
    console.error("AUTOMATION_FLOW_CASE_FAILED", currentScenario, error.message);
    throw error;
  } finally {
    shutdown.abort();
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
