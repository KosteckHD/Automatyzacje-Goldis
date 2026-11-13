"use strict";
// Read-only portal lookup: no Compensa form, save, or UFG request.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { DIRECTORY, parseEnv } = require("./live-acceptance-18010-18020.cjs");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser.js");
const { PzuEverestSession } = require("../apps/worker/dist/portals/pzu/pzu-session.js");
const { EverestIdentityProvider } = require("../apps/worker/dist/portals/pzu/everest-identity-provider.js");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");
async function main() {
  const env = parseEnv(await fs.readFile(path.resolve(__dirname, "../.env.acceptance.local"), "utf8"));
  const report = JSON.parse(await fs.readFile(path.join(DIRECTORY, "report.json"), "utf8"));
  const rowNumber = process.argv.includes("--row-18017") ? 18017 : 18013;
  if (process.argv.slice(2).some(a => a !== "--row-18017")) throw new Error("DIAGNOSTIC_SCOPE_INVALID");
  const row = report.rows.find(r => r.rowNumber === rowNumber);
  if (report.state !== "paused_for_review" || !row?.runId || row.status !== "waiting_for_manual_data") throw new Error("DIAGNOSTIC_SCOPE_INVALID");
  const pool = new Pool({ connectionString: env.MIGRATOR_DATABASE_URL });
  const cfg = await buildAcceptancePortalConfig();
  const browser = new BrowserSession({ profileDirectory: env.WORKER_PROFILE_DIR, headless: false });
  const diagnostic = { rowNumber, mode: "identity_lookup_only", startedAt: new Date().toISOString(), navigations: 0, requests: {}, errors: [] };
  try {
    const active = await pool.query("SELECT count(*)::int AS n FROM worker_runtime_status WHERE observed_at > now() - interval '45 seconds'");
    if (active.rows[0].n) throw new Error("DIAGNOSTIC_WORKER_STILL_ACTIVE");
    const frozen = (await pool.query("SELECT input_snapshot FROM automation_runs WHERE id=$1", [row.runId])).rows[0].input_snapshot;
    browser.configureNavigationPolicy({ pzu: cfg.pzu, compensa: cfg.compensa });
    const context = await browser.open();
    context.on("response", r => { const status = r.status(); diagnostic.requests[status] = (diagnostic.requests[status] || 0) + 1; });
    const page = await browser.page("pzu");
    let stage = "sign_in";
    page.on("framenavigated", frame => { if (stage === "search" && frame === page.mainFrame()) diagnostic.navigations++; });
    page.on("pageerror", () => diagnostic.errors.push("PAGE_ERROR"));
    const session = new PzuEverestSession(browser, { everestEntryUrl: cfg.pzu.entryUrl, allowedOrigins: cfg.pzu.allowedOrigins, selectors: cfg.pzu.session });
    diagnostic.session = await session.signIn({ username: env.PZU_LOGIN, password: env.PZU_PASSWORD });
    if (diagnostic.session !== "authenticated") throw new Error("DIAGNOSTIC_AUTHENTICATION_REQUIRED");
    const provider = new EverestIdentityProvider(browser, session, { selectors: cfg.pzu.everest, adapterVersion: cfg.pzu.adapterVersion, beforeAction: async () => { await page.waitForTimeout(1000); } });
    stage = "search";
    try { const result = await provider.findIdentity({ source: { ...frozen, id: frozen.sourceRowId } }); diagnostic.result = { kind: result.kind, reason: result.reason, candidateCount: result.candidateCount }; }
    catch (e) { diagnostic.errorCode = /^[A-Z_]+$/.test(e.message) ? e.message : "DIAGNOSTIC_LOOKUP_FAILED"; }
    diagnostic.searchInputs = await page.locator(cfg.pzu.everest.searchInput).evaluateAll(elements => elements.map(e => ({ tag: e.tagName, name: e.getAttribute("name"), placeholder: e.getAttribute("placeholder"), visible: e.getClientRects().length > 0 })));
    diagnostic.results = await page.locator(cfg.pzu.everest.resultRows).count();
    diagnostic.inputMatchesSource = await page.locator(cfg.pzu.everest.searchInput).inputValue().then(v => v === frozen.effectiveRegon).catch(() => false);
    diagnostic.noResultsVisible = await page.locator(cfg.pzu.everest.noResults).first().isVisible().catch(() => false);
    diagnostic.authenticatedAfter = await session.ensureAuthenticated();
    await fs.writeFile(path.join(DIRECTORY, `${rowNumber}-everest-private.html`), await page.content());
    await page.screenshot({ path: path.join(DIRECTORY, `${rowNumber}-everest-diagnostic.png`), fullPage: true });
  } finally { await browser.close(); await pool.end(); await fs.writeFile(path.join(DIRECTORY, `${rowNumber}-identity-diagnostic.json`), JSON.stringify(diagnostic, null, 2)); console.log(JSON.stringify(diagnostic)); }
}
main().catch(e => { console.error(/^[A-Z_]+$/.test(e.message) ? e.message : "DIAGNOSTIC_FAILED"); process.exitCode = 1; });
