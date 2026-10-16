"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser.js");
const { CompensaPortalSession } = require("../apps/worker/dist/portals/compensa/compensa-session.js");
const { buildAcceptancePortalConfig } = require("./prepare-acceptance-portal-config.cjs");
async function main() {
  const root = path.resolve(__dirname, "..");
  const credentials = Object.fromEntries((await fs.readFile(path.join(root, ".env"), "utf8")).split(/\r?\n/)
    .map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^['"]|['"]$/g, "")]));
  const config = await buildAcceptancePortalConfig();
  const browser = new BrowserSession({ profileDirectory: path.join(process.env.LOCALAPPDATA, "Goldis/pzu-login-rgswyS"), headless: false });
  browser.configureNavigationPolicy({ pzu: config.pzu, compensa: config.compensa });
  try {
    const page = await browser.page("compensa");
    const selectors = { ...config.compensa.session }; delete selectors.optionalOverlay;
    const session = new CompensaPortalSession(browser, { entryUrl: config.compensa.entryUrl, allowedOrigins: config.compensa.allowedOrigins, selectors });
    console.log(JSON.stringify({ state: await session.signIn({ username: credentials.COMPENSA_LOGIN, password: credentials.COMPENSA_PASSWORD }) }));
    await page.waitForTimeout(2000);
    console.log(JSON.stringify({ dialogs: await page.locator('ux-dialog,[role="dialog"],.modal').filter({visible:true}).evaluateAll(elements => elements.map(e => ({ tag:e.tagName, classes:e.className, heading:e.querySelector('ux-dialog-header,h1,h2,h3,.modal-title')?.textContent.trim(), buttons:[...e.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),classes:b.className})), images:[...e.querySelectorAll('img')].map(i=>({alt:i.alt,classes:i.className})) }))) }));
    await page.screenshot({path:path.join(root,"exports/live-acceptance/portal-notices-inspection.png")});
    const configuredSession = new CompensaPortalSession(browser, { entryUrl: config.compensa.entryUrl, allowedOrigins: config.compensa.allowedOrigins, selectors: config.compensa.session });
    await configuredSession.ensureAuthenticated();
    await page.waitForTimeout(1500);
    console.log(JSON.stringify({ remainingDialogs: await page.locator('ux-dialog,[role="dialog"],.modal').filter({visible:true}).evaluateAll(elements => elements.map(e => ({tag:e.tagName,classes:e.className,heading:e.querySelector('ux-dialog-header,h1,h2,h3,.modal-title')?.textContent.trim(),buttons:[...e.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),classes:b.className})),images:[...e.querySelectorAll('img')].map(i=>({alt:i.alt,classes:i.className}))}))) }));
    await page.screenshot({path:path.join(root,"exports/live-acceptance/portal-notices-after-maintenance.png")});
  } finally { await browser.close(); }
}
main().catch(()=>{console.error("PORTAL_NOTICE_INSPECTION_FAILED");process.exitCode=1;});
