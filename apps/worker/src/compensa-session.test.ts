import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "./browser";
import { CompensaPortalSession, type CompensaSessionOptions } from "./compensa-session";

const options: CompensaSessionOptions = {
  entryUrl: "https://goldis.test/compensa",
  selectors: {
    authenticated: '[data-screen="home"]',
    loginForm: '[data-screen="login"]',
    usernameInput: 'input[name="username"]',
    passwordInput: 'input[name="password"]',
    loginSubmit: '[data-action="login"]',
    smsChallenge: '[data-screen="sms"]',
    accessDenied: '[data-screen="denied"]',
  },
};

test("Compensa wymaga HTTPS i kompletnych selektorów stanu sesji", () => {
  assert.throws(() => new CompensaPortalSession({} as BrowserSession, { ...options, entryUrl: "http://goldis.test" }), /COMPENSA_SESSION_CONFIG_INVALID/);
  assert.throws(() => new CompensaPortalSession({} as BrowserSession, { ...options, allowedOrigins: ["http://goldis.test"] }), /COMPENSA_SESSION_CONFIG_INVALID/);
  assert.throws(() => new CompensaPortalSession({} as BrowserSession, {
    ...options, selectors: { ...options.selectors, smsChallenge: " " },
  }), /COMPENSA_SESSION_CONFIG_INVALID/);
});

test("aktywna sesja Compensy jest używana ponownie, a ekran MFA tylko zgłasza interwencję", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-session-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    let navigations = 0;
    await page.route("https://goldis.test/**", async (route) => {
      navigations += 1;
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
    });
    const session = new CompensaPortalSession(browser, options);
    assert.equal(await session.ensureAuthenticated(), "authenticated");
    assert.equal(navigations, 1);
    assert.equal(await session.signIn({ username: "synthetic-user", password: "synthetic-password" }), "authenticated");
    assert.equal(navigations, 1, "zalogowany profil nie przechodzi ponownie przez formularz logowania");

    await page.setContent('<main data-screen="sms"><input name="smsCode" value=""></main>');
    assert.equal(await session.ensureAuthenticated(), "waiting_for_sms");
    assert.equal(await page.locator('input[name="smsCode"]').inputValue(), "", "kod pozostaje do ręcznego podania przez operatora");

    await page.route("https://outside.test/**", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: '<main data-screen="home">Niepowiązana domena</main>',
    }));
    await page.goto("https://outside.test/untrusted");
    assert.equal(await session.ensureAuthenticated(), "access_denied", "marker ekranu logowania nie ufa nieznanej domenie");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
