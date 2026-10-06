const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { join, resolve } = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");

const batchId = "33333333-3333-4333-8333-333333333333";
const runId = "22222222-2222-4222-8222-222222222222";
const challengeId = "11111111-1111-4111-8111-111111111111";
const interventionId = "44444444-4444-4444-8444-444444444444";
const csrfToken = "synthetic-csrf-token-for-w3-ui-smoke-1234567890";
const portProbe = createServer();

async function freePort() {
  await new Promise((resolveListen, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolveListen);
  });
  const port = portProbe.address().port;
  await new Promise((resolveClose, reject) => portProbe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForServer(url, process) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Retry while Next.js starts. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: resolve(__dirname, ".."),
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  });
  let browser;
  let failureScreenshot = join(os.tmpdir(), "goldis-w3-sms-ui-failure.png");
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    let challengeExpiry = new Date(Date.now() + 5_000).toISOString();
    let submittedRequest = null;
    let cancellationRequest = null;
    let runStatus = "waiting_for_sms";
    let reasonCode = "SMS_REQUIRED";
    let canResumeAuth = false;
    let resendRequests = 0;
    let resendHeaders = null;
    let role = "admin";
    let viewResults = true;
    let seenRevision = 0;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let body;
      let status = 200;
      if (url.pathname === "/api/auth/me") {
        body = { role, csrfToken, tools: [{ toolId: "oc-policy-verification", canDiscover: true, canExecute: true, canViewResults: viewResults, canDownloadResults: viewResults }] };
      } else if (url.pathname === "/api/interventions/summary") {
        body = { openCount: 1, unreadCount: seenRevision ? 0 : 1, smsCount: runStatus === "waiting_for_sms" ? 1 : 0 };
      } else if (url.pathname === "/api/interventions" && method === "GET") {
        body = { items: [{ interventionId, runId, batchId, rowNumber: 18001, kind: "sms", portal: "pzu", reasonCode, status: "open", revision: 1, createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z", challenge: { challengeId, expiresAt: challengeExpiry, status: "active", attemptCount: 0, attemptLimit: 5 }, isUnread: !seenRevision, canSubmitSms: runStatus === "waiting_for_sms", canResumeAuth, canResumeReview: false }], nextCursor: null };
      } else if (url.pathname === `/api/interventions/${interventionId}/read` && method === "POST") {
        seenRevision = 1;
        body = { interventionId, seenRevision, isUnread: false };
      } else if (url.pathname === `/api/imports/${batchId}`) {
        body = { id: batchId, totalRows: 1, invalidRows: 0, readyRows: 1, sha256: "a".repeat(64) };
      } else if (url.pathname === `/api/imports/${batchId}/rows`) {
        body = [{ rowNumber: 18001, companyName: "Syntetyczna firma", decisionMakerName: "Osoba testowa", regon: "012345678", issues: [] }];
      } else if (url.pathname === "/api/runs") {
        body = [{ id: runId, rowNumber: 18001, status: runStatus, currentStep: runStatus, referenceDate: "2026-09-30", errorCode: null, createdAt: "2026-09-30T10:00:00.000Z" }];
      } else if (url.pathname === `/api/runs/${runId}/cancel` && method === "POST") {
        cancellationRequest = { headers: request.headers() };
        runStatus = "cancelled";
        body = { id: runId, rowNumber: 18001, status: runStatus, currentStep: runStatus, referenceDate: "2026-09-30", errorCode: null, createdAt: "2026-09-30T10:00:00.000Z" };
      } else if (url.pathname === `/api/runs/${runId}/resume-auth` && method === "POST") {
        resendRequests++; resendHeaders = request.headers();
        runStatus = "waiting_for_sms"; reasonCode = "SMS_REQUIRED"; canResumeAuth = false;
        challengeExpiry = new Date(Date.now() + 300_000).toISOString();
        body = { id: runId, rowNumber: 18001, status: runStatus, currentStep: runStatus, referenceDate: "2026-09-30", errorCode: null, createdAt: "2026-09-30T10:00:00.000Z" };
      } else if (url.pathname === `/api/runs/${runId}`) {
        body = { id: runId, rowNumber: 18001, status: runStatus, currentStep: runStatus, referenceDate: "2026-09-30", errorCode: null, createdAt: "2026-09-30T10:00:00.000Z", events: [], incident: { kind: "sms", portal: "pzu", reasonCode, canResumeAuth } };
        if (!viewResults) { status = 403; body = { message: "No result access" }; }
      } else if (url.pathname === "/api/auth-challenges" && method === "GET") {
        body = runStatus === "waiting_for_sms" ? { challengeId, runId, portal: "pzu", status: "active", expiresAt: challengeExpiry, serverNow: new Date().toISOString(), attemptCount: reasonCode === "SMS_CODE_REJECTED" ? 1 : 0, attemptLimit: 5, reasonCode } : null;
      } else if (url.pathname === `/api/auth-challenges/${challengeId}/code` && method === "POST") {
        submittedRequest = { headers: request.headers(), body: request.postDataJSON() };
        body = { accepted: true, challengeId, attemptCount: 1 };
        status = 202;
      } else {
        body = { message: "Unexpected synthetic API request" };
        status = 404;
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store" } });
    });

    await page.goto(`${baseUrl}/?import=${batchId}`);
    const interventionButton = page.getByRole("button", { name: "Wpisz kod SMS dla wiersza 18001" });
    await interventionButton.waitFor({ state: "visible" });
    await interventionButton.click();
    const input = page.getByLabel("Kod weryfikacyjny");
    await input.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("dialog", { name: "Wprowadź kod SMS" }).count(), 1, "kod otwiera się w dostępnym modalu z centrum zgłoszeń");
    await input.fill("12x34567");
    assert.equal(await input.inputValue(), "1234567", "pole usuwa znaki inne niż cyfry");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_200));
    await page.getByRole("alert").filter({ hasText: "Kod wygasł" }).waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("Kod weryfikacyjny").count(), 0, "po wygaśnięciu pole kodu znika");

    challengeExpiry = new Date(Date.now() + 60_000).toISOString();
    await page.reload();
    await page.getByRole("button", { name: "Wpisz kod SMS dla wiersza 18001" }).click();
    await page.getByLabel("Kod weryfikacyjny").waitFor({ state: "visible" });
    await page.getByLabel("Kod weryfikacyjny").fill("407219");
    await page.getByRole("button", { name: "Przekaż kod" }).click();
    await page.getByText(/Kod przekazano do sesji przeglądarki/).waitFor({ state: "visible" });
    assert.equal(submittedRequest?.headers["x-csrf-token"], csrfToken, "CSRF token pochodzi z odświeżonej sesji");
    assert.deepEqual(submittedRequest?.body, { runId, code: "407219" });
    assert.equal(await page.getByLabel("Kod weryfikacyjny").count(), 0, "po wysłaniu pole i jego wartość są usunięte");
    await page.getByRole("button", { name: "Zamknij okno kodu" }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Wpisz kod SMS dla wiersza 18001");
    assert.equal(await page.getByRole("button", { name: "Zamknij okno kodu" }).count(), 0, "zamknięcie modalu oddaje fokus do zgłoszenia");
    await page.getByRole("button", { name: "Anuluj zadanie" }).click();
    await page.getByRole("heading", { name: /Wiersz 18001: Anulowano/ }).waitFor({ state: "visible" });
    assert.equal(cancellationRequest?.headers["x-csrf-token"], csrfToken, "anulowanie zadania przekazuje CSRF");

    runStatus = "waiting_for_manual_data"; reasonCode = "SMS_TIMEOUT"; canResumeAuth = true;
    await page.reload();
    await page.getByRole("button", { name: "Otwórz zgłoszenie dla wiersza 18001" }).click();
    const timeoutDialog = page.getByRole("dialog", { name: "Wprowadź kod SMS" });
    await timeoutDialog.getByText("Kod wygasł. Automatyzacja jest wstrzymana.").waitFor();
    assert.equal(await timeoutDialog.getByLabel("Kod weryfikacyjny").count(), 0);
    await timeoutDialog.getByRole("button", { name: "Wyślij jeden dodatkowy kod SMS" }).click();
    await timeoutDialog.getByLabel("Kod weryfikacyjny").waitFor();
    assert.equal(resendRequests, 1); assert.equal(resendHeaders["x-csrf-token"], csrfToken);

    reasonCode = "SMS_CODE_REJECTED"; canResumeAuth = true;
    await page.reload();
    await page.getByRole("button", { name: "Wpisz kod SMS dla wiersza 18001" }).click();
    await page.getByRole("alert").filter({ hasText: "Portal odrzucił poprzedni kod" }).waitFor();
    assert.equal(await page.getByLabel("Kod weryfikacyjny").inputValue(), "");
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Wyślij jeden dodatkowy kod SMS" }).count(), 1);

    reasonCode = "SMS_TIMEOUT"; canResumeAuth = false; runStatus = "waiting_for_manual_data";
    await page.reload();
    await page.getByRole("button", { name: "Otwórz zgłoszenie dla wiersza 18001" }).click();
    assert.equal(await page.getByRole("button", { name: "Wyślij jeden dodatkowy kod SMS" }).count(), 0);
    assert.equal(resendRequests, 1, "wyczerpany limit nie uruchamia kolejnego SMS");
    role = "operator"; viewResults = false; runStatus = "waiting_for_sms"; reasonCode = "SMS_REQUIRED";
    await page.reload();
    await page.getByRole("button", { name: "Wpisz kod SMS dla wiersza 18001" }).click();
    await page.getByRole("dialog").getByLabel("Kod weryfikacyjny").waitFor();
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Wyślij jeden dodatkowy kod SMS" }).count(), 0);
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript w przeglądarce");

    console.log("W3_SMS_UI_SMOKE_PASS globalInterventionCenter=true accessibleModal=true focusRestored=true csrfRestoredAfterRefresh=true digitsOnly=true challengeExpiryHidesInput=true codeClearedAfterSubmit=true cancelDuringMfaWithCsrf=true timeoutResendModal=true rejectedCodeModal=true resendLimit=true smsWithoutResults=true portal=synthetic");
  } catch (error) {
    if (browser) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page) await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      server.kill();
      await new Promise((resolveExit) => server.once("exit", resolveExit));
    }
  }
}

main().catch((error) => {
  console.error("W3_SMS_UI_SMOKE_FAILED", error?.message ?? "unknown");
  process.exitCode = 1;
});
