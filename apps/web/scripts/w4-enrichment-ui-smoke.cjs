const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve, join } = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { chromium } = require("playwright");

const batchId = "33333333-3333-4333-8333-333333333333";
const csrfToken = "synthetic-csrf-token-for-w4-enrichment-ui-smoke-123456";
const screenshotDir = process.env.GOLDIS_UI_SCREENSHOTS === "1" ? mkdtempSync(join(tmpdir(), "goldis-w4-ui-")) : null;
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
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    const reviewRequests = [];
    let correctionRequest = null;
    const correctionRequests = [];
    let correctionSaved = false;
    let correctionConflictOnce = true;
    let correctionVersion = 1;
    let enrichmentJob = null;
    let enrichmentJobRequest = null;
    let enrichmentCancelRequest = null;
    const enrichmentCancelRequests = [];
    let staleCancelOnce = true;
    let expireJobListOnce = false;
    const itemCursors = [];
    const historicalJob = {
      id: "synthetic-history-job", batchId, status: "completed", selectedCount: 1,
      completedCount: 1, excludedCount: 0, failedCount: 0, cancelledCount: 0, version: 1,
      errorCode: null, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:01:00.000Z", finishedAt: "2026-10-05T10:01:00.000Z",
    };
    let runtimeHealth = { status: "ready", available: true, worker: "ready", provider: "configured", providerName: "gus-bir", message: "Worker wzbogacania odpowiada." };
    let runtimeHealthFailure = false;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let body;
      let status = 200;
      if (url.pathname === "/api/auth/login" && method === "POST") {
        body = { role: "admin", csrfToken };
      } else if (url.pathname === "/api/auth/me") {
        body = { role: "admin", csrfToken, tools: [{ toolId: "oc-policy-verification", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }] };
      } else if (url.pathname === "/api/health/enrichment") {
        body = runtimeHealthFailure ? { message: "synthetic-health-network-failure" } : runtimeHealth;
        status = runtimeHealthFailure ? 503 : 200;
      } else if (url.pathname === `/api/imports/${batchId}`) {
        body = { id: batchId, totalRows: 2, invalidRows: 0, readyRows: 2, sha256: "a".repeat(64) };
      } else if (url.pathname === `/api/imports/${batchId}/enrichment-jobs` && method === "GET") {
        if (expireJobListOnce) {
          expireJobListOnce = false;
          body = { message: "synthetic-session-expired" };
          status = 401;
        } else {
          body = { items: enrichmentJob ? [historicalJob, enrichmentJob] : [historicalJob] };
        }
      } else if (url.pathname === `/api/imports/${batchId}/enrichment-jobs` && method === "POST") {
        enrichmentJobRequest = { headers: request.headers(), body: request.postDataJSON() };
        enrichmentJob = {
          id: "synthetic-enrichment-job", batchId, status: "queued", selectedCount: 52,
          completedCount: 0, excludedCount: 0, failedCount: 0, cancelledCount: 0,
          version: 2, errorCode: null, createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z", finishedAt: null,
        };
        body = enrichmentJob;
      } else if (/^\/api\/enrichment-jobs\/[^/]+\/items$/.test(url.pathname) && method === "GET") {
        const jobId = url.pathname.split("/")[3];
        const cursor = url.searchParams.get("cursor");
        itemCursors.push({ jobId, cursor });
        if (jobId === "synthetic-history-job") {
          body = { items: [{ rowNumber: 18000, status: "matched", reasonCode: null, errorCode: null, attemptCount: 1, nextAttemptAt: null }], nextCursor: null };
        } else if (cursor) {
          body = { items: [18051, 18052].map((rowNumber) => ({ rowNumber, status: "pending", reasonCode: null, errorCode: null, attemptCount: 0, nextAttemptAt: null })), nextCursor: null };
        } else {
          body = {
            items: Array.from({ length: 50 }, (_, index) => {
              const rowNumber = 18001 + index;
              return { rowNumber, status: "pending", reasonCode: null, errorCode: index === 0 ? "RATE_LIMITED" : null,
                attemptCount: index === 0 ? 1 : 0, nextAttemptAt: index === 0 ? "2026-10-07T12:30:00.000Z" : null };
            }),
            nextCursor: "18051", hasMore: true, limit: 50,
          };
        }
      } else if (url.pathname === `/api/enrichment-jobs/synthetic-enrichment-job/cancel` && method === "POST") {
        enrichmentCancelRequest = { headers: request.headers(), body: request.postDataJSON() };
        enrichmentCancelRequests.push(enrichmentCancelRequest);
        if (staleCancelOnce) {
          staleCancelOnce = false;
          enrichmentJob = { ...enrichmentJob, status: "processing", version: 3 };
          body = { message: "synthetic-version-conflict" };
          status = 409;
        } else {
          enrichmentJob = { ...enrichmentJob, status: "cancelled", cancelledCount: 52, version: 4 };
          body = enrichmentJob;
        }
      } else if (url.pathname === `/api/imports/${batchId}/rows`) {
        body = [
          { rowNumber: 18001, companyName: "Firma syntetyczna Alfa", decisionMakerName: "Osoba testowa", regon: "", issues: [] },
          { rowNumber: 18002, companyName: "Firma syntetyczna Beta", decisionMakerName: null, regon: "987654321", issues: [] },
        ];
      } else if (url.pathname === `/api/imports/${batchId}/enrichment`) {
        reviewRequests.push(url.searchParams.get("page"));
        body = {
          page: 1,
          pageSize: 50,
          totalRows: 2,
          summary: { missingRegonRows: 1, pendingCorrectionRows: correctionSaved ? 1 : 0, openConflictRows: 1, lookupStatuses: { matched: 0, not_found: 1 } },
          rows: [
            {
              rowNumber: 18001,
              companyName: "Firma syntetyczna Alfa",
              decisionMakerName: "Osoba testowa",
              regonRaw: "",
              effectiveRegon: null,
              rowVersion: correctionSaved ? 3 : correctionVersion,
              issues: [],
              state: correctionSaved ? "correction_pending" : "missing_regon",
              source: "missing",
              correction: correctionSaved ? { correctionId: "synthetic-correction", proposedRegon: "012345678", status: "pending", reason: "Potwierdzenie w fikcyjnym źródle", createdAt: "2026-09-30T10:00:00.000Z" } : null,
              lookup: { status: "not_found", reasonCode: "NO_MATCH", providerName: "synthetic-registry", providerVersion: "fixture-v1", checkedAt: "2026-09-30T09:00:00.000Z" },
              conflict: null,
            },
            {
              rowNumber: 18002,
              companyName: "Firma syntetyczna Beta",
              decisionMakerName: null,
              regonRaw: "987654321",
              effectiveRegon: "987654321",
              rowVersion: 3,
              issues: [],
              state: "conflict",
              source: "import",
              correction: null,
              lookup: null,
              conflict: { reasonCode: "SAME_NIP_DIFFERENT_REGON", candidateCount: 1, createdAt: "2026-09-30T09:05:00.000Z" },
            },
          ],
        };
      } else if (url.pathname === `/api/imports/${batchId}/rows/18001` && method === "PATCH") {
        correctionRequest = { headers: request.headers(), body: request.postDataJSON() };
        correctionRequests.push(correctionRequest);
        if (correctionConflictOnce) {
          correctionConflictOnce = false;
          correctionVersion = 2;
          body = { message: "synthetic-row-version-conflict" };
          status = 409;
        } else {
          correctionSaved = true;
          correctionVersion = 3;
          body = { correctionId: "synthetic-correction", rowNumber: 18001, status: "pending", rowVersion: 3 };
        }
      } else if (url.pathname === "/api/runs" && url.searchParams.get("batchId") === batchId) {
        body = [];
      } else {
        body = { message: "Unexpected synthetic API request" };
        status = 404;
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store" } });
    });

    await page.goto(`${baseUrl}/?import=${batchId}`);
    await page.getByRole("heading", { name: "Uzupełnianie i korekty danych" }).waitFor({ state: "visible" });
    await page.getByText("Ten sam NIP wskazuje różne numery REGON.").waitFor({ state: "visible" });
    await page.getByText(/Brak wyniku/).waitFor({ state: "visible" });
    await page.getByText("GUS BIR — rejestr REGON").waitFor({ state: "visible" });
    await page.getByText(/produkcyjne użycie wymaga klucza wydanego przez GUS/).waitFor({ state: "visible" });
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "provider-ready-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Zaproponuj korektę" }).first().click();
    await page.getByLabel("Proponowany REGON dla wiersza 18001").fill("012345678");
    await page.getByLabel("Powód").fill("Potwierdzenie w fikcyjnym źródle");
    await page.getByRole("button", { name: "Zapisz propozycję" }).click();
    await page.getByText(/Wiersz zmienił się od czasu odczytu/).waitFor({ state: "visible" });
    assert.deepEqual(correctionRequests[0]?.body, { proposedRegon: "012345678", reason: "Potwierdzenie w fikcyjnym źródle", expectedVersion: 1 });
    await page.getByRole("button", { name: "Zaproponuj korektę" }).first().click();
    await page.getByLabel("Proponowany REGON dla wiersza 18001").fill("012345678");
    await page.getByLabel("Powód").fill("Potwierdzenie w fikcyjnym źródle");
    await page.getByRole("button", { name: "Zapisz propozycję" }).click();
    await page.getByText(/Propozycja 012345678 oczekuje na rozstrzygnięcie/).waitFor({ state: "visible" });
    const correctionTrackingLink = page.getByRole("link", { name: "Zobacz moje korekty" });
    await correctionTrackingLink.waitFor({ state: "visible" });
    assert.equal(await correctionTrackingLink.getAttribute("href"), `/review?batchId=${batchId}&toolId=oc-policy-verification`,
      "saved correction keeps its import context and links to the personal review queue");
    await page.reload();
    await page.getByRole("heading", { name: "Uzupełnianie i korekty danych" }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Zobacz moje korekty" }).waitFor({ state: "visible" });
    assert.equal(correctionRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(correctionRequest?.body, { proposedRegon: "012345678", reason: "Potwierdzenie w fikcyjnym źródle", expectedVersion: 2 });
    assert.equal(correctionRequests.length, 2, "konflikt wersji nie powoduje automatycznego ponowienia PATCH");
    assert.ok(reviewRequests.length >= 3, "zapis i konflikt odświeżają źródła oraz wersję wiersza");
    assert.equal(await page.getByText("Osoba fizyczna", { exact: true }).count(), 0, "panel nie ujawnia danych osoby fizycznej");

    const enrichmentPanel = page.locator(".enrichment-job-panel");
    await enrichmentPanel.getByLabel("Od wiersza").fill("18001");
    await enrichmentPanel.getByLabel("Do wiersza").fill("18002");
    await enrichmentPanel.getByRole("button", { name: "Dodaj zadanie" }).click();
    await page.getByText("Oczekuje na workera", { exact: true }).waitFor({ state: "visible" });
    assert.equal(enrichmentJobRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual({ ...enrichmentJobRequest?.body, idempotencyKey: "synthetic" }, {
      idempotencyKey: "synthetic", fromRow: 18001, toRow: 18002,
    });
    assert.match(enrichmentJobRequest?.body.idempotencyKey ?? "", /^[0-9a-f-]{36}$/i);
    const jobHistory = page.getByRole("navigation", { name: "Historia zadań rejestru" });
    await jobHistory.getByRole("button", { name: /Zakończono/ }).click();
    await page.getByText("Wiersz 18000").waitFor({ state: "visible" });
    await jobHistory.getByRole("button", { name: /Oczekuje na workera/ }).click();
    await page.getByText(/Dostawca ograniczył liczbę zapytań/).waitFor({ state: "visible" });
    await page.getByText(/Następna próba po/).waitFor({ state: "visible" });
    assert.equal(await page.getByText("Wiersz 18050").count(), 1, "pierwsza strona zawiera 50 pozycji");
    await page.getByRole("button", { name: "Pokaż następne 50" }).click();
    await page.getByText("Wiersz 18052").waitFor({ state: "visible" });
    assert.equal(itemCursors.some((item) => item.jobId === "synthetic-enrichment-job" && item.cursor === "18051"), true,
      "kolejna strona pozycji używa kursora backendu");
    await page.getByRole("button", { name: "Anuluj zadanie" }).click();
    await page.getByText(/Zadanie zmieniło się w innej karcie/).waitFor({ state: "visible" });
    await page.getByText("W trakcie", { exact: true }).waitFor({ state: "visible" });
    assert.equal(enrichmentCancelRequests.length, 1, "409 nie powoduje automatycznego ponowienia mutacji");
    assert.deepEqual(enrichmentCancelRequests[0].body, { expectedVersion: 2 });
    await page.getByRole("button", { name: "Anuluj zadanie" }).click();
    await page.getByText("Anulowano", { exact: true }).waitFor({ state: "visible" });
    assert.equal(enrichmentCancelRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(enrichmentCancelRequest?.body, { expectedVersion: 3 });
    await jobHistory.getByRole("button", { name: /Zakończono/ }).click();
    await page.getByText("Wiersz 18000").waitFor({ state: "visible" });
    await jobHistory.getByRole("button", { name: /Anulowano/ }).click();
    await page.getByText("Anulowano", { exact: true }).waitFor({ state: "visible" });

    const viewportChecks = [
      { width: 320, height: 760, file: "mobile-narrow.png" },
      { width: 390, height: 844, file: "mobile.png" },
      { width: 768, height: 1024, file: "tablet.png" },
      { width: 1920, height: 1080, file: "desktop-wide.png" },
    ];
    for (const viewport of viewportChecks) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (hasOverflow) console.error("W4_ENRICHMENT_OVERFLOW_DEBUG", JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll("body *"))
        .filter((element) => element.scrollWidth > element.clientWidth + 2)
        .slice(0, 12).map((element) => ({ tag: element.tagName, className: typeof element.className === "string" ? element.className : "",
          width: element.clientWidth, scrollWidth: element.scrollWidth, text: element.textContent?.trim().slice(0, 70) })))));
      assert.equal(hasOverflow, false, `widok ${viewport.width}px nie przewija całej strony poziomo`);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, viewport.file), fullPage: true });
    }

    runtimeHealth = { status: "not_ready", available: false, worker: "offline", provider: "unknown", providerName: null, message: "Worker wzbogacania nie odpowiada." };
    await page.reload();
    await page.getByText("Anulowano", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("worker nie odpowiada").waitFor({ state: "visible" });
    await page.getByText("Dostawca: status konfiguracji niedostępny").waitFor({ state: "visible" });
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "worker-offline.png"), fullPage: true });

    runtimeHealthFailure = true;
    await page.reload();
    await page.getByText("Status rejestru jest chwilowo niedostępny.").waitFor({ state: "visible" });
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "health-unavailable.png"), fullPage: true });
    expireJobListOnce = true;
    await page.reload();
    await page.getByRole("heading", { name: "Zaloguj się" }).waitFor({ state: "visible" });
    await page.getByLabel("Użytkownik").fill("synthetic.admin");
    await page.getByLabel("Hasło").fill("synthetic-password");
    await page.getByRole("button", { name: "Przejdź do panelu" }).click();
    await page.getByText("Anulowano", { exact: true }).waitFor({ state: "visible" });
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript w przeglądarce");

    console.log(`W4_ENRICHMENT_UI_SMOKE_PASS provenance=true registryStatus=true conflictReason=true correctionCsrf=true jobRange=true jobCsrf=true jobCancelCAS=true refresh=true jobPagination=50+2 cooldown=true f5State=true reauthRecovery=true healthOffline=true healthNetworkError=true viewportChecks=320,390,768,1920 screenshotDir=${screenshotDir ?? "disabled"} syntheticOnly=true`);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      server.kill();
      await new Promise((resolveExit) => server.once("exit", resolveExit));
    }
  }
}

main().catch((error) => {
  console.error("W4_ENRICHMENT_UI_SMOKE_FAILED", error?.message ?? "unknown");
  process.exitCode = 1;
});
