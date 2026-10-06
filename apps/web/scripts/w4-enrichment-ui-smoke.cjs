const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const batchId = "33333333-3333-4333-8333-333333333333";
const csrfToken = "synthetic-csrf-token-for-w4-enrichment-ui-smoke-123456";
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
    let correctionSaved = false;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let body;
      let status = 200;
      if (url.pathname === "/api/auth/me") {
        body = { role: "admin", csrfToken, tools: [{ toolId: "oc-policy-verification", canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }] };
      } else if (url.pathname === `/api/imports/${batchId}`) {
        body = { id: batchId, totalRows: 2, invalidRows: 0, readyRows: 2, sha256: "a".repeat(64) };
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
              rowVersion: correctionSaved ? 2 : 1,
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
        correctionSaved = true;
        body = { correctionId: "synthetic-correction", rowNumber: 18001, status: "pending", rowVersion: 2 };
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
    await page.getByRole("button", { name: "Zaproponuj korektę" }).first().click();
    await page.getByLabel("Proponowany REGON dla wiersza 18001").fill("012345678");
    await page.getByLabel("Powód").fill("Potwierdzenie w fikcyjnym źródle");
    await page.getByRole("button", { name: "Zapisz propozycję" }).click();
    await page.getByText(/Propozycja 012345678 oczekuje na rozstrzygnięcie/).waitFor({ state: "visible" });
    assert.equal(correctionRequest?.headers["x-csrf-token"], csrfToken);
    assert.deepEqual(correctionRequest?.body, { proposedRegon: "012345678", reason: "Potwierdzenie w fikcyjnym źródle", expectedVersion: 1 });
    assert.ok(reviewRequests.length >= 2, "zapis odświeża źródła i stan korekty");
    assert.equal(await page.getByText("Osoba fizyczna", { exact: true }).count(), 0, "panel nie ujawnia danych osoby fizycznej");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(mobileOverflow, false, "widok mobilny nie przewija całej strony poziomo");
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript w przeglądarce");

    console.log("W4_ENRICHMENT_UI_SMOKE_PASS provenance=true registryStatus=true conflictReason=true correctionCsrf=true expectedVersion=true refresh=true mobileNoPageOverflow=true syntheticOnly=true");
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
