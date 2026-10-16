import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../../infrastructure/browser/browser";
import { CompensaPortalSession } from "./compensa-session";
import { CompensaClientChoice } from "./compensa-client-choice";

const selectors = { cards: ".client-card", selectButton: 'button:has-text("Wybierz Klienta")' };
const options = { entryUrl: "https://goldis.test/compensa", selectors: {
  authenticated: "#home", loginForm: "#login", usernameInput: "#user", passwordInput: "#password",
  loginSubmit: "#submit", smsChallenge: "#sms", accessDenied: "#denied",
} };
const card = (type: string, regon: string, pesel = "") => `<div class="client-card"><div>Nazwa: <b>Ala Testowa</b></div>
  <div>Typ Klienta: <b>${type}</b></div><div>PESEL: <b>${pesel}</b></div><div>REGON: <b>${regon}</b></div>
  <button onclick="window.selected++;document.querySelector('#matches').remove()"><span>Wybierz Klienta</span></button></div>`;
const business = "Osoba fizyczna prowadząca działalność gospodarczą";

for (const scenario of ["matched", "wrong-regon", "wrong-pesel", "ambiguous"] as const) {
  test(`Compensa chooses a business card by type and identifiers: ${scenario}`, { skip: process.env.PLAYWRIGHT_INTEGRATION !== "1" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "goldis-client-choice-"));
    const browser = new BrowserSession({ profileDirectory: directory });
    try {
      const page = await browser.page("compensa");
      await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body:
        `<main id="home">Home</main><script>window.selected=0;</script><div id="matches">${card("Osoba fizyczna", "")}${card(business,
          scenario === "wrong-regon" ? "987654321" : "012345678", scenario === "wrong-pesel" ? "90010100023" : "")}${scenario === "ambiguous" ? card(business, "012345678") : ""}</div>` }));
      await page.goto(options.entryUrl);
      let actions = 0;
      const choice = new CompensaClientChoice(browser, new CompensaPortalSession(browser, options), { selectors, beforeAction: async () => { actions++; } });
      assert.equal(await choice.selectIfVisible("012345678", "90010100016"), scenario === "matched" ? "selected" : "mismatch");
      assert.equal(await page.evaluate(() => (window as unknown as { selected: number }).selected), scenario === "matched" ? 1 : 0);
      assert.equal(actions, scenario === "matched" ? 1 : 0);
      if (scenario === "matched") assert.equal(await choice.selectIfVisible("012345678", "90010100016"), "absent");
    } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("missing source contact name is read from a verified business card without starting an offer", { skip: process.env.PLAYWRIGHT_INTEGRATION !== "1" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-client-name-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body:
      `<main id="home">Home</main><input placeholder="PESEL / REGON"><button onclick="document.querySelector('#matches').hidden=false">Przejdź do Klient 360</button>
      <script>window.selected=0;</script><div id="matches" hidden>${card("Osoba fizyczna", "")}${card(business, "012345678")}</div>` }));
    const choice = new CompensaClientChoice(browser, new CompensaPortalSession(browser, options), { selectors });
    assert.equal(await choice.resolvePersonName("012345678", "90010100016"), "Ala Testowa");
    assert.equal(await page.getByPlaceholder("PESEL / REGON").inputValue(), "90010100016");
    assert.equal(await page.evaluate(() => (window as unknown as { selected: number }).selected), 0);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
