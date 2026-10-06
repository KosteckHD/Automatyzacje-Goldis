const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const batchId = "33333333-3333-4333-8333-333333333333";
const submissionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const csrfToken = "synthetic-csrf-token-for-run-submission-ui-smoke-123456";
const probe = createServer();

async function port() {
  await new Promise((resolveListen, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolveListen); });
  const value = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return value;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { if ((await fetch(url)).ok) return; } catch { /* Next.js is starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

async function main() {
  const listenPort = await port();
  const base = `http://127.0.0.1:${listenPort}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(listenPort)], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(listenPort) },
  });
  let browser;
  try {
    await waitForServer(base, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    const previews = [];
    let createRequest = null;
    let cancelRequest = null;
    let cancelled = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let status = 200;
      let body = {};
      if (url.pathname === "/api/auth/me") {
        body = { role: "operator", username: "synthetic.operator", csrfToken, mustChangePassword: false,
          tools: [{ toolId: "oc-policy-verification", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false }] };
      } else if (url.pathname === "/api/health/automation") {
        body = { automationReady: false, servicesReady: true, worker: "offline", portalMode: "off", portalConfig: "disabled", message: "Automatyzacja portali jest wyłączona w teście." };
      } else if (url.pathname === "/api/interventions/summary") {
        body = { openCount: 0, unreadCount: 0, smsCount: 0 };
      } else if (url.pathname === "/api/interventions") {
        body = { items: [], nextCursor: null };
      } else if (url.pathname === `/api/imports/${batchId}`) {
        body = { id: batchId, totalRows: 3, invalidRows: 1, readyRows: 2, sha256: "a".repeat(64) };
      } else if (url.pathname === `/api/imports/${batchId}/rows`) {
        body = [
          { rowNumber: 2, companyName: "Firma syntetyczna Alfa", decisionMakerName: "Osoba testowa", regon: "123456789", issues: [] },
          { rowNumber: 3, companyName: "Firma syntetyczna Beta", decisionMakerName: null, regon: "987654321", issues: [] },
          { rowNumber: 4, companyName: "Firma syntetyczna Gamma", decisionMakerName: null, regon: "", issues: ["REGON_EMPTY"] },
        ];
      } else if (url.pathname === `/api/imports/${batchId}/enrichment`) {
        body = { page: 1, pageSize: 50, totalRows: 0,
          summary: { missingRegonRows: 0, pendingCorrectionRows: 0, openConflictRows: 0, lookupStatuses: {} }, rows: [] };
      } else if (url.pathname === "/api/runs" && url.searchParams.get("batchId") === batchId) {
        body = [];
      } else if (url.pathname === `/api/imports/${batchId}/run-submissions/preview` && method === "POST") {
        previews.push({ headers: request.headers(), body: request.postDataJSON() });
        const selected = request.postDataJSON().rowNumbers ?? Array.from(
          { length: request.postDataJSON().toRow - request.postDataJSON().fromRow + 1 },
          (_, index) => request.postDataJSON().fromRow + index,
        );
        body = { importBatchId: batchId, referenceDate: "2026-10-06", selectionFingerprint: "f".repeat(64),
          counts: { selected: selected.length, ready: 2, needsReview: 0, excluded: selected.length - 2, uniqueGroups: 2, alreadyActive: 0 },
          items: selected.map((rowNumber, index) => ({ rowNumber, expectedRowVersion: 1, state: index < 2 ? "ready" : "excluded",
            reasonCode: index < 2 ? null : "REGON_REQUIRED", alreadyActive: false })) };
      } else if (url.pathname === `/api/imports/${batchId}/run-submissions` && method === "POST") {
        createRequest = { headers: request.headers(), body: request.postDataJSON() };
        body = { submissionId, status: "queued", version: 1 };
      } else if (url.pathname === `/api/run-submissions/${submissionId}` && method === "GET") {
        body = { submissionId, importBatchId: batchId, toolId: "oc-policy-verification", referenceDate: "2026-10-06",
          status: cancelled ? "cancelled" : "queued", version: cancelled ? 2 : 1,
          counts: { selectedRows: 3, uniqueGroups: 2, items: { review: 0, excluded: 1, waiting: cancelled ? 0 : 1, running: 0, waiting_attention: 1, completed: 0, no_matching_policies: 0, failed: 0, cancelled: cancelled ? 1 : 0, blocked: 0 },
            groups: { pending: 0, waiting: cancelled ? 0 : 1, accepted: 1, blocked: 0, cancelled: cancelled ? 1 : 0, completed: 0, no_matching_policies: 0, failed: 0, waiting_attention: 1, running: 0 } },
          createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:01:00.000Z" };
      } else if (url.pathname === `/api/run-submissions/${submissionId}/items` && method === "GET") {
        body = { items: [
          { itemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceRowId: "11111111-1111-4111-8111-111111111111", rowNumber: 2,
            expectedRowVersion: 1, preparationState: "ready", reasonCode: null, groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", admissionState: "accepted", groupReason: null, runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", runStatus: cancelled ? "cancelled" : "waiting_for_sms", runErrorCode: null },
          { itemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sourceRowId: "22222222-2222-4222-8222-222222222222", rowNumber: 3,
            expectedRowVersion: 1, preparationState: "ready", reasonCode: null, groupId: "ffffffff-ffff-4fff-8fff-ffffffffffff", admissionState: cancelled ? "cancelled" : "waiting_capacity", groupReason: "HOURLY_RUN_LIMIT", runId: null, runStatus: null, runErrorCode: null },
          { itemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sourceRowId: "33333333-3333-4333-8333-333333333333", rowNumber: 4,
            expectedRowVersion: 1, preparationState: "excluded", reasonCode: "REGON_REQUIRED", groupId: null, admissionState: null, groupReason: null, runId: null, runStatus: null, runErrorCode: null },
        ], nextCursor: null };
      } else if (url.pathname === `/api/run-submissions/${submissionId}/cancel` && method === "POST") {
        cancelRequest = { headers: request.headers(), body: request.postDataJSON() };
        cancelled = true;
        body = { submissionId, status: "cancelled", version: 2, acceptedRunsContinue: true };
      } else {
        status = 404; body = { message: `Unexpected synthetic API request: ${url.pathname}` };
      }
      await route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });
    });

    await page.goto(`${base}/tools/oc-policy-verification?import=${batchId}`);
    await page.getByRole("heading", { name: "Sprawdź wiele wierszy" }).waitFor({ state: "visible" });
    const launcher = page.locator(".submission-launcher");
    await launcher.getByLabel("Od wiersza (zakres partii)").fill("2");
    await launcher.getByLabel("Do wiersza (zakres partii)").fill("4");
    await page.getByRole("button", { name: "Pokaż podsumowanie" }).click();
    await page.getByRole("heading", { name: /Podsumowanie/ }).waitFor({ state: "visible" });
    await page.getByText("Osobne zadania").waitFor({ state: "visible" });
    assert.equal(previews[0].headers["x-csrf-token"], csrfToken);
    assert.deepEqual(previews[0].body, { fromRow: 2, toRow: 4 });
    const confirm = page.getByRole("button", { name: "Potwierdź i uruchom gotowe wiersze" });
    assert.equal(await confirm.isDisabled(), true, "wymagane jest osobne potwierdzenie podsumowania");

    await launcher.getByRole("button", { name: "Lista numerów" }).click();
    await launcher.getByLabel("Numery wierszy z Excela").fill("2, 2");
    await launcher.getByRole("button", { name: "Pokaż podsumowanie" }).click();
    await page.getByRole("alert").getByText(/Numery muszą być różne/).waitFor({ state: "visible" });
    assert.equal(previews.length, 1, "zduplikowane numery są odrzucane przed wysłaniem do API");
    await launcher.getByLabel("Numery wierszy z Excela").fill("2, 3, 4");
    await launcher.getByRole("button", { name: "Pokaż podsumowanie" }).click();
    await page.getByRole("heading", { name: /Podsumowanie/ }).waitFor({ state: "visible" });
    assert.deepEqual(previews[1].body, { rowNumbers: [2, 3, 4] });
    await page.getByLabel(/Rozumiem podsumowanie/).check();
    await confirm.click();
    await page.getByRole("heading", { name: "Stan zgłoszenia" }).waitFor({ state: "visible" });
    assert.equal(createRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(createRequest?.body, { rowNumbers: [2, 3, 4], selectionFingerprint: "f".repeat(64), idempotencyKey: createRequest?.body.idempotencyKey });
    assert.match(createRequest?.body.idempotencyKey ?? "", /^[0-9a-f-]{36}$/i);
    await page.getByText("Wymaga uwagi", { exact: true }).first().waitFor({ state: "visible" });
    await page.getByText("Wiersz 2", { exact: true }).waitFor({ state: "visible" });
    for (const width of [320, 375, 390, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `widok ${width}px nie przewija całej strony poziomo`);
    }
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Anuluj oczekujące" }).click();
    await page.getByRole("heading", { name: "Anulowano" }).waitFor({ state: "visible" });
    assert.equal(cancelRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(cancelRequest?.body, { expectedVersion: 1 });
    await page.reload();
    await page.getByRole("heading", { name: "Anulowano" }).waitFor({ state: "visible" });
    assert.deepEqual(errors, [], "brak błędów JavaScript w przeglądarce");

    console.log("RUN_SUBMISSION_UI_SMOKE_PASS previewRange=true previewList=true duplicateRejected=true explicitConfirmation=true csrf=true idempotency=true statusItems=true cancelCAS=true reloadPersists=true responsive320_1920=true syntheticOnly=true");
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("RUN_SUBMISSION_UI_SMOKE_FAILED", error?.message ?? "unknown"); process.exitCode = 1; });
