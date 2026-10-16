"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const { Pool } = require("pg");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser.js");
const { CompensaPortalSession } = require("../apps/worker/dist/portals/compensa/compensa-session.js");
const { CompensaClientChoice } = require("../apps/worker/dist/portals/compensa/compensa-client-choice.js");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");
const parse = text => Object.fromEntries(text.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^['"]|['"]$/g, "")]));
async function main() {
  const root = path.resolve(__dirname, "..");
  const env = parse(await fs.readFile(path.join(root, ".env.acceptance.local"), "utf8"));
  const credentials = parse(await fs.readFile(path.join(root, ".env"), "utf8"));
  Object.assign(process.env, env);
  const { PgRunRepository } = require("../apps/worker/dist/infrastructure/database/pg-run-repository.js");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const saved = JSON.parse(await fs.readFile(path.join(root, "exports/live-acceptance/context-five-full-20261015-v6.json"), "utf8"));
  const item = saved.runs.find(item => item.rowNumber === 18005);
  const run = await new PgRunRepository(pool).load(item.runId);
  const record = (await pool.query("SELECT external_case_ref FROM automation_runs WHERE id=$1", [item.runId])).rows[0];
  if (!run.identity || !record.external_case_ref) throw new Error("EXISTING_CASE_REQUIRED");
  const config = await buildAcceptancePortalConfig();
  const browser = new BrowserSession({ profileDirectory: env.WORKER_PROFILE_DIR, headless: false });
  browser.configureNavigationPolicy({ pzu: config.pzu, compensa: config.compensa });
  try {
    const page = await browser.page("compensa");
    const session = new CompensaPortalSession(browser, { entryUrl: config.compensa.entryUrl, allowedOrigins: config.compensa.allowedOrigins, selectors: config.compensa.session });
    const choice = new CompensaClientChoice(browser, session, { selectors: { cards: config.compensa.form.customerMatches, selectButton: config.compensa.form.customerMatchSelect },
      credentials: () => ({ username: credentials.COMPENSA_LOGIN, password: credentials.COMPENSA_PASSWORD }) });
    await choice.resolvePersonName(run.source.effectiveRegon, run.identity.pesel);
    console.log(JSON.stringify({ choice: await choice.selectIfVisible(run.source.effectiveRegon, run.identity.pesel) }));
    await page.waitForTimeout(2000);
    console.log(JSON.stringify({ selectorCounts: await Promise.all(["startDialog", "registrationInput", "roleSelect", "startCommunication"].map(async key => ({key, count:await page.locator(config.compensa.form[key]).count()}))) }));
    const tile = page.locator(config.compensa.form.communicationTile);
    console.log(JSON.stringify({ communicationTiles: await tile.count() }));
    await tile.click();
    await page.waitForTimeout(2000);
    console.log(JSON.stringify({ dialogSelectorCounts: await Promise.all(["startDialog", "registrationInput", "roleSelect", "startCommunication"].map(async key => ({key, count:await page.locator(config.compensa.form[key]).count()}))) }));
    console.log(JSON.stringify({ startDialogVisible: await page.locator(config.compensa.form.startDialog).isVisible(), insuredVisible: await page.locator(config.compensa.form.insuredDataSection).isVisible(), visibleFieldLabels: await page.locator("label").filter({visible:true}).allInnerTexts() }));
    const reference = record.external_case_ref.replace(/\s/g, "");
    const candidate = page.getByText(new RegExp("^" + reference.split("/").join("\\s*/\\s*") + "$"));
    console.log(JSON.stringify({ existingCaseLinkCount: await candidate.count() }));
    if (await candidate.count() === 1) {
      console.log(JSON.stringify({ referenceAncestors: await candidate.evaluate(e=>{const items=[];for(let el=e,depth=0;el&&depth<5;el=el.parentElement,depth++)items.push({tag:el.tagName,classes:el.className});return items;}) }));
      const row = page.locator("tr").filter({ has: candidate });
      console.log(JSON.stringify({ rowActions: await row.locator("a,button,[role=button]").evaluateAll(elements => elements.map(e => ({tag:e.tagName,classes:e.className,caption:e.textContent.trim().replace(/\d/g,"#").slice(0,60)}))) }));
      console.log(JSON.stringify({ rowControls: await row.locator("*").evaluateAll(elements => elements.filter(e => [...e.attributes].some(a => /click|toggle|menu/.test(a.name)) || /(?:^| )i-/.test(e.className)).map(e => ({tag:e.tagName,classes:e.className,attrs:[...e.attributes].filter(a => /click|toggle|menu/.test(a.name)).map(a=>[a.name,a.value])}))) }));
      const buttons = row.locator("button").filter({ visible: true });
      if (await buttons.count() === 1) { await buttons.click(); await page.waitForTimeout(300); }
      console.log(JSON.stringify({ menu: await page.locator(".dropdown-menu").filter({visible:true}).allInnerTexts() }));
    }
    await page.screenshot({ path: path.join(root, "exports/live-acceptance/compensa-existing-case-inspection.png") });
    console.log(JSON.stringify({ icons: await page.locator('[class*="edit"],[class*="pencil"]').evaluateAll(elements => elements.filter(e => e.getClientRects().length).map(e => ({ tag: e.tagName, classes: e.className,
      parent: e.parentElement ? { tag: e.parentElement.tagName, classes: e.parentElement.className, id: e.parentElement.id, role: e.parentElement.getAttribute("role") } : null }))),
      safeButtons: await page.locator("a,button").evaluateAll(elements => elements.filter(e => e.getClientRects().length && /^(?:Oferty|Zobacz|Szczegóły|Dane|Edytuj|Pokaż)/i.test(e.textContent.trim())).map(e => ({ tag: e.tagName, classes: e.className, caption: e.textContent.trim().replace(/\d/g, "#").slice(0, 60) }))) }));
  } finally { await browser.close(); await pool.end(); }
}
main().catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "EXISTING_CASE_INSPECTION_FAILED"); process.exitCode = 1; });
