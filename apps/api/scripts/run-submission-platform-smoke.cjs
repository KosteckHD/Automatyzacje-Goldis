const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

function assertDisposableRedis() {
  if (process.env.GOLDIS_TEST_REDIS_DISPOSABLE !== "1") throw new Error("RUN_SUBMISSION_PLATFORM_DISPOSABLE_REDIS_REQUIRED");
  const url = new URL(process.env.REDIS_URL ?? "");
  if (url.protocol !== "redis:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("RUN_SUBMISSION_PLATFORM_LOCAL_REDIS_REQUIRED");
  }
  return url;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const value = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return value;
}

async function waitForWeb(url, child) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null) throw new Error("RUN_SUBMISSION_PLATFORM_NEXT_EXITED");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Next.js is compiling its first page. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("RUN_SUBMISSION_PLATFORM_NEXT_TIMEOUT");
}

async function main() {
  const redisUrl = assertDisposableRedis();
  const models = require("../dist/db");
  const { hashPassword } = require("../dist/password-hash");
  const { NestFactory } = require("@nestjs/core");
  const { Queue } = require("bullmq");
  const { chromium } = require("playwright");
  const root = await mkdtemp(join(tmpdir(), "goldis-run-submission-platform-"));
  const apiPort = await freePort();
  const webPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const username = `Synthetic.Platform.${randomBytes(5).toString("hex")}`;
  const password = `Synthetic-only-${randomBytes(24).toString("hex")}!`;
  const userId = randomUUID();
  const batchId = randomUUID();
  const envValues = {
    SESSION_SECRET: randomBytes(32).toString("hex"),
    WORKER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PUBLIC_APP_ORIGIN: webOrigin,
    API_INTERNAL_URL: apiOrigin,
    API_EXPORT_DIR: join(root, "exports"),
    GOLDIS_ADMIN_USER: username,
    GOLDIS_ADMIN_PASSWORD: password,
    NODE_ENV: "development",
    PORTAL_MODE: "off",
  };
  const previous = Object.fromEntries(Object.keys(envValues).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envValues);
  const connection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    db: Number(redisUrl.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  };
  let app;
  let web;
  let browser;
  let stage = "fixture";
  try {
    const tenant = await models.Tenant.findOne({ where: { slug: "goldis" } });
    if (!tenant) throw new Error("RUN_SUBMISSION_PLATFORM_TENANT_MISSING");
    const now = new Date();
    await models.User.create({
      userId,
      username,
      usernameNormalized: username.toLowerCase(),
      passwordHash: await hashPassword(password),
      status: "active",
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    });
    await models.TenantMembership.create({
      tenantId: tenant.tenantId,
      userId,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await models.Tool.update({ status: "available" }, { where: { toolId: "oc-policy-verification" } });
    const settings = await models.ToolSettings.findOne({ where: { tenantId: tenant.tenantId, toolId: "oc-policy-verification" } });
    if (!settings) throw new Error("RUN_SUBMISSION_PLATFORM_SETTINGS_MISSING");
    await settings.update({ enabledForNewRuns: true, allowedLocalStart: null, allowedLocalEnd: null, maxNewRunsPerHour: 500 });

    await models.ImportBatch.create({
      id: batchId,
      tenantId: tenant.tenantId,
      ownerUserId: userId,
      toolId: "oc-policy-verification",
      fileName: "synthetic-platform-smoke.xlsx",
      sha256: randomBytes(32).toString("hex"),
      totalRows: 2,
      invalidRows: 0,
      createdAt: now,
    });
    const validNip = (seed) => {
      const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
      let number = seed;
      for (;;) {
        const digits = String(number++).padStart(9, "0").slice(-9);
        const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0) % 11;
        if (checksum !== 10) return `${digits}${checksum}`;
      }
    };
    const validRegon = (seed) => {
      const weights = [8, 9, 2, 3, 4, 5, 6, 7];
      let number = seed;
      for (;;) {
        const digits = String(number++).padStart(8, "0").slice(-8);
        const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0) % 11;
        if (checksum !== 10) return `${digits}${checksum}`;
      }
    };
    const identities = [];
    while (identities.length < 2) {
      const nip = validNip(100000000 + (randomBytes(4).readUInt32BE(0) % 899999999));
      const regon = validRegon(10000000 + (randomBytes(4).readUInt32BE(0) % 89999999));
      if (identities.some((identity) => identity.nip === nip || identity.regon === regon)) continue;
      const existingNip = await models.CanonicalEntity.findOne({ where: { nipNormalized: nip } });
      const existingRegon = await models.CanonicalEntity.findOne({ where: { regon } });
      if (!existingNip && !existingRegon) identities.push({ nip, regon });
    }
    await models.SourceRow.bulkCreate([
      { id: randomUUID(), batchId, rowNumber: 2, companyName: "Synthetic Platform Company A", decisionMakerName: null,
        nipRaw: identities[0].nip, address: "Synthetic 1", postalCode: "00-000", city: "Test City",
        regonRaw: identities[0].regon, regon: identities[0].regon, effectiveRegon: identities[0].regon, rowVersion: 1, issues: [] },
      { id: randomUUID(), batchId, rowNumber: 3, companyName: "Synthetic Platform Company B", decisionMakerName: null,
        nipRaw: identities[1].nip, address: "Synthetic 2", postalCode: "00-000", city: "Test City",
        regonRaw: identities[1].regon, regon: identities[1].regon, effectiveRegon: identities[1].regon, rowVersion: 1, issues: [] },
    ]);

    stage = "api_start";
    const { AppModule } = require("../dist/module");
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(apiPort, "127.0.0.1");

    stage = "next_start";
    const nextBin = require.resolve("next/dist/bin/next", { paths: [resolve(__dirname, "../../web")] });
    web = spawn(process.execPath, [nextBin, "dev", "-p", String(webPort), "-H", "127.0.0.1"], {
      cwd: resolve(__dirname, "../../web"),
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, API_INTERNAL_URL: apiOrigin, PORT: String(webPort), NODE_ENV: "development" },
    });
    await waitForWeb(webOrigin, web);

    stage = "browser_login";
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${webOrigin}/tools/oc-policy-verification?import=${batchId}`);
    await page.getByRole("heading", { name: "Zaloguj się" }).waitFor({ state: "visible" });
    await page.getByLabel("Użytkownik").fill(username);
    await page.getByLabel("Hasło").fill(password);
    await page.getByRole("button", { name: "Przejdź do panelu" }).click();
    await page.getByRole("heading", { name: "Sprawdź wiele wierszy" }).waitFor({ state: "visible", timeout: 30_000 });

    stage = "preview";
    const launcher = page.locator(".submission-launcher");
    await launcher.getByLabel("Od wiersza (zakres partii)").fill("2");
    await launcher.getByLabel("Do wiersza (zakres partii)").fill("3");
    await launcher.getByRole("button", { name: "Pokaż podsumowanie" }).click();
    await page.getByRole("heading", { name: /Podsumowanie/ }).waitFor({ state: "visible" });
    await page.getByText("Wybrane", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".submission-counts dd").nth(0).textContent(), "2", "fullstack preview selected count");
    assert.equal(await page.locator(".submission-counts dd").nth(1).textContent(), "2", "fullstack preview ready count");
    assert.equal(await page.locator(".submission-counts dd").nth(4).textContent(), "2", "fullstack preview unique group count");
    assert.equal(await launcher.getByRole("button", { name: "Potwierdź i uruchom gotowe wiersze" }).isDisabled(), true);
    stage = "create_and_detail";
    await launcher.getByLabel(/Rozumiem podsumowanie/).check();
    await launcher.getByRole("button", { name: "Potwierdź i uruchom gotowe wiersze" }).click();
    await page.getByRole("heading", { name: "Stan zgłoszenia" }).waitFor({ state: "visible", timeout: 30_000 });
    const submissionUrl = new URL(page.url());
    const match = submissionUrl.pathname.match(/^\/submissions\/([0-9a-f-]{36})$/i);
    assert.ok(match, "creating a submission should navigate to its stable detail URL");
    const submissionId = match[1];
    await page.getByText("Wiersz 2", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Wiersz 3", { exact: true }).waitFor({ state: "visible" });

    stage = "persistence_audit";
    const persisted = await models.RunSubmission.findByPk(submissionId);
    const items = await models.RunSubmissionItem.findAll({ where: { submissionId } });
    const groups = await models.RunSubmissionGroup.findAll({ where: { submissionId } });
    const audit = await models.AuditEvent.findOne({ where: { tenantId: tenant.tenantId, resourceId: submissionId, action: "run.submission.created" } });
    assert.ok(persisted, "the real HTTP request must create a PostgreSQL submission");
    assert.equal(items.length, 2);
    assert.equal(groups.length, 2);
    assert.ok(audit, "submission audit must be committed with the submission");

    stage = "detail_reload";
    await page.reload();
    await page.getByRole("heading", { name: "Stan zgłoszenia" }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("Wiersz 2", { exact: true }).waitFor({ state: "visible" });
    assert.deepEqual(pageErrors, [], "the real Next.js page should not produce browser errors");

    stage = "dispatcher_redis";
    const deadline = Date.now() + 12_000;
    let acceptedGroups = [];
    while (Date.now() < deadline) {
      acceptedGroups = await models.RunSubmissionGroup.findAll({ where: { submissionId, admissionState: "accepted" } });
      if (acceptedGroups.length === 2) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    if (acceptedGroups.length !== 2) {
      const currentGroups = await models.RunSubmissionGroup.findAll({ where: { submissionId },
        attributes: ["admissionState", "reasonCode", "runId", "nextAttemptAt", "leaseExpiresAt"] });
      throw new Error(`RUN_SUBMISSION_PLATFORM_DISPATCH_DID_NOT_ADMIT_ALL_GROUPS_${JSON.stringify(currentGroups.map((group) => group.toJSON()))}`);
    }
    assert.ok(acceptedGroups.every((group) => group.runId));
    const outboxes = await models.RunDispatchOutbox.findAll({ where: { runId: acceptedGroups.map((group) => group.runId), intentType: "create" } });
    assert.equal(outboxes.length, 2);
    const queue = new Queue("oc-verification", { connection });
    try {
      await queue.waitUntilReady();
      const runIds = new Set(acceptedGroups.map((group) => group.runId));
      let related = [];
      const queueDeadline = Date.now() + 15_000;
      while (Date.now() < queueDeadline) {
        const jobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed", "waiting-children"]);
        related = jobs.filter((job) => runIds.has(job.data?.runId));
        if (related.length === 2) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      if (related.length !== 2) {
        const outboxStates = await models.RunDispatchOutbox.findAll({ where: { runId: [...runIds], intentType: "create" }, attributes: ["status", "lastErrorCode"] });
        throw new Error(`RUN_SUBMISSION_PLATFORM_REDIS_JOBS_MISSING_${JSON.stringify({ jobs: related.length, outbox: outboxStates.map((item) => item.toJSON()) })}`);
      }
      assert.ok(related.every((job) => Object.keys(job.data).length === 1));
    } finally {
      await queue.close();
    }

    console.log("RUN_SUBMISSION_PLATFORM_SMOKE_PASS realNext=true realApi=true browserLogin=true preview=true create=true postgres=true audit=true dispatcher=true redisOutbox=true detailReload=true portals=off syntheticOnly=true");
  } catch (error) {
    console.error("RUN_SUBMISSION_PLATFORM_SMOKE_FAILED", `stage=${stage}`, error?.message ?? "unknown");
    throw error;
  } finally {
    if (browser) await browser.close();
    if (web && web.exitCode === null) {
      web.kill();
      await new Promise((resolveExit) => web.once("exit", resolveExit));
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

module.exports = main;

if (require.main === module) {
  main().catch((error) => {
    console.error("RUN_SUBMISSION_PLATFORM_SMOKE_FAILED", error?.message ?? "unknown");
    process.exitCode = 1;
  });
}
