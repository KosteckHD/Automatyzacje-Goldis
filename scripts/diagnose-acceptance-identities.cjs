"use strict";

// Read-only identity acceptance for the explicitly selected source rows.
// Uses production portal adapters; never writes customer values or identities.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ExcelJS = require("exceljs");
const { parseTransportWorkbook } = require("../apps/api/dist/features/imports/workbook.js");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser.js");
const { PzuEverestSession } = require("../apps/worker/dist/portals/pzu/pzu-session.js");
const { EverestIdentityProvider } = require("../apps/worker/dist/portals/pzu/everest-identity-provider.js");
const { PortalActionPacer } = require("../apps/worker/dist/portals/shared/portal-action-pacer.js");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");

async function main() {
  const root = path.resolve(__dirname, "..");
  const profile = await fs.realpath(process.env.ACCEPTANCE_PZU_EXISTING_PROFILE || "");
  const parent = await fs.realpath(path.join(process.env.LOCALAPPDATA, "Goldis"));
  if (path.dirname(profile).toLowerCase() !== parent.toLowerCase() || !/^pzu-login-[a-z0-9]+$/i.test(path.basename(profile))) throw new Error("ACCEPTANCE_PROFILE_SCOPE_INVALID");
  const credentials = {};
  for (const line of (await fs.readFile(path.join(root, ".env"), "utf8")).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) credentials[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  if (!credentials.PZU_LOGIN || !credentials.PZU_PASSWORD) throw new Error("ACCEPTANCE_PZU_CREDENTIALS_REQUIRED");
  if (process.argv.slice(2).some(arg => arg !== "--five-rows")) throw new Error("ACCEPTANCE_ARGUMENT_INVALID");
  const fiveRows = process.argv.includes("--five-rows");
  const rowNumbers = fiveRows ? [18001, 18002, 18003, 18004, 18005] : [18001, 18002];
  const original = new ExcelJS.Workbook();
  await original.xlsx.readFile(path.join(root, "docs/BAZA TRANSPORTOWA.xlsx"));
  const originalSheet = original.getWorksheet("Realizacja");
  const sparse = new ExcelJS.Workbook();
  const sheet = sparse.addWorksheet("Realizacja");
  for (const number of [1, ...rowNumbers]) {
    if (!originalSheet?.getRow(number).hasValues) throw new Error("ACCEPTANCE_SOURCE_ROW_MISSING");
    originalSheet.getRow(number).eachCell({ includeEmpty: false }, (cell, column) => {
      sheet.getRow(number).getCell(column).value = structuredClone(cell.value);
    });
  }
  const rows = await parseTransportWorkbook(Buffer.from(await sparse.xlsx.writeBuffer()));
  if (JSON.stringify(rows.map(row => row.rowNumber)) !== JSON.stringify(rowNumbers)
    || rows.some(row => row.issues.length || !row.effectiveRegon || (!fiveRows && !row.decisionMakerName))) throw new Error("ACCEPTANCE_SOURCE_NOT_READY");
  console.log(JSON.stringify({ sourceValidated: true, rowNumbers, distinctRegon: rows[0].effectiveRegon !== rows[1].effectiveRegon }));
  const config = await buildAcceptancePortalConfig();
  const browser = new BrowserSession({ profileDirectory: profile, headless: false });
  browser.configureNavigationPolicy({ pzu: config.pzu, compensa: config.compensa });
  const report = { checkedAt: new Date().toISOString(), mode: "production-identity-adapter-only", rowNumbers,
    actionIntervalMs: 1000, results: [], httpStatuses: {}, httpErrors: [], rateLimitEvents: [], completed: false };
  let activeRow = null;
  let stage = "login";
  const context = await browser.open();
  context.on("response", response => {
    const host = new URL(response.url()).hostname;
    if (!["everest.pzu.pl", "zaloguj.pzu.pl", "strefa.agentpzu.pl"].includes(host)) return;
    const status = response.status();
    report.httpStatuses[status] = (report.httpStatuses[status] || 0) + 1;
    if (status >= 400) report.httpErrors.push({ at: new Date().toISOString(), rowNumber: activeRow, stage, host,
      resourceType: response.request().resourceType(), status });
    if (status === 429) {
      const event = { at: new Date().toISOString(), rowNumber: activeRow, stage, host,
        resourceType: response.request().resourceType(), status };
      report.rateLimitEvents.push(event);
      console.log(JSON.stringify({ rateLimited: true, ...event }));
    }
  });
  const pacer = new PortalActionPacer(1000);
  const beforeAction = async () => {
    await pacer.beforeAction(browser.sessionId, async () => {});
    if (report.rateLimitEvents.length) throw new Error("ACCEPTANCE_HTTP_429_STOP");
    await browser.assertNavigationAllowed("pzu");
  };
  const session = new PzuEverestSession(browser, { everestEntryUrl: config.pzu.entryUrl,
    allowedOrigins: config.pzu.allowedOrigins, selectors: config.pzu.session, beforeAction });
  const provider = new EverestIdentityProvider(browser, session, { selectors: config.pzu.everest,
    adapterVersion: config.pzu.adapterVersion, beforeAction,
    credentials: () => ({ username: credentials.PZU_LOGIN, password: credentials.PZU_PASSWORD }) });
  try {
    let state = await session.signIn({ username: credentials.PZU_LOGIN, password: credentials.PZU_PASSWORD });
    console.log(JSON.stringify({ portalState: state }));
    if (state === "waiting_for_sms") {
      console.log("ACCEPTANCE_ENTER_SMS_IN_WORKER_BROWSER");
      const deadline = Date.now() + 300000;
      while (["waiting_for_sms", "unknown"].includes(state) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        state = await session.ensureAuthenticated();
      }
    }
    if (state !== "authenticated") throw new Error("ACCEPTANCE_PZU_NOT_AUTHENTICATED");
    for (const row of rows) {
      if (report.rateLimitEvents.length) throw new Error("ACCEPTANCE_HTTP_429_STOP");
      stage = "everest_search";
      activeRow = row.rowNumber;
      const started = Date.now();
      console.log(JSON.stringify({ rowNumber: activeRow, searchStarted: true }));
      let result;
      if (row.decisionMakerName) {
        try {
          result = await provider.findIdentity({ source: { ...row, id: randomUUID() } });
        } catch (error) {
          if (report.rateLimitEvents.length) throw new Error("ACCEPTANCE_HTTP_429_STOP");
          const page = await browser.page("pzu");
          const diagnostic = { rowNumber: activeRow,
            errorCode: /^[A-Z][A-Z0-9_]+$/.test(error?.message || "") ? error.message : "ACCEPTANCE_SEARCH_FAILED",
            noResultsVisible: await page.locator(config.pzu.everest.noResults).first().isVisible().catch(() => false),
            visibleResultRows: await page.locator(config.pzu.everest.resultRows).filter({ visible: true }).count(),
            searchInputMatchesSource: await page.locator(config.pzu.everest.searchInput).filter({ visible: true }).inputValue().then(value => value === row.effectiveRegon).catch(() => false),
            portalState: await session.ensureAuthenticated() };
          report.results.push({ ...diagnostic, kind: "search_error", elapsedMs: Date.now() - started });
          console.log(JSON.stringify(diagnostic));
          if (diagnostic.portalState !== "authenticated") throw error;
          continue;
        }
      } else {
        // Diagnostic search only: no invented person and no identity acceptance.
        const page = await browser.page("pzu");
        const selectors = config.pzu.everest;
        const search = page.locator(selectors.searchInput).filter({ visible: true });
        if (await search.count() !== 1) throw new Error("ACCEPTANCE_SEARCH_INPUT_AMBIGUOUS");
        await beforeAction();
        await search.fill(row.effectiveRegon);
        const token = "__goldisAcceptanceSearch";
        await page.evaluate(token => {
          const state = { changed: false, lastChange: Date.now() };
          state.observer = new MutationObserver(() => { state.changed = true; state.lastChange = Date.now(); });
          state.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          window[token] = state;
        }, token);
        try {
          await beforeAction();
          await search.press("Enter");
          await page.waitForFunction(token => window[token]?.changed && Date.now() - window[token].lastChange >= 500, token, { timeout: 15000 });
          result = { kind: "search_only", reason: "missing_expected_person",
            candidateCount: await page.locator(selectors.resultRows).filter({ visible: true }).count() };
        } finally {
          await page.evaluate(token => { window[token]?.observer.disconnect(); delete window[token]; }, token).catch(() => {});
        }
      }
      const page = await browser.page("pzu");
      const rateLimitVisible = /(?:\bHTTP\s*(?:error\s*)?429\b|\b429\s*(?:Too Many Requests|Error)\b|Too Many Requests|zbyt wiele (?:żądań|zapytań))/i.test(await page.locator("body").innerText());
      const safe = { rowNumber: row.rowNumber, kind: result.kind, elapsedMs: Date.now() - started, rateLimitVisible,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.candidateCount !== undefined ? { candidateCount: result.candidateCount } : {}) };
      report.results.push(safe);
      console.log(JSON.stringify(safe));
      if (rateLimitVisible || report.rateLimitEvents.length) throw new Error("ACCEPTANCE_HTTP_429_STOP");
    }
    report.allMatched = report.results.every(result => result.kind === "matched");
    report.completed = true;
  } catch (error) {
    report.errorCode = /^[A-Z][A-Z0-9_]+$/.test(error?.message || "") ? error.message : "ACCEPTANCE_IDENTITY_DIAGNOSTIC_FAILED";
    report.stoppedAtRow = activeRow;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await browser.close();
    const outputName = fiveRows ? "everest-18001-18005-20261015.json" : "identity-diagnostic-20261015.json";
    await fs.writeFile(path.join(root, "exports/live-acceptance", outputName), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ completed: report.completed, checkedRows: report.results.length, http429Count: report.rateLimitEvents.length, httpStatuses: report.httpStatuses }));
  }
}
main().catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error?.message || "") ? error.message : "ACCEPTANCE_IDENTITY_DIAGNOSTIC_FAILED"); process.exitCode = 1; });
