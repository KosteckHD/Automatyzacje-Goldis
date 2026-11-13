"use strict";
// Read-only searches for the human-reviewed scope. Customer values stay private.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { isValidPesel } = require("@goldis/core");
const { parseEnv, DIRECTORY } = require("./live-acceptance-18010-18020.cjs");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser.js");
const { PzuEverestSession } = require("../apps/worker/dist/portals/pzu/pzu-session.js");
const { EverestIdentityProvider } = require("../apps/worker/dist/portals/pzu/everest-identity-provider.js");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");
const ROWS = [18012,18013,18014,18015,18017,18018,18019,18020];
async function main() {
  const root = path.resolve(__dirname, "..");
  const env = parseEnv(await fs.readFile(path.join(root, ".env.acceptance.local"), "utf8"));
  const previous = JSON.parse(await fs.readFile(path.join(DIRECTORY, "report.json"), "utf8"));
  const directory = path.join(DIRECTORY, "review-3"); await fs.mkdir(directory, { recursive: true });
  const pool = new Pool({ connectionString: env.MIGRATOR_DATABASE_URL });
  const cfg = await buildAcceptancePortalConfig();
  cfg.pzu.everest.noResults = 'text=/^Brak wyników wyszukiwania(?:\\s*:|$)/';
  const browser = new BrowserSession({ profileDirectory: env.WORKER_PROFILE_DIR, headless: false });
  let limited = false;
  const report = { mode: "read_only_everest_review", results: [] };
  try {
    if ((await pool.query("SELECT count(*)::int AS n FROM worker_runtime_status WHERE observed_at > now() - interval '45 seconds'")).rows[0].n) throw new Error("REVIEW_WORKER_ACTIVE");
    browser.configureNavigationPolicy({ pzu: cfg.pzu, compensa: cfg.compensa });
    (await browser.open()).on("response", r => { if (r.status() === 429 && cfg.pzu.allowedOrigins.includes(new URL(r.url()).origin)) limited = true; });
    const page = await browser.page("pzu");
    const beforeAction = async () => { if (limited) throw new Error("PORTAL_HTTP_429"); await new Promise(r => setTimeout(r, 1000)); };
    const session = new PzuEverestSession(browser, { everestEntryUrl: cfg.pzu.entryUrl, allowedOrigins: cfg.pzu.allowedOrigins, selectors: cfg.pzu.session, beforeAction });
    let state = await session.signIn({ username: env.PZU_LOGIN, password: env.PZU_PASSWORD });
    const deadline = Date.now() + 30000;
    while (state === "waiting_for_sms" && Date.now() < deadline) { await new Promise(r => setTimeout(r, 1000)); state = await session.ensureAuthenticated(); }
    if (state !== "authenticated") throw new Error("REVIEW_AUTHENTICATION_REQUIRED");
    const provider = new EverestIdentityProvider(browser, session, { selectors: cfg.pzu.everest, adapterVersion: cfg.pzu.adapterVersion, beforeAction });
    for (const rowNumber of ROWS) {
      if (limited) throw new Error("PORTAL_HTTP_429");
      const runId = previous.rows.find(r => r.rowNumber === rowNumber).runId;
      const frozen = (await pool.query("SELECT source_row_id,input_snapshot FROM automation_runs WHERE id=$1", [runId])).rows[0];
      const source = { ...frozen.input_snapshot, id: frozen.source_row_id };
      const out = { rowNumber, source: { companyName: source.companyName, decisionMakerName: source.decisionMakerName, effectiveRegon: source.effectiveRegon }, candidates: [] };
      try { const result = await provider.findIdentity({ source }); out.result = { kind: result.kind, reason: result.reason, candidateCount: result.candidateCount }; }
      catch (e) { out.errorCode = /^[A-Z_]+$/.test(e.message) ? e.message : "REVIEW_SEARCH_FAILED"; }
      for (const row of await page.locator(cfg.pzu.everest.resultRows).all()) {
        if (!await row.isVisible()) continue;
        const read = key => row.locator(cfg.pzu.everest.fields[key]).first().innerText().then(s => s.trim()).catch(() => "");
        const [kind, name, identifier] = await Promise.all([read("accountType"),read("personName"),read("pesel")]);
        out.candidates.push({ kind, name, identifier, columns: await row.locator("td").allInnerTexts() });
      }
      out.noResults = await page.locator(cfg.pzu.everest.noResults).first().isVisible().catch(() => false);
      report.results.push(out);
      await fs.writeFile(path.join(directory, "everest-private.json"), JSON.stringify(report, null, 2));
      const vocabulary = new Map();
      const tokens = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-ząćęłńóśźż0-9]+/g," ").trim().split(/\s+/).filter(Boolean).map(t => { if (!vocabulary.has(t)) vocabulary.set(t, "w" + (vocabulary.size + 1)); return vocabulary.get(t); });
      console.log(JSON.stringify({ rowNumber, result: out.result, errorCode: out.errorCode, noResults: out.noResults, companyTokens: tokens(source.companyName), expectedPersonTokens: tokens(source.decisionMakerName), candidates: out.candidates.map(c => ({ kind: c.kind, nameTokens: tokens(c.name), identifierLength: c.identifier.replace(/\D/g, "").length, validPesel: isValidPesel(c.identifier.replace(/\D/g, "")), equalsSourceRegon: c.identifier.replace(/\s/g, "") === source.effectiveRegon })) }));
    }
  } finally { await browser.close(); await pool.end(); }
}
main().catch(e => { console.error(/^[A-Z_]+$/.test(e.message) ? e.message : "EVEREST_REVIEW_FAILED"); process.exitCode = 1; });
