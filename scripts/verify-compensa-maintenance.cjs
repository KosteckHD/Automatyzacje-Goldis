"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { BrowserSession } = require("../apps/worker/dist/infrastructure/browser/browser.js");
const { CompensaPortalSession } = require("../apps/worker/dist/portals/compensa/compensa-session.js");
const { loadPortalRuntimeConfig } = require("../apps/worker/dist/portals/shared/portal-runtime-config.js");
let phase = "configuration";
async function main() {
  const root = path.resolve(__dirname, "..");
  const directory = path.join(root, "exports/live-acceptance");
  const credentials = Object.fromEntries((await fs.readFile(path.join(root, ".env"), "utf8")).split(/\r?\n/)
    .map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map(match => [match[1], match[2].trim().replace(/^['"]|['"]$/g, "")]));
  const config = await loadPortalRuntimeConfig(path.join(directory, "candidate-portals.json"));
  const browser = new BrowserSession({ profileDirectory: path.join(process.env.LOCALAPPDATA, "Goldis/pzu-login-rgswyS"), headless: false });
  browser.configureNavigationPolicy({ pzu: config.pzu, compensa: config.compensa });
  try {
    phase = "browser";
    const context = await browser.open();
    await context.addInitScript(() => {
      window.__maintenanceDismissCount = 0;
      document.addEventListener("click", event => {
        const button = event.target.closest?.("button");
        const dialog = button?.closest("ux-dialog.tm-modal-news");
        if (button?.innerText.trim() === "Zamknij" && dialog?.querySelector("ux-dialog-header")?.innerText.trim() === "Przerwa techniczna") window.__maintenanceDismissCount++;
      }, true);
    });
    const page = await browser.page("compensa");
    const session = new CompensaPortalSession(browser, { entryUrl: config.compensa.entryUrl,
      allowedOrigins: config.compensa.allowedOrigins, selectors: config.compensa.session });
    phase = "sign-in-and-dismiss";
    const state = await session.signIn({ username: credentials.COMPENSA_LOGIN, password: credentials.COMPENSA_PASSWORD });
    console.log(JSON.stringify({ state }));
    assert.equal(state, "authenticated");
    phase = "verify-dismissal";
    const dismissCount = await page.evaluate(() => window.__maintenanceDismissCount);
    assert.equal(dismissCount, 1);
    assert.equal(await page.locator(config.compensa.session.optionalOverlay.container).filter({ visible: true }).count(), 0);
    phase = "open-communication-dialog";
    const tile = page.locator(config.compensa.form.communicationTile);
    assert.equal(await tile.count(), 1);
    await tile.click();
    await page.locator(config.compensa.form.startDialog).waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: path.join(directory, "compensa-maintenance-after.png") });
    const report = { checkedAt: new Date().toISOString(), state, noticeDismissCount: dismissCount,
      noticeHidden: true, communicationStartDialogVisible: true, offerStarted: false, customerDataSubmitted: false };
    await fs.writeFile(path.join(directory, "compensa-maintenance-verification-20261015.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    const page = await browser.page("compensa");
    await page.screenshot({ path: path.join(directory, "compensa-maintenance-failure.png") }).catch(() => {});
    const notice = page.locator(config.compensa.session.optionalOverlay.container).filter({ visible: true });
    console.log(JSON.stringify({ diagnostic: true, visibleNoticeCount: await notice.count(),
      closeButtonCount: await notice.locator(config.compensa.session.optionalOverlay.dismissButton).filter({ visible: true }).count(),
      dismissCount: await page.evaluate(() => window.__maintenanceDismissCount),
      dialogHeaders: await page.locator("ux-dialog-header").allTextContents() }));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => {
  console.error("COMPENSA_NOTICE_LIVE_VERIFICATION_FAILED", phase,
    /^[A-Z][A-Z0-9_]+$/.test(error?.message || "") ? error.message : error?.name);
  process.exitCode = 1;
});
