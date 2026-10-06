const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

const csrfToken = "synthetic-csrf-token-for-review-ui-smoke-123456";
const correctionId = "55555555-5555-4555-8555-555555555555";
const conflictId = "66666666-6666-4666-8666-666666666666";
const candidateId = "77777777-7777-4777-8777-777777777777";
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

async function waitForServer(url, server) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { if ((await fetch(url)).ok) return; } catch { /* Wait for Next.js startup. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  });
  let browser;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    const requests = [];
    let correctionDecisions = 0;
    let conflictResolutions = 0;
    let correctionStatus = "pending";
    let correctionQueueRevision = 0;
    let role = "reviewer";
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let status = 200;
      let body;
      if (url.pathname === "/api/auth/me") {
        body = { role, username: "synthetic.reviewer", csrfToken, mustChangePassword: false };
      } else if (url.pathname === "/api/review/corrections") {
        correctionQueueRevision += 1;
        body = { items: correctionStatus === "pending" ? [{
          id: correctionId, status: correctionStatus, createdAt: "2026-09-30T10:00:00.000Z", previousRegon: "012345678",
          proposedRegon: "987654321", reason: "Potwierdzono dokument syntetyczny", rowNumber: 18001, rowVersion: correctionQueueRevision > 1 ? 5 : 4,
          companyName: "Firma testowa Alfa", batchId: "33333333-3333-4333-8333-333333333333", toolId: "oc-policy-verification",
        }] : [], nextCursor: null, hasMore: false, limit: 50 };
      } else if (url.pathname === `/api/review/corrections/${correctionId}/decision` && method === "POST") {
        requests.push({ path: url.pathname, method, body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
        correctionDecisions += 1;
        if (correctionDecisions === 1) { status = 409; body = { message: "stale" }; }
        else { correctionStatus = request.postDataJSON().decision; body = { decision: correctionStatus, rowVersion: 5 }; }
      } else if (url.pathname === "/api/review/conflicts") {
        body = { items: [{
          id: conflictId, status: "open", createdAt: "2026-09-30T11:00:00.000Z", reasonCode: "SAME_NIP_DIFFERENT_REGON",
          rowNumber: 18002, rowVersion: 8, companyName: "Firma testowa Beta", effectiveRegon: "123456789",
          batchId: "33333333-3333-4333-8333-333333333333", toolId: "oc-policy-verification",
          candidates: [{ id: candidateId, businessName: "Firma testowa Beta", regon: "123456789" }],
        }], nextCursor: null, hasMore: false, limit: 50 };
      } else if (url.pathname === `/api/review/conflicts/${conflictId}/resolution` && method === "POST") {
        requests.push({ path: url.pathname, method, body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
        conflictResolutions += 1;
        body = { decision: request.postDataJSON().action, rowVersion: 9 };
      } else if (url.pathname === "/api/review/my-corrections") {
        body = { items: [{
          id: correctionId, status: "pending", createdAt: "2026-09-30T10:00:00.000Z", previousRegon: null,
          proposedRegon: "987654321", reason: "Moja syntetyczna propozycja", rowNumber: 18001, rowVersion: 4,
          companyName: "Firma testowa Alfa", batchId: "33333333-3333-4333-8333-333333333333", toolId: "oc-policy-verification",
        }], nextCursor: null, hasMore: false, limit: 50 };
      } else {
        status = 404; body = { message: "unexpected synthetic request" };
      }
      await route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });
    });

    await page.goto(`${baseUrl}/review`);
    await page.getByRole("heading", { name: "Korekty REGON" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Rozpatrz korektę" }).click();
    await page.getByRole("button", { name: "Zatwierdź" }).click();
    await page.getByRole("alert").getByText(/Wiersz zmienił się/).waitFor({ state: "visible" });
    assert.equal(correctionDecisions, 1, "409 nie ponawia decyzji automatycznie");
    await page.getByRole("button", { name: "Odśwież kolejkę" }).click();
    await page.getByRole("button", { name: "Zatwierdź" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Zatwierdź" }).click();
    await page.getByRole("status").getByText("Korekta zatwierdzona").waitFor({ state: "visible" });
    assert.equal(correctionDecisions, 2);
    assert.deepEqual(requests[0].body, { decision: "approved", expectedRowVersion: 4, reasonCode: "REGISTRY_MATCH_VERIFIED" });
    assert.deepEqual(requests[1].body, { decision: "approved", expectedRowVersion: 5, reasonCode: "REGISTRY_MATCH_VERIFIED" });
    assert.equal(requests[0].csrf, csrfToken);

    await page.getByRole("tab", { name: "Konflikty encji" }).click();
    await page.getByRole("heading", { name: "Konflikty encji" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Rozpatrz konflikt" }).click();
    await page.getByLabel("Encja do połączenia").selectOption(candidateId);
    await page.getByRole("button", { name: "Połącz z wybraną encją" }).click();
    await page.getByRole("status").getByText("Decyzja zapisana").waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "Konflikty encji" }).waitFor({ state: "visible" });
    assert.equal(conflictResolutions, 1);
    assert.deepEqual(requests.at(-1).body, { action: "link_existing", expectedRowVersion: 8, reasonCode: "IDENTIFIERS_VERIFIED", canonicalEntityId: candidateId });

    role = "operator";
    await page.goto(`${baseUrl}/review`);
    await page.getByRole("heading", { name: "Moje propozycje korekt" }).waitFor({ state: "visible" });
    await page.getByText("Moja syntetyczna propozycja").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Rozpatrz korektę" }).count(), 0, "operator widzi status bez kontrolki decyzji");
    assert.equal(requests.filter((request) => request.path.endsWith("/decision")).length, 2);

    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "brak overflow poziomego przy 375 px");
    assert.deepEqual(pageErrors, [], "brak błędów JavaScript");
    assert.ok(correctionQueueRevision >= 3, "po konflikcie wersji kolejka została odczytana ponownie po ręcznym odświeżeniu");
    console.log("REVIEW_UI_SMOKE_PASS correction=409-no-retry-then-approved conflict=tenant-candidate-linked csrf=true operator=status-only mobile=375-no-overflow synthetic-only=true api=stubbed");
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      server.kill();
      await new Promise((resolveExit) => server.once("exit", resolveExit));
    }
  }
}

main().catch((error) => {
  console.error("REVIEW_UI_SMOKE_FAILED", error?.message ?? "unknown");
  process.exitCode = 1;
});
