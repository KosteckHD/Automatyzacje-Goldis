"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const os = require("node:os");
const { mkdirSync } = require("node:fs");
const { chromium } = require("playwright");

const runId = "22222222-2222-4222-8222-222222222222";
const artifactId = "77777777-7777-4777-8777-777777777777";
const importId = "88888888-8888-4888-8888-888888888888";
const tenantId = "99999999-9999-4999-8999-999999999999";
const csrfToken = "synthetic-history-delete-csrf-token-1234567890";
const requests = [];
const portProbe = createServer();
const screenshotDirectory = resolve(os.tmpdir(), "goldis-deletion-history-ui-smoke");
let authorized = true;
let blocked = false;
let jobId = null;
let activeTargetType = null;
let activeTargetId = null;
let jobSequence = 0;
let activePage;

async function freePort() {
  await new Promise((resolveListen, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolveListen); });
  const port = portProbe.address().port;
  await new Promise((resolveClose, reject) => portProbe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("NEXT_SERVER_EXITED_BEFORE_READY");
    try { const response = await fetch(url); if (response.ok) return; } catch { /* Wait for the local production server. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("NEXT_SERVER_START_TIMEOUT");
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  });
  let browser;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    activePage = page;
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      let body = {};
      let status = 200;
      if (path === "/api/auth/me") body = {
        role: authorized ? "admin" : "manager", username: "synthetic.user", csrfToken,
        canDeleteData: authorized, mustChangePassword: false,
        tools: [{ toolId: "oc-policy-verification", canViewResults: true, canDownloadResults: true }],
      };
      else if (path === "/api/history/results") body = { items: [{
        id: runId, batchId: "11111111-1111-4111-8111-111111111111", rowNumber: 18001,
        toolId: "oc-policy-verification", status: "completed", referenceDate: "2026-10-05", errorCode: null,
        createdAt: "2026-10-05T12:00:00.000Z", policyCounts: { totalOcCount: 4, currentOcCount: 2 }, artifactAvailable: true, artifactId,
      }], nextCursor: null };
      else if (path === "/api/imports") body = { items: [{ id: importId, toolId: "oc-policy-verification",
        fileName: "synthetic-import.xlsx", totalRows: 10, reviewCount: 0, createdAt: "2026-10-05T12:00:00.000Z" }], nextCursor: null };
      else if (path === "/api/deletions/preview" && request.method() === "POST") {
        const input = request.postDataJSON();
        requests.push({ type: "preview", input });
        activeTargetType = input.targetType;
        activeTargetId = input.targetId;
        assert.ok((input.targetType === "run" && input.targetId === runId)
          || (input.targetType === "artifact" && input.targetId === artifactId)
          || (input.targetType === "import" && input.targetId === importId));
        body = { previewId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-10-09T14:00:00.000Z",
          targetType: activeTargetType, targetId: activeTargetId, requiresStepUp: true,
          summary: { counts: { imports: activeTargetType === "import" ? 1 : 0, sourceRows: activeTargetType !== "artifact" ? 1 : 0, runs: activeTargetType === "artifact" ? 0 : 1,
            submissions: 0, artifacts: 1, files: 1, activeRuns: blocked && activeTargetType === "run" ? 1 : 0,
            pendingArtifacts: 0, sharedRunReferences: 0, activeOutbox: 0, stagedFiles: 0 },
            blockers: blocked && activeTargetType === "run" ? ["RUN_ACTIVE"] : [] } };
      }
      else if (path === "/api/auth/deletion-step-up" && request.method() === "POST") {
        const input = request.postDataJSON();
        requests.push({ type: "step-up", input });
        assert.equal(input.currentPassword, "Synthetic current password!");
        assert.equal(input.previewId, "44444444-4444-4444-8444-444444444444");
        body = { stepUpToken: "55555555-5555-4555-8555-555555555555.synthetic-token-secret-that-is-long-enough-to-test",
          expiresAt: "2026-10-09T14:04:00.000Z" };
      }
      else if (path === "/api/deletions/jobs" && request.method() === "POST") {
        const input = request.postDataJSON();
        requests.push({ type: "create", input });
        assert.equal(input.previewId, "44444444-4444-4444-8444-444444444444");
        assert.match(input.idempotencyKey, /^web-[0-9a-f-]{36}$/i);
        assert.equal(request.headers()["x-csrf-token"], csrfToken);
        jobSequence += 1;
        jobId = `66666666-6666-4666-8666-${String(jobSequence).padStart(12, "0")}`;
        body = { jobId, targetType: activeTargetType, targetId: activeTargetId, status: "queued", version: 1, attemptCount: 0,
          fileCount: 1, filesRemoved: 0, errorCode: null, createdAt: "2026-10-09T13:59:00.000Z", updatedAt: "2026-10-09T13:59:00.000Z", finishedAt: null };
        status = 202;
      }
      else if (path === "/api/deletions/jobs" && request.method() === "GET") {
        body = { items: jobId ? [{ jobId, targetType: activeTargetType, targetId: activeTargetId, status: "completed", version: 3,
          attemptCount: 1, fileCount: 1, filesRemoved: 1, errorCode: null,
          createdAt: "2026-10-09T13:59:00.000Z", updatedAt: "2026-10-09T13:59:02.000Z", finishedAt: "2026-10-09T13:59:02.000Z" }] : [] };
      }
      else if (path === `/api/deletions/jobs/${jobId}`) {
        requests.push({ type: "poll" });
        body = { jobId, targetType: activeTargetType, targetId: activeTargetId, status: "completed", version: 3, attemptCount: 1,
          fileCount: 1, filesRemoved: 1, errorCode: null, createdAt: "2026-10-09T13:59:00.000Z", updatedAt: "2026-10-09T13:59:02.000Z", finishedAt: "2026-10-09T13:59:02.000Z" };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.goto(`${baseUrl}/results/history`);
    await page.getByText("2 aktualnych polis OC", { exact: false }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Usuń sam plik Excel" }).click();
    const artifactDialog = page.getByRole("dialog", { name: "Usuń plik Excel" });
    await artifactDialog.getByText("Wynik zadania i import źródłowy pozostaną", { exact: false }).waitFor({ state: "visible" });
    await artifactDialog.getByLabel("Potwierdź swoje obecne hasło").fill("Synthetic current password!");
    await artifactDialog.getByRole("button", { name: "Potwierdź i zleć usunięcie" }).click();
    await artifactDialog.getByText("Plik Excel usunięto", { exact: false }).waitFor({ state: "visible" });
    assert.equal(await page.getByText("2 aktualnych polis OC", { exact: false }).count(), 1, "usunięcie artefaktu zachowuje wynik zadania");
    await artifactDialog.getByRole("button", { name: "Zamknij", exact: true }).click();

    const removeButton = page.getByRole("button", { name: "Przygotuj usunięcie wyniku" });
    await removeButton.waitFor({ state: "visible" });
    await removeButton.click();
    const dialog = page.getByRole("dialog", { name: "Usuń wynik zadania" });
    await dialog.getByText("Import źródłowy Excel pozostanie w systemie", { exact: false }).waitFor({ state: "visible" });
    await dialog.getByText("pliki do usunięcia", { exact: false }).waitFor({ state: "visible" });
    await dialog.getByLabel("Potwierdź swoje obecne hasło").fill("Synthetic current password!");
    await dialog.getByRole("button", { name: "Potwierdź i zleć usunięcie" }).click();
    await dialog.getByText("Wynik usunięty").waitFor({ state: "visible" });
    const deletionJobs = page.getByRole("region", { name: "Zlecenia usuwania danych" });
    await deletionJobs.getByText("Zakończono").waitFor({ state: "visible" });
    assert.deepEqual(requests.map((entry) => entry.type), ["preview", "step-up", "create", "poll", "preview", "step-up", "create", "poll"]);
    assert.deepEqual(requests[0].input, { targetType: "artifact", targetId: artifactId });
    assert.deepEqual(requests[4].input, { targetType: "run", targetId: runId });

    await page.goto(`${baseUrl}/imports`);
    await page.getByText("synthetic-import.xlsx", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Przygotuj usunięcie importu" }).click();
    const importDialog = page.getByRole("dialog", { name: "Usuń import" });
    await importDialog.getByText("Usunięte zostaną import, jego wiersze", { exact: false }).waitFor({ state: "visible" });
    await importDialog.getByLabel("Potwierdź swoje obecne hasło").fill("Synthetic current password!");
    await importDialog.getByRole("button", { name: "Potwierdź i zleć usunięcie" }).click();
    await importDialog.getByText("Import usunięty").waitFor({ state: "visible" });
    assert.equal(await page.getByText("synthetic-import.xlsx", { exact: true }).count(), 0,
      "zakończone zlecenie usuwa import z historii");
    assert.deepEqual(requests[8].input, { targetType: "import", targetId: importId });

    blocked = true;
    await page.goto(`${baseUrl}/results/history`);
    await page.reload();
    await page.getByRole("region", { name: "Zlecenia usuwania danych" }).getByText("Zakończono").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Przygotuj usunięcie wyniku" }).click();
    const blockedDialog = page.getByRole("dialog", { name: "Usuń wynik zadania" });
    await blockedDialog.getByText("Zadanie nadal działa.").waitFor({ state: "visible" });
    assert.equal(await blockedDialog.getByRole("button", { name: "Potwierdź i zleć usunięcie" }).isDisabled(), true);
    assert.equal(requests.filter((entry) => entry.type === "create").length, 3, "blokada odrzuca zlecenie run przed wysłaniem");
    await blockedDialog.getByRole("button", { name: "Zamknij podgląd" }).click();

    authorized = false;
    await page.reload();
    await page.getByText("2 aktualnych polis OC", { exact: false }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Przygotuj usunięcie wyniku" }).count(), 0,
      "Menedżer bez odrębnego grantu nie widzi akcji usuwania");
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      "widok historii wyników nie przewija poziomo przy 375 px");
    assert.deepEqual(pageErrors, [], "konsola aplikacji nie zawiera błędów wykonania");
    mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDirectory, "history-mobile.png"), fullPage: true, animations: "disabled" });
    console.log("DELETION_HISTORY_UI_PASS artifactScopeRetainsRun=true runScopeRemovesResult=true importScopeRemovesSource=true preview=true passwordStepUp=true csrf=true durableJob=true pollCompletion=true persistentJobHistory=true activeRunBlocker=true managerGrantHidden=true responsive375=true");
  } catch (error) {
    if (activePage) {
      mkdirSync(screenshotDirectory, { recursive: true });
      await activePage.screenshot({ path: resolve(screenshotDirectory, "failure.png"), fullPage: true }).catch(() => undefined);
      console.error("DELETION_HISTORY_UI_DEBUG", JSON.stringify({ url: activePage.url(), body: await activePage.locator("body").innerText().catch(() => "unavailable") }));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
  }
}

main().catch((error) => { console.error("DELETION_HISTORY_UI_FAILED", error?.stack ?? error?.message ?? "unknown"); process.exitCode = 1; });
