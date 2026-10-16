const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const batchId = "33333333-3333-4333-8333-333333333333";
const submissionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const setExecutionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const runId = "22222222-2222-4222-8222-222222222222";
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
    let preparationStarted = false;
    let workflowStarted = false;
    let workflowCancelled = false;
    let workflowStartRequest = null;
    let workflowCancelRequest = null;
    let wholeStartRequest = null;
    let wholePauseRequest = null;
    let wholeResumeRequest = null;
    let wholeCancelRequest = null;
    let wholeExecutionStarted = false;
    let wholeExecutionCancelled = false;
    let wholeExecutionPaused = false;
    let wholeExecutionResumed = false;
    let runControlState = "running";
    let runControlRevision = 0;
    let runPauseRequest = null;
    let runResumeRequest = null;
    let runListRequestCount = 0;
    const runView = () => ({ id: runId, batchId, rowNumber: 18001, toolId: "oc-policy-verification",
      status: "compensa_form", currentStep: "compensa_form", referenceDate: "2026-10-06", errorCode: null,
      controlState: runControlState, controlRevision: String(runControlRevision),
      controlAckRevision: String(runControlState === "paused" ? runControlRevision : runControlRevision - (runControlState === "pause_requested" ? 1 : 0)),
      controlCheckpointStatus: runControlState === "paused" ? "compensa_form" : null,
      createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:01.000Z" });
    const preparationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const workflowId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const prepared = { preparationId, batchId, revision: 1, rulesVersion: "preparation-v1",
      sourceFingerprint: "a".repeat(64), status: "completed_with_attention", stage: "sealed", totalRows: 3,
      counts: { ready: 2, review: 0, skippedNoIdentifiers: 0, duplicates: 1, waitingRegistry: 0 },
      version: 2, errorCode: null, createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:01.000Z",
      finishedAt: "2026-10-06T10:00:01.000Z", sealedAt: "2026-10-06T10:00:01.000Z" };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let status = 200;
      let body = {};
      if (url.pathname === "/api/auth/me") {
        body = { role: "manager", username: "synthetic.manager", csrfToken, mustChangePassword: false,
          tools: [{ toolId: "oc-policy-verification", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }] };
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
      } else if (url.pathname === `/api/imports/${batchId}/preparations` && method === "GET") {
        body = { preparations: preparationStarted ? [prepared] : [] };
      } else if (url.pathname === `/api/imports/${batchId}/preparation-workflows`) {
        body = { workflows: workflowStarted ? [{ workflowId, batchId, sourcePreparationId: preparationId,
          status: workflowCancelled ? "cancelled" : "waiting_registry", version: workflowCancelled ? 4 : 3,
          reanalysisPreparationId: null, errorCode: null, createdAt: "2026-10-06T10:00:02.000Z",
          updatedAt: "2026-10-06T10:00:03.000Z", finishedAt: workflowCancelled ? "2026-10-06T10:00:03.000Z" : null,
          registryJobs: [], reanalysis: null }] : [] };
      } else if (url.pathname === `/api/imports/${batchId}/preparations` && method === "POST") {
        preparationStarted = true;
        body = { ...prepared, status: "queued", version: 1, finishedAt: null, sealedAt: null };
      } else if (url.pathname === `/api/imports/${batchId}/preparations/${preparationId}/workflow` && method === "POST") {
        workflowStartRequest = { headers: request.headers(), body: request.postDataJSON() };
        workflowStarted = true;
        body = { workflowId, batchId, sourcePreparationId: preparationId, status: "queued", version: 2,
          reanalysisPreparationId: null, errorCode: null, createdAt: "2026-10-06T10:00:02.000Z",
          updatedAt: "2026-10-06T10:00:02.000Z", finishedAt: null };
      } else if (url.pathname === `/api/imports/${batchId}/preparation-workflows/${workflowId}/cancel` && method === "POST") {
        workflowCancelRequest = { headers: request.headers(), body: request.postDataJSON() };
        workflowCancelled = true;
        body = { workflowId, batchId, sourcePreparationId: preparationId, status: "cancelled", version: 4,
          reanalysisPreparationId: null, errorCode: null, createdAt: "2026-10-06T10:00:02.000Z",
          updatedAt: "2026-10-06T10:00:03.000Z", finishedAt: "2026-10-06T10:00:03.000Z" };
      } else if (url.pathname === `/api/imports/${batchId}/prepared-set-executions/preview` && method === "GET") {
        body = { batchId, preparationId, revision: 1, snapshotFingerprint: "a".repeat(64), totalRows: 3,
          referenceDate: "2026-10-06", counts: { ready: 2, review: 0, duplicates: 1, skippedNoIdentifiers: 0, waitingRegistry: 0 } };
      } else if (url.pathname === `/api/imports/${batchId}/prepared-set-executions` && method === "POST") {
        wholeStartRequest = { headers: request.headers(), body: request.postDataJSON() };
        wholeExecutionStarted = true;
        body = { executionId: setExecutionId, status: "queued", version: 1, referenceDate: "2026-10-06", totalRows: 3,
          chunkCount: 0, progress: { generatedChunks: 0, completedChunks: 0, activeChunks: 0, waitingChunks: 0, failedChunks: 0, cancelledChunks: 0 }, errorCode: null };
      } else if (url.pathname === `/api/imports/${batchId}/prepared-set-executions/${setExecutionId}` && method === "GET") {
        const afterOrdinal = Number(url.searchParams.get("afterOrdinal") ?? 0);
        const chunks = afterOrdinal >= 20
          ? [{ ordinal: 21, firstRowNumber: 402, lastRowNumber: 421, rowCount: 20, status: "running", childSubmissionId: "synthetic-child-21", finishedAt: null }]
          : Array.from({ length: 20 }, (_, index) => ({ ordinal: index + 1, firstRowNumber: 2 + index * 20,
            lastRowNumber: 21 + index * 20, rowCount: 20, status: "running", childSubmissionId: `synthetic-child-${index + 1}`, finishedAt: null }));
        body = { executionId: setExecutionId, status: wholeExecutionCancelled ? "cancelled" : wholeExecutionPaused ? "paused" : "queued",
          version: wholeExecutionCancelled ? 5 : wholeExecutionPaused ? 2 : wholeExecutionResumed ? 3 : 1,
          referenceDate: "2026-10-06", totalRows: 420, chunkCount: 21,
          progress: { generatedChunks: 21, completedChunks: 0, activeChunks: 1, waitingChunks: 0, failedChunks: 0, cancelledChunks: 0 },
          chunks, chunkPage: { nextAfterOrdinal: afterOrdinal >= 20 ? null : 20 }, errorCode: null };
      } else if (url.pathname === `/api/imports/${batchId}/prepared-set-executions/${setExecutionId}/pause` && method === "POST") {
        wholePauseRequest = { headers: request.headers(), body: request.postDataJSON() };
        wholeExecutionPaused = true;
        body = { executionId: setExecutionId, status: "paused", version: 2, referenceDate: "2026-10-06", totalRows: 3,
          chunkCount: 1, progress: { generatedChunks: 1, completedChunks: 0, activeChunks: 0, waitingChunks: 0, failedChunks: 0, cancelledChunks: 0 }, errorCode: null };
      } else if (url.pathname === `/api/imports/${batchId}/prepared-set-executions/${setExecutionId}/resume` && method === "POST") {
        wholeResumeRequest = { headers: request.headers(), body: request.postDataJSON() };
        wholeExecutionPaused = false;
        wholeExecutionResumed = true;
        body = { executionId: setExecutionId, status: "queued", version: 3, referenceDate: "2026-10-06", totalRows: 3,
          chunkCount: 1, progress: { generatedChunks: 1, completedChunks: 0, activeChunks: 1, waitingChunks: 0, failedChunks: 0, cancelledChunks: 0 }, errorCode: null };
      } else if (url.pathname === `/api/imports/${batchId}/prepared-set-executions/${setExecutionId}/cancel` && method === "POST") {
        wholeCancelRequest = { headers: request.headers(), body: request.postDataJSON() };
        wholeExecutionCancelled = true;
        body = { executionId: setExecutionId, status: "cancelled", version: 5, referenceDate: "2026-10-06", totalRows: 3,
          chunkCount: 1, progress: { generatedChunks: 1, completedChunks: 0, activeChunks: 0, waitingChunks: 0, failedChunks: 0, cancelledChunks: 1 }, errorCode: null };
      } else if (url.pathname === `/api/imports/${batchId}/preparations/${preparationId}/rows`) {
        body = { preparationId, status: prepared.status, page: 1, pageSize: 50, total: 3, rows: [
          { rowNumber: 2, sourceRowId: "11111111-1111-4111-8111-111111111111", expectedRowVersion: 1,
            status: "ready", reasonCode: null, representativeRowNumber: null, normalizedName: "Firma syntetyczna Alfa",
            normalizedNip: "5260250275", effectiveRegon: "123456789", regonProvenance: "import" },
          { rowNumber: 3, sourceRowId: "22222222-2222-4222-8222-222222222222", expectedRowVersion: 1,
            status: "ready", reasonCode: null, representativeRowNumber: null, normalizedName: "Firma syntetyczna Beta",
            normalizedNip: "5260250275", effectiveRegon: "987654321", regonProvenance: "import" },
          { rowNumber: 4, sourceRowId: "33333333-3333-4333-8333-333333333333", expectedRowVersion: 1,
            status: "duplicate", reasonCode: "DUPLICATE_SOURCE_ROW", representativeRowNumber: 2,
            normalizedName: "Firma syntetyczna Alfa", normalizedNip: "5260250275", effectiveRegon: "123456789", regonProvenance: "import" },
        ] };
      } else if (url.pathname === `/api/imports/${batchId}/enrichment`) {
        body = { page: 1, pageSize: 50, totalRows: 0,
          summary: { missingRegonRows: 0, pendingCorrectionRows: 0, openConflictRows: 0, lookupStatuses: {} }, rows: [] };
      } else if (url.pathname === "/api/runs" && url.searchParams.get("batchId") === batchId) {
        runListRequestCount += 1;
        body = [runView()];
      } else if (url.pathname === `/api/runs/${runId}` && method === "GET") {
        if (runControlState === "pause_requested") runControlState = "paused";
        body = runView();
      } else if (url.pathname === `/api/runs/${runId}/pause` && method === "POST") {
        runPauseRequest = { headers: request.headers(), body: request.postDataJSON() };
        runControlRevision += 1;
        runControlState = "pause_requested";
        body = runView();
      } else if (url.pathname === `/api/runs/${runId}/resume` && method === "POST") {
        runResumeRequest = { headers: request.headers(), body: request.postDataJSON() };
        runControlRevision += 1;
        runControlState = "running";
        body = runView();
      } else if (url.pathname === `/api/imports/${batchId}/run-submissions/preview` && method === "POST") {
        previews.push({ headers: request.headers(), body: request.postDataJSON() });
        const selected = request.postDataJSON().rowNumbers ?? Array.from(
          { length: request.postDataJSON().toRow - request.postDataJSON().fromRow + 1 },
          (_, index) => request.postDataJSON().fromRow + index,
        );
        body = { importBatchId: batchId, referenceDate: "2026-10-06", selectionFingerprint: "f".repeat(64),
          counts: { selected: selected.length, ready: 2, needsReview: 0, excluded: selected.length - 2, uniqueGroups: 2, alreadyActive: 0 },
          items: selected.map((rowNumber, index) => ({ rowNumber, expectedRowVersion: 1, state: index < 2 ? "ready" : "excluded",
            reasonCode: index < 2 ? null : "DUPLICATE_SOURCE_ROW", alreadyActive: false })) };
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
            expectedRowVersion: 1, preparationState: "excluded", reasonCode: "DUPLICATE_SOURCE_ROW", groupId: null, admissionState: null, groupReason: null, runId: null, runStatus: null, runErrorCode: null },
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
    const preparationPanels = page.locator(".import-preparation");
    const preparation = preparationPanels.last();
    await preparation.getByRole("heading", { name: "Przygotowanie i deduplikacja" }).waitFor({ state: "visible" });
    await preparation.getByText("Przygotuj import, aby sprawdzić duplikaty", { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.locator(".submission-launcher").count(), 0, "automatyzacja pozostaje zablokowana przed analizą importu");
    preparationStarted = true;
    await page.reload();
    const preparedPanel = page.locator(".import-preparation").last();
    await preparedPanel.getByText("Gotowe z uwagami", { exact: true }).waitFor({ state: "visible" });
    await preparedPanel.getByText("Reprezentant: wiersz 2", { exact: true }).waitFor({ state: "visible" });
    const preparationExport = preparedPanel.getByRole("link", { name: /Pobierz Excel z zestawem roboczym i mapą decyzji/ });
    await preparationExport.waitFor({ state: "visible" });
    assert.equal(await preparationExport.getAttribute("href"), `/api/imports/${batchId}/preparations/${preparationId}/export`);
    assert.equal(preparationStarted, true, "najnowsza zamknięta rewizja jest odczytywana z API");
    prepared.counts.waitingRegistry = 1;
    await page.reload();
    const automationPanel = page.locator(".import-preparation").last();
    const startWorkflow = automationPanel.getByRole("button", { name: "Uruchom lookup REGON i ponowną analizę" });
    await startWorkflow.waitFor({ state: "visible" });
    await startWorkflow.click();
    await automationPanel.locator(".preparation-workflow").getByText("Uzupełniam REGON", { exact: true }).waitFor({ state: "visible" });
    assert.equal(workflowStartRequest?.headers["x-csrf-token"], csrfToken);
    assert.match(workflowStartRequest?.body.idempotencyKey ?? "", /^[0-9a-f-]{36}$/i);
    await automationPanel.getByRole("button", { name: "Anuluj cały proces" }).click();
    await automationPanel.locator(".preparation-workflow").getByText("Anulowano", { exact: true }).waitFor({ state: "visible" });
    assert.equal(workflowCancelRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(workflowCancelRequest?.body, { expectedVersion: 3 });
    await page.locator(".run-list button").first().waitFor({ state: "visible", timeout: 10_000 }).catch(async () => {
      const visibleText = (await page.locator("body").innerText()).slice(-1200);
      throw new Error(`RUN_LIST_MISSING requests=${runListRequestCount} text=${visibleText}`);
    });
    await page.locator(".run-list button").first().click();
    await page.getByRole("heading", { name: /Wiersz 18001: Uzupełnianie formularza Compensy/ }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Wstrzymaj po bieżącej akcji" }).click();
    await page.getByText(/Wstrzymywanie po bieżącej akcji portalu/).waitFor({ state: "visible" });
    await page.getByText(/Zadanie wstrzymano przy bezpiecznym punkcie/).waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(runPauseRequest?.headers["x-csrf-token"], csrfToken);
    assert.equal(runPauseRequest?.body.expectedRevision, "0");
    assert.match(runPauseRequest?.body.idempotencyKey ?? "", /^run-control-[0-9a-f-]{36}$/i);
    await page.getByRole("button", { name: "Wznów zadanie" }).click();
    await page.getByRole("button", { name: "Wstrzymaj po bieżącej akcji" }).waitFor({ state: "visible" });
    assert.equal(runResumeRequest?.headers["x-csrf-token"], csrfToken);
    assert.equal(runResumeRequest?.body.expectedRevision, "1");
    assert.match(runResumeRequest?.body.idempotencyKey ?? "", /^run-control-[0-9a-f-]{36}$/i);
    assert.notEqual(runResumeRequest?.body.idempotencyKey, runPauseRequest?.body.idempotencyKey);
    await page.getByRole("heading", { name: "Sprawdź wiele wierszy" }).waitFor({ state: "visible" });
    const launcher = page.locator(".submission-launcher");
    await launcher.getByRole("button", { name: "Pokaż podsumowanie całego importu" }).click();
    await launcher.getByRole("heading", { name: /Rewizja 1/ }).waitFor({ state: "visible" });
    await launcher.getByText("Duplikaty", { exact: true }).waitFor({ state: "visible" });
    const wholeConfirm = launcher.getByLabel(/Potwierdzam uruchomienie wszystkich 2 gotowych wierszy/);
    await wholeConfirm.check();
    await launcher.getByRole("button", { name: "Potwierdź i uruchom cały import" }).click();
    await launcher.getByText(/Cały import · w kolejce/).waitFor({ state: "visible" });
    assert.equal(wholeStartRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(wholeStartRequest?.body, { idempotencyKey: wholeStartRequest?.body.idempotencyKey,
      preparationId, snapshotFingerprint: "a".repeat(64) });
    assert.match(wholeStartRequest?.body.idempotencyKey ?? "", /^[0-9a-f-]{36}$/i);
    await launcher.locator(".prepared-set-chunks li").last().getByText("Porcja 20", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await launcher.locator(".prepared-set-chunks li").count(), 20);
    await launcher.getByRole("button", { name: "Pokaż kolejne porcje" }).click();
    await launcher.locator(".prepared-set-chunks li").getByText("Porcja 21", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await launcher.locator(".prepared-set-chunks li").count(), 1, "UI pobiera następną stronę zamiast wszystkich porcji");
    await launcher.getByRole("button", { name: "Pokaż pierwsze porcje" }).click();
    await launcher.locator(".prepared-set-chunks li").getByText("Porcja 1", { exact: true }).waitFor({ state: "visible" });
    await launcher.getByRole("button", { name: "Wstrzymaj po bieżącej porcji" }).click();
    await launcher.getByText(/Cały import · wstrzymany/).waitFor({ state: "visible" });
    assert.equal(wholePauseRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(wholePauseRequest?.body, { expectedVersion: 1 });
    await launcher.getByRole("button", { name: "Wznów import" }).click();
    await launcher.getByText(/Cały import · w kolejce/).waitFor({ state: "visible" });
    assert.equal(wholeResumeRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(wholeResumeRequest?.body, { expectedVersion: 2 });
    await launcher.getByRole("button", { name: "Anuluj cały zestaw" }).click();
    await launcher.getByText(/Cały import · anulowany/).waitFor({ state: "visible" });
    assert.equal(wholeCancelRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(wholeCancelRequest?.body, { expectedVersion: 3 });
    await launcher.getByLabel("Od wiersza (zakres partii)").fill("2");
    await launcher.getByLabel("Do wiersza (zakres partii)").fill("4");
    await page.getByRole("button", { name: "Pokaż podsumowanie" }).click();
    await page.getByRole("heading", { name: /Podsumowanie/ }).waitFor({ state: "visible" });
    await page.getByText("Osobne zadania").waitFor({ state: "visible" });
    await page.getByText(/duplikat — pominięty w zestawie roboczym/i).waitFor({ state: "visible" });
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

    console.log("RUN_SUBMISSION_UI_SMOKE_PASS managerRole=true preparationWorkflowStart=true preparationExportLink=true workflowCancelCAS=true wholeSetPreview=true wholeSetStart=true wholeSetPauseResume=true wholeSetCancel=true runPauseResumeCAS=true runControlIdempotency=true previewRange=true previewList=true duplicateRejected=true explicitConfirmation=true csrf=true idempotency=true statusItems=true cancelCAS=true reloadPersists=true responsive320_1920=true syntheticOnly=true");
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("RUN_SUBMISSION_UI_SMOKE_FAILED", error?.message ?? "unknown"); process.exitCode = 1; });
