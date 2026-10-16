"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { EverestIdentityProvider } = require("../dist/portals/pzu/everest-identity-provider.js");

module.exports = async ({ command, browser, owner, session, compensaSession, root, portals }) => {
  if (command === "lookup18001") {
    const config = JSON.parse(await fs.readFile(path.join(root, "config/pzu-everest.observed.json"), "utf8"));
    const context = JSON.parse(await fs.readFile(path.join(root, "exports/live-acceptance/context.json"), "utf8"));
    const row = (await owner.query(`SELECT id, row_number AS "rowNumber", company_name AS "companyName",
      decision_maker_name AS "decisionMakerName", effective_regon AS "effectiveRegon"
      FROM source_rows WHERE batch_id=$1 AND row_number=18001`, [context.batchId])).rows[0];
    if (!row) throw new Error("ACCEPTANCE_SOURCE_ROW_MISSING");
    const provider = new EverestIdentityProvider(browser, session, {
      selectors: config.selectors, adapterVersion: config.adapterVersion,
      credentials: () => ({ username: portals.PZU_LOGIN, password: portals.PZU_PASSWORD }),
    });
    const result = await provider.findIdentity({ source: row });
    console.log(JSON.stringify({ rowNumber: 18001, identityResult: result.kind,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.candidateCount !== undefined ? { candidateCount: result.candidateCount } : {}),
      ...(result.kind === "matched" ? { validPesel: true, matchedSourceRow: result.identity.sourceRowId === row.id } : {}),
    }));
    return { page: await browser.page("pzu") };
  }
  if (command === "open-communication") {
    if (!compensaSession || await compensaSession.ensureAuthenticated() !== "authenticated") throw new Error("COMPENSA_NOT_AUTHENTICATED");
    const page = await browser.page("compensa");
    const tile = page.locator('a:has-text("Compensa Komunikacja"):visible');
    if (await tile.count() !== 1) throw new Error("COMPENSA_TILE_AMBIGUOUS");
    await tile.click();
    console.log("COMPENSA_START_DIALOG_OPENED_NO_DRAFT_CREATED");
    return { page };
  }
};
