"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { BrowserSession } = require("../dist/infrastructure/browser/browser.js");
const { CompensaPortalSession } = require("../dist/portals/compensa/compensa-session.js");
const { loadPortalRuntimeConfig } = require("../dist/portals/shared/portal-runtime-config.js");

// Read-only session preflight. Never fills credentials, submits MFA or opens an offer.
async function main() {
  const root = path.resolve(__dirname, "../../..");
  const parent = await fs.realpath(path.join(process.env.LOCALAPPDATA, "Goldis"));
  const profile = await fs.realpath(process.argv[2]);
  if (path.dirname(profile).toLowerCase() !== parent.toLowerCase() || !/^pzu-login-[a-z0-9]+$/i.test(path.basename(profile))) throw new Error("PROFILE_SCOPE_INVALID");
  const config = await loadPortalRuntimeConfig(path.join(root, "exports/live-acceptance/candidate-portals.json"));
  const browser = new BrowserSession({ profileDirectory: profile, headless: false });
  browser.configureNavigationPolicy({ pzu: config.pzu, compensa: config.compensa });
  const input = readline.createInterface({ input: process.stdin, terminal: true });
  try {
    const page = await browser.page("compensa");
    await page.goto(config.compensa.entryUrl);
    const session = new CompensaPortalSession(browser, { entryUrl: config.compensa.entryUrl, allowedOrigins: config.compensa.allowedOrigins, selectors: config.compensa.session });
    for await (const line of input) {
      if (line.trim() === "quit") break;
      if (line.trim() === "status") {
        const state = await session.ensureAuthenticated();
        const caseMarker = page.locator(config.compensa.save.caseReference);
        console.log(JSON.stringify({ portal: "compensa", state, caseMarkerCount: await caseMarker.count(), loginSubmitted: false, smsSubmitted: false }));
      }
    }
  } finally { input.close(); await browser.close(); }
}
main().catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "REMEMBERED_SESSION_INSPECTION_FAILED"); process.exitCode = 1; });
