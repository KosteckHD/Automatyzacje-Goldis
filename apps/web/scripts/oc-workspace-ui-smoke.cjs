const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const batchId = "33333333-3333-4333-8333-333333333333";
const otherBatchId = "44444444-4444-4444-8444-444444444444";
const preparationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const submissionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mismatchedSubmissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mismatchedResultSetId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const mismatchedRunId = "99999999-9999-4999-8999-999999999999";
const csrfToken = "synthetic-csrf-token-for-oc-workspace-ui-smoke-123456";
const probe = createServer();

function contrastRatio(foreground, background) {
  const luminance = (value) => {
    const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    assert.equal(channels?.length, 3, `nieobsługiwany kolor CSS: ${value}`);
    const [red, green, blue] = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

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
    await new Promise((delay) => setTimeout(delay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

async function main() {
  const listenPort = await port();
  const base = `http://127.0.0.1:${listenPort}`;
  const evidenceDir = resolve(__dirname, "../../..", "output", "acceptance", "oc-8-screens-2026-10-21");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(listenPort)], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(listenPort) },
  });
  let browser;
  try {
    await waitForServer(base, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    const writes = [];
    let previewRequest = null;
    let startRequest = null;
    let submissionCancelled = false;
    let submissionStatus = "queued";
    let submissionVersion = 1;
    const admissionControls = [];
    let mismatchedSubmissionItemsRequests = 0;
    let mismatchedResultRowsRequests = 0;
    let mismatchedRunBatchRequests = 0;
    const submissionSnapshot = () => ({ submissionId, importBatchId: batchId, toolId: "oc-policy-verification", referenceDate: "2026-10-06",
      resultSetId: submissionId, status: submissionCancelled ? "cancelled" : submissionStatus, version: submissionVersion,
      counts: { selectedRows: 2, uniqueGroups: 2, items: { review: 0, excluded: 0, waiting: 2, running: 0, waiting_attention: 0, completed: 0, no_matching_policies: 0, failed: 0, cancelled: submissionCancelled ? 2 : 0, blocked: 0 }, groups: { pending: 0, waiting: 2, accepted: 0, blocked: 0, cancelled: submissionCancelled ? 2 : 0, completed: 0, no_matching_policies: 0, failed: 0, waiting_attention: 0, running: 0 } }, createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z" });
    const preparation = { preparationId, batchId, revision: 1, rulesVersion: "preparation-v1", sourceFingerprint: "a".repeat(64),
      status: "completed_with_attention", stage: "sealed", totalRows: 4,
      counts: { ready: 3, review: 0, skippedNoIdentifiers: 0, duplicates: 1, waitingRegistry: 0 },
      version: 2, errorCode: null, createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:01.000Z",
      finishedAt: "2026-10-06T10:00:01.000Z", sealedAt: "2026-10-06T10:00:01.000Z" };
    const preparedCompanies = Array.from({ length: 61 }, (_, index) => ({
      rowNumber: index + 2,
      sourceRowId: `${String(index + 1).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      expectedRowVersion: 1, status: index === 4 ? "duplicate" : "ready",
      reasonCode: index === 4 ? "DUPLICATE_SOURCE_ROW" : null,
      representativeRowNumber: index === 4 ? 2 : null,
      companyName: `Firma syntetyczna ${index + 1}`,
      normalizedName: `firma syntetyczna ${index + 1}`,
      normalizedNip: String(index + 1).padStart(10, "0"),
      effectiveRegon: String(index + 1).padStart(9, "0"), regonProvenance: "import",
    }));
    const enrichmentReview = { page: 1, pageSize: 50, totalRows: 240,
      summary: { missingRegonRows: 18, pendingCorrectionRows: 4, openConflictRows: 1, lookupStatuses: { matched: 12, not_found: 2 } },
      rows: [
        { rowNumber: 14, companyName: "Transport Alfa", decisionMakerName: null, regonRaw: "", effectiveRegon: null, rowVersion: 1, issues: ["REGON_EMPTY"], state: "missing_regon", source: "missing", correction: null, lookup: null, conflict: null },
        { rowNumber: 28, companyName: "Logistyka Beta", decisionMakerName: null, regonRaw: "", effectiveRegon: null, rowVersion: 1, issues: ["REGON_EMPTY"], state: "correction_pending", source: "missing", correction: { correctionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", proposedRegon: "987654321", status: "pending", reason: "Potwierdzenie danych z dokumentu firmy", createdAt: "2026-10-06T10:00:00.000Z" }, lookup: null, conflict: null },
        { rowNumber: 61, companyName: "Transport Delta", decisionMakerName: null, regonRaw: "123456789", effectiveRegon: "123456789", rowVersion: 2, issues: [], state: "conflict", source: "import", correction: null, lookup: null, conflict: { reasonCode: "SAME_NIP_DIFFERENT_REGON", candidateCount: 2, createdAt: "2026-10-06T10:00:00.000Z" } },
      ] };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (method !== "GET") writes.push({ method, path: url.pathname });
      let status = 200;
      let body = {};
      if (url.pathname === "/api/auth/me") {
        body = { role: "manager", username: "synthetic.manager", tenantId: "99999999-9999-4999-8999-999999999999", userId: "88888888-8888-4888-8888-888888888888", csrfToken, mustChangePassword: false,
          tools: [{ toolId: "oc-policy-verification", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }] };
      } else if (url.pathname === "/api/health/automation") {
        body = { automationReady: true, servicesReady: true, worker: "ready", portalMode: "live", portalConfig: "ready", message: "Syntetyczne środowisko testowe gotowe." };
      } else if (url.pathname === "/api/health/enrichment") {
        body = { status: "not_ready", available: false, worker: "offline", provider: "disabled", providerName: null, message: "Lookup wyłączony w środowisku testowym." };
      } else if (url.pathname === "/api/interventions/summary") {
        body = { openCount: 0, unreadCount: 0, smsCount: 0 };
      } else if (url.pathname === "/api/interventions") {
        body = { items: [], nextCursor: null };
      } else if (url.pathname === `/api/imports/${batchId}`) {
        body = { id: batchId, totalRows: 4, invalidRows: 1, readyRows: 3, sha256: "a".repeat(64) };
      } else if (url.pathname === `/api/imports/${batchId}/rows`) {
        body = [
          { rowNumber: 2, companyName: "Firma syntetyczna Alfa", decisionMakerName: "Osoba testowa", regon: "123456789", issues: [] },
          { rowNumber: 3, companyName: "Firma syntetyczna Beta", decisionMakerName: null, regon: "987654321", issues: [] },
          { rowNumber: 4, companyName: "Firma syntetyczna Gamma", decisionMakerName: null, regon: "123456780", issues: [] },
          { rowNumber: 5, companyName: "Firma syntetyczna Delta", decisionMakerName: null, regon: "", issues: ["REGON_EMPTY"] },
        ];
      } else if (url.pathname === `/api/imports/${batchId}/rows/search`) {
        const allRows = [
            { rowNumber: 2, companyName: "Firma syntetyczna Alfa", decisionMakerName: "Osoba testowa", regon: "123456789", issues: [] },
            { rowNumber: 3, companyName: "Firma syntetyczna Beta", decisionMakerName: null, regon: "987654321", issues: [] },
            { rowNumber: 4, companyName: "Firma syntetyczna Gamma", decisionMakerName: null, regon: "123456780", issues: [] },
            { rowNumber: 5, companyName: "Firma syntetyczna Delta", decisionMakerName: null, regon: "", issues: ["REGON_EMPTY"] },
          ];
        const filtered = allRows.filter((row) => !url.searchParams.get("q") || row.companyName.toLowerCase().includes(url.searchParams.get("q").toLowerCase()));
        body = { page: 1, pageSize: 50, total: filtered.length, pageCount: 1, state: url.searchParams.get("state") ?? "all", search: url.searchParams.get("q") ?? "", issueCode: null,
          counts: { matching: filtered.length, ready: filtered.filter((row) => !row.issues.length).length, review: filtered.filter((row) => row.issues.length > 0).length, all: 4 }, rows: filtered };
      } else if (url.pathname.startsWith(`/api/imports/${otherBatchId}`)) {
        mismatchedRunBatchRequests += 1;
        status = 404;
        body = { message: "Unexpected synthetic import request for mismatched run" };
      } else if (url.pathname === `/api/runs/${mismatchedRunId}`) {
        body = { id: mismatchedRunId, batchId: otherBatchId, rowNumber: 99, toolId: "oc-policy-verification", status: "completed",
          currentStep: "completed", referenceDate: "2026-10-06", errorCode: null, manualDataVersion: 0,
          createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:01.000Z" };
      } else if (url.pathname === `/api/imports/${batchId}/enrichment`) {
        body = enrichmentReview;
      } else if (url.pathname === `/api/imports/${batchId}/enrichment-jobs`) {
        body = { items: [] };
      } else if (url.pathname === `/api/imports/${batchId}/preparations`) {
        body = { preparations: [preparation] };
      } else if (url.pathname === `/api/imports/${batchId}/preparation-workflows`) {
        body = { workflows: [] };
      } else if (url.pathname === `/api/imports/${batchId}/preparations/${preparationId}/rows`) {
        const query = url.searchParams.get("q")?.toLowerCase() ?? "";
        const filtered = preparedCompanies.filter((row) => !query || [row.companyName, row.normalizedNip, row.effectiveRegon, String(row.rowNumber)].some((value) => value.toLowerCase().includes(query)));
        const currentPage = Number(url.searchParams.get("page") ?? "1");
        body = { preparationId, status: preparation.status, page: currentPage, pageSize: 50, total: filtered.length, search: query,
          rows: filtered.slice((currentPage - 1) * 50, currentPage * 50) };
      } else if (url.pathname === `/api/runs` && url.searchParams.get("batchId") === batchId) {
        body = [];
      } else if (url.pathname === `/api/imports/${batchId}/run-submissions/preview` && method === "POST") {
        previewRequest = { headers: request.headers(), body: request.postDataJSON() };
        const selectedRows = previewRequest.body.rowNumbers ?? Array.from({ length: previewRequest.body.toRow - previewRequest.body.fromRow + 1 }, (_, index) => previewRequest.body.fromRow + index);
        body = { importBatchId: batchId, referenceDate: "2026-10-06", selectionFingerprint: "f".repeat(64),
          preparationId, counts: { selected: selectedRows.length, ready: selectedRows.length, needsReview: 0, excluded: 0, uniqueGroups: selectedRows.length, alreadyActive: 0 },
          items: selectedRows.map((rowNumber) => {
            const row = preparedCompanies.find((item) => item.rowNumber === rowNumber);
            return { sourceRowId: row.sourceRowId, rowNumber, companyName: row.companyName, nip: row.normalizedNip, effectiveRegon: row.effectiveRegon, expectedRowVersion: 1, state: "ready", reasonCode: null, alreadyActive: false };
          }) };
      } else if (url.pathname === `/api/imports/${batchId}/run-submissions` && method === "POST") {
        startRequest = { headers: request.headers(), body: request.postDataJSON() };
        body = { submissionId, status: "queued", version: 1 };
      } else if (url.pathname === `/api/run-submissions/${submissionId}`) {
        body = submissionSnapshot();
      } else if (url.pathname === `/api/run-submissions/${mismatchedSubmissionId}`) {
        body = { ...submissionSnapshot(), submissionId: mismatchedSubmissionId, importBatchId: otherBatchId, resultSetId: mismatchedResultSetId };
      } else if (url.pathname === `/api/run-submissions/${mismatchedSubmissionId}/items`) {
        mismatchedSubmissionItemsRequests += 1;
        body = { items: [], nextCursor: null };
      } else if (url.pathname === `/api/run-submissions/${submissionId}/items`) {
        body = { items: [2, 3].map((rowNumber) => ({ rowNumber, preparationState: "ready", reasonCode: null, runId: null, runStatus: null, runErrorCode: null })), nextCursor: null };
      } else if (url.pathname === `/api/run-submissions/${submissionId}/cancel` && method === "POST") {
        submissionCancelled = true;
        body = { submissionId, status: "cancelled", version: 2, acceptedRunsContinue: true };
      } else if (url.pathname === `/api/run-submissions/${submissionId}/pause` && method === "POST") {
        admissionControls.push({ action: "pause", headers: request.headers(), body: request.postDataJSON() });
        submissionStatus = "paused";
        submissionVersion += 1;
        body = submissionSnapshot();
      } else if (url.pathname === `/api/run-submissions/${submissionId}/resume` && method === "POST") {
        admissionControls.push({ action: "resume", headers: request.headers(), body: request.postDataJSON() });
        submissionStatus = "queued";
        submissionVersion += 1;
        body = submissionSnapshot();
      } else if (url.pathname === `/api/result-sets/${submissionId}/summary`) {
        body = { resultSetId: submissionId, sourceType: "run_submission", sourceId: submissionId, batchId,
          referenceDate: "2026-10-06", status: submissionStatus,
          counts: { rows: 2, uniqueGroups: 2, policyCount: 3, byStatus: { completed: 1, no_matching_policies: 1 } } };
      } else if (url.pathname === `/api/result-sets/${mismatchedResultSetId}/summary`) {
        body = { resultSetId: mismatchedResultSetId, sourceType: "run_submission", sourceId: mismatchedSubmissionId, batchId: otherBatchId,
          referenceDate: "2026-10-06", status: "completed", counts: { rows: 1, uniqueGroups: 1, policyCount: 0, byStatus: { completed: 1 } } };
      } else if (url.pathname === `/api/result-sets/${mismatchedResultSetId}/rows`) {
        mismatchedResultRowsRequests += 1;
        body = { items: [{ sourceRowId: "12121212-1212-4212-8212-121212121212", rowNumber: 2, companyName: "NIEWŁAŚCIWA FIRMA", status: "completed", reasonCode: null, runId: null, runStatus: null, policyCount: 0 }], nextCursor: null };
      } else if (url.pathname === `/api/result-sets/${submissionId}/rows`) {
        const resultRows = [
          { sourceRowId: "11111111-1111-4111-8111-111111111111", rowNumber: 2, companyName: "Firma syntetyczna Alfa", status: "completed", reasonCode: null, runId: "99999999-9999-4999-8999-999999999999", runStatus: "completed", policyCount: 3 },
          { sourceRowId: "22222222-2222-4222-8222-222222222222", rowNumber: 3, companyName: "Firma syntetyczna Beta", status: "no_matching_policies", reasonCode: null, runId: "88888888-8888-4888-8888-888888888888", runStatus: "no_matching_policies", policyCount: 0 },
        ];
        const filtered = resultRows.filter((row) => (!url.searchParams.get("q") || row.companyName.toLowerCase().includes(url.searchParams.get("q").toLowerCase()))
          && (!url.searchParams.get("status") || row.status === url.searchParams.get("status")));
        body = { items: filtered, nextCursor: null };
      } else {
        status = 404;
        body = { message: `Unexpected synthetic request: ${url.pathname}` };
      }
      await route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });
    });

    if (process.env.OC_AUTOMATION_WORKSPACE_ENABLED === "0") {
      await page.goto(`${base}/tools/oc-policy-verification`);
      await page.getByRole("heading", { name: "Weryfikacja danych transportowych", exact: true }).waitFor({ state: "visible" });
      assert.deepEqual(errors, [], "awaryjny widok nie zgłasza błędów JavaScript");
      console.log("OC_WORKSPACE_ROLLBACK_SMOKE_PASS serverFlag=0 legacyWorkspace=true syntheticOnly=true");
      return;
    }

    await page.goto(`${base}/tools/oc-policy-verification?import=${batchId}&step=validation`);
    const activeHeading = page.locator("#oc-active-step-heading");
    await activeHeading.getByText("Kontrola danych", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".oc-step-panel-content").getByText("Firma syntetyczna Alfa").waitFor({ state: "visible" });
    await page.locator(".oc-launcher-host").waitFor({ state: "attached", timeout: 10_000 });
    await page.getByLabel("Szukaj w danych").fill("Alfa");
    await page.waitForFunction(() => document.querySelectorAll(".oc-validation tbody tr").length === 1);
    await page.getByLabel("Szukaj w danych").fill("");
    await page.waitForFunction(() => document.querySelectorAll(".oc-validation tbody tr").length === 4);
    const expected = [
      ["upload", "Dodaj bazę transportową"], ["validation", "Kontrola danych"], ["regon", "Uzupełnianie REGON"],
      ["deduplication", "Deduplikacja"], ["selection", "Wybór wierszy"], ["launch", "Podsumowanie i start"],
      ["progress", "Przebieg zadań"], ["results", "Wyniki i eksport"],
    ];
    for (const [key, heading] of expected) {
      await page.locator(".oc-step-rail").locator(`a[href*="step=${key}"]`).click();
      await activeHeading.getByText(heading, { exact: true }).waitFor({ state: "visible" });
      if (key === "upload") {
        const uploadPanel = page.locator(".oc-upload-form");
        const importButton = uploadPanel.getByRole("button", { name: "Sprawdź i zaimportuj" });
        assert.equal(await importButton.isDisabled(), true, "import wymaga wybranego pliku");
        await uploadPanel.locator('input[type="file"]').setInputFiles({ name: "niepoprawny.csv", mimeType: "text/csv", buffer: Buffer.from("synthetic") });
        await page.getByRole("alert").getByText("Wybierz plik Excel w formacie .xlsx.", { exact: true }).waitFor({ state: "visible" });
        assert.equal(await importButton.isDisabled(), true, "nieprawidłowy format nie może uruchomić importu");
        const excelFile = { name: "baza_transportowa.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("synthetic-xlsx") };
        await uploadPanel.locator('input[type="file"]').setInputFiles(excelFile);
        await uploadPanel.locator(".oc-upload-file-ready").getByText("Plik wybrany").waitFor({ state: "visible" });
        assert.equal(await importButton.isEnabled(), true, "wybrany plik Excel odblokowuje import");
        await uploadPanel.getByRole("button", { name: "Usuń" }).click();
        assert.equal(await importButton.isDisabled(), true, "usunięcie pliku ponownie blokuje import");
        await uploadPanel.locator('input[type="file"]').setInputFiles(excelFile);
      }
      if (["upload", "validation", "regon", "deduplication"].includes(key))
        await page.screenshot({ path: resolve(evidenceDir, `0${expected.findIndex(([step]) => step === key) + 1}-${key}.png`), fullPage: true });
      assert.equal(writes.length, 0, `przejście do kroku ${key} nie wysyła żądania mutującego`);
    }
    await page.goBack();
    await activeHeading.getByText("Przebieg zadań", { exact: true }).waitFor({ state: "visible" });
    await page.goForward();
    await activeHeading.getByText("Wyniki i eksport", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".oc-step-rail").locator('a[href*="step=selection"]').click();
    const launcher = page.locator(".oc-operation");
    const companyRows = launcher.locator(".company-selection-row");
    await launcher.locator(".company-selection").waitFor({ state: "visible" });
    const searchStyles = await launcher.locator(".company-selection-search input").evaluate((input) => {
      const style = getComputedStyle(input);
      return { border: style.borderTopColor, background: style.backgroundColor, text: style.color,
        fontSize: Number.parseFloat(style.fontSize), height: input.getBoundingClientRect().height };
    });
    assert(contrastRatio(searchStyles.border, searchStyles.background) >= 3,
      `wyszukiwarka ma czytelną granicę kontrolki (${contrastRatio(searchStyles.border, searchStyles.background).toFixed(2)}:1)`);
    assert(contrastRatio(searchStyles.text, searchStyles.background) >= 4.5,
      `tekst wyszukiwarki spełnia kontrast tekstu (${contrastRatio(searchStyles.text, searchStyles.background).toFixed(2)}:1)`);
    assert(searchStyles.fontSize >= 12, "tekst kontrolki ma co najmniej 12 px");
    assert(searchStyles.height >= 44, "wyszukiwarka ma co najmniej 44 px wysokości");
    for (const [width, height] of [[1024, 768], [1366, 768]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false,
        `widok ${width}×${height} nie przewija strony poziomo`);
      assert.equal(await page.locator(".oc-step-rail").isVisible(), true, `nawigacja etapów jest widoczna przy ${width}×${height}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await companyRows.nth(0).locator('input[type="checkbox"]').check();
    await launcher.getByRole("button", { name: "Następna" }).click();
    await launcher.getByText("Firma syntetyczna 51", { exact: true }).waitFor({ state: "visible", timeout: 8_000 }).catch(async () => {
      throw new Error(`COMPANY_PAGE_TWO url=${page.url()} nav=${await launcher.locator(".company-selection-pages").innerText().catch(() => "missing")} list=${(await launcher.locator(".company-selection-list").innerText().catch(() => "missing")).slice(0, 1000)} errors=${JSON.stringify(errors)}`);
    });
    await companyRows.nth(0).locator('input[type="checkbox"]').check();
    await launcher.getByLabel(/Szukaj po nazwie/).fill("Firma syntetyczna 61");
    await launcher.getByText("Firma syntetyczna 61", { exact: true }).waitFor({ state: "visible" });
    await launcher.getByText("1 firm pasuje do wyszukiwania", { exact: true }).waitFor({ state: "visible" });
    await companyRows.nth(0).locator('input[type="checkbox"]').check();
    assert.equal(await launcher.getByText("3 / 500 wybranych", { exact: true }).count(), 1,
      `wybór zachowuje się między stronami i wyszukiwaniem: ${(await launcher.innerText()).slice(0, 1400)}`);
    await launcher.getByLabel(/Szukaj po nazwie/).fill("");
    await launcher.getByText("61 firm pasuje do wyszukiwania", { exact: true }).waitFor({ state: "visible" });
    await page.reload();
    await launcher.getByRole("heading", { name: "Wybierz wiersze do sprawdzenia", exact: true }).waitFor({ state: "visible" });
    await page.getByText("Przywrócono wybór. Przygotuj nowe podsumowanie przed startem.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await launcher.getByText("3 / 500 wybranych", { exact: true }).count(), 1, "wybór firm odtwarza się po przeładowaniu karty");
    assert.equal(await launcher.locator(".submission-confirm").count(), 0, "zgoda i podgląd nie są odtwarzane automatycznie");
    assert.equal(previewRequest, null, "odtworzenie szkicu nie wysyła podglądu ani startu");
    assert.equal(startRequest, null, "odtworzenie szkicu nie uruchamia zadań");
    assert.equal(writes.length, 0, "przejście i odtworzenie szkicu nie wysyłają żądań mutujących");
    await launcher.getByRole("button", { name: "Zakres lub numery wierszy" }).click();
    await launcher.getByLabel("Od wiersza", { exact: true }).fill("2");
    await launcher.getByLabel("Do wiersza", { exact: true }).fill("3");
    await launcher.getByRole("button", { name: "Wybierz firmy" }).click();
    await page.screenshot({ path: resolve(evidenceDir, "05-selection.png"), fullPage: true });
    await launcher.getByRole("button", { name: "Sprawdź podsumowanie (3)" }).click();
    await activeHeading.getByText("Podsumowanie i start", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Wybrane wiersze · data 2026-10-06", { exact: true }).waitFor({ state: "visible" });
    assert.equal(previewRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(previewRequest?.body, { rowNumbers: [2, 52, 62] });
    await launcher.getByLabel(/Rozumiem podsumowanie/).check();
    await page.screenshot({ path: resolve(evidenceDir, "06-launch.png"), fullPage: true });
    await launcher.getByRole("button", { name: "Potwierdź i uruchom gotowe wiersze" }).click();
    await activeHeading.getByText("Przebieg zadań", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Zgłoszenie · w kolejce", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(evidenceDir, "07-progress.png"), fullPage: true });
    assert.equal(startRequest?.headers["x-csrf-token"], csrfToken);
    const { idempotencyKey, ...submittedBody } = startRequest.body;
    assert.deepEqual(submittedBody, { rowNumbers: [2, 52, 62], selectionFingerprint: "f".repeat(64) });
    assert.match(idempotencyKey, /^[0-9a-f-]{36}$/i);
    await page.reload();
    await activeHeading.getByText("Przebieg zadań", { exact: true }).waitFor({ state: "visible" });
    await page.locator('.oc-step-rail .oc-step-link[href*="step=progress"] small').getByText("W kolejce", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".oc-step-rail").locator('a[href*="step=results"]').click();
    await activeHeading.getByText("Wyniki i eksport", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "Wyniki tej partii" }).waitFor({ state: "visible" });
    await page.getByText("Firma syntetyczna Alfa", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Pobierz raport Excel" }).waitFor({ state: "visible" });
    const resultSearchStyles = await page.getByLabel("Szukaj firmy").evaluate((input) => {
      const style = getComputedStyle(input);
      return { border: style.borderTopColor, background: style.backgroundColor, text: style.color,
        width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height };
    });
    assert(resultSearchStyles.width >= 220, "wyszukiwarka wyników ma użyteczną szerokość");
    assert(resultSearchStyles.height >= 44, "wyszukiwarka wyników ma cel o wysokości co najmniej 44 px");
    assert(contrastRatio(resultSearchStyles.border, resultSearchStyles.background) >= 3,
      "granica wyszukiwarki wyników ma kontrast co najmniej 3:1");
    assert(contrastRatio(resultSearchStyles.text, resultSearchStyles.background) >= 4.5,
      "tekst wyszukiwarki wyników ma kontrast co najmniej 4,5:1");
    await page.locator('.oc-step-rail .oc-step-link[href*="step=results"] small').getByText("Wyniki aktualizowane", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator('.oc-step-rail .oc-step-link[href*="step=progress"] small').textContent(), "W kolejce");
    await page.screenshot({ path: resolve(evidenceDir, "08-results.png"), fullPage: true });
    await page.getByLabel("Szukaj firmy").fill("Alfa");
    await page.waitForFunction(() => document.querySelectorAll(".oc-results tbody tr").length === 1);
    await page.locator(".oc-results select").selectOption("no_matching_policies");
    await page.getByText("Brak wierszy spełniających wybrane filtry.", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".oc-results select").selectOption("");
    await page.getByLabel("Szukaj firmy").fill("");
    await page.locator(".oc-step-rail").locator('a[href*="step=progress"]').click();
    await page.getByRole("button", { name: "Wstrzymaj nowe zadania" }).click();
    try { await page.getByText("Zgłoszenie · wstrzymane", { exact: true }).waitFor({ state: "visible", timeout: 7000 }); }
    catch { throw new Error(`PAUSE_UI_STATE: ${JSON.stringify({ header: await page.locator(".prepared-set-progress-head").allInnerTexts(), controls: admissionControls, errors: await page.locator("[role=alert]").allInnerTexts() })}`); }
    await page.getByRole("button", { name: "Wznów przyjmowanie zadań" }).click();
    await page.getByText("Zgłoszenie · w kolejce", { exact: true }).waitFor({ state: "visible" });
    assert.deepEqual(admissionControls.map(({ action }) => action), ["pause", "resume"]);
    assert(admissionControls.every((item) => item.headers["x-csrf-token"] === csrfToken));
    assert.deepEqual(admissionControls.map((item) => item.body.expectedVersion), [1, 2]);
    await page.goto(`${base}/tools/oc-policy-verification?resultSetId=${submissionId}`);
    await activeHeading.getByText("Wyniki i eksport", { exact: true }).waitFor({ state: "visible" });
    await page.getByText(`Zestaw wyników ${submissionId.slice(0, 8)}`, { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "Wyniki tej partii" }).waitFor({ state: "visible" });
    await page.getByText("Firma syntetyczna Alfa", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Pobierz raport Excel" }).waitFor({ state: "visible" });
    await page.goto(`${base}/tools/oc-policy-verification?import=${batchId}&resultSetId=${mismatchedResultSetId}&step=results`);
    await page.getByRole("alert").getByText("Import i zestaw wyników nie są ze sobą powiązane.", { exact: false }).waitFor({ state: "visible" });
    assert.equal(mismatchedResultRowsRequests, 0, "nieprawidłowo powiązany zestaw nie pobiera swoich wierszy");
    assert.equal(await page.getByText("NIEWŁAŚCIWA FIRMA", { exact: true }).count(), 0);
    await page.goto(`${base}/tools/oc-policy-verification?import=${batchId}&submission=${mismatchedSubmissionId}&step=progress`);
    await page.getByRole("alert").getByText("Zgłoszenie należy do innego importu.", { exact: false }).waitFor({ state: "visible" });
    assert.equal(mismatchedSubmissionItemsRequests, 0, "nieprawidłowo powiązane zgłoszenie nie pobiera elementów ani nie pokazuje sterowania");
    assert.equal(await page.getByRole("button", { name: "Wstrzymaj nowe zadania" }).count(), 0);
    await page.getByRole("heading", { name: "Przebieg zadań", exact: true }).waitFor({ state: "visible" });
    await page.goto(`${base}/tools/oc-policy-verification?import=${batchId}&run=${mismatchedRunId}&step=progress`);
    await page.getByRole("alert").getByText("Zadanie i import w adresie nie są ze sobą powiązane.", { exact: false }).waitFor({ state: "visible" });
    assert.equal(mismatchedRunBatchRequests, 0, "niespójny run nie otwiera danych importu z innego zestawu");
    assert.equal(await page.locator(".oc-run-detail").count(), 0);
    await page.goto(`${base}/tools/oc-policy-verification?view=legacy`);
    await page.getByRole("heading", { name: "Weryfikacja danych transportowych", exact: true }).waitFor({ state: "visible" });
    for (const [width, height] of [[320, 844], [375, 844], [390, 844], [768, 844], [1024, 768], [1366, 768], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `widok ${width}×${height} nie przewija strony poziomo`);
    }
    assert.deepEqual(errors, [], "brak błędów JavaScript w przeglądarce");
    console.log(`OC_WORKSPACE_UI_SMOKE_PASS screens=8 screenshots=${evidenceDir} navigationDoesNotMutate=true browserHistory=true serverSearch=true previewBeforeConfirmation=true csrf=true idempotency=true pauseResume=true scopedResultsAndExport=true directResultSetEntry=true mismatchedRunSubmissionResultBlocked=true legacyFallback=true progressReloadContext=true responsive320_1920=true syntheticOnly=true`);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("OC_WORKSPACE_UI_SMOKE_FAILED", error?.message ?? "unknown"); process.exitCode = 1; });
