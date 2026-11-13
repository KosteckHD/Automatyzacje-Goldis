import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "../../infrastructure/browser/browser";
import { PzuEverestSession } from "./pzu-session";

const entryUrl = "https://goldis.test/everest";
const smsPath = "/internalauth/authenticate/sms";
const loginForm = `<form data-screen="login"><input name="username"><input name="password"><button type="button" data-action="login" onclick="window.loginSubmitted=true">Login</button></form>`;
const codeForm = `<form><input id="code" name="code" type="text"><button type="button" id="confirm-code" onclick="parent.codeSubmitted=true">Confirm</button></form>`;
const selectors = {
  authenticated: '[data-screen="home"]',
  loginForm: '[data-screen="login"]',
  usernameInput: 'input[name="username"]',
  passwordInput: 'input[name="password"]',
  loginSubmit: '[data-action="login"]',
  smsChallenge: "iframe#secfense_iframe",
  smsFrame: "iframe#secfense_iframe",
  smsFramePath: smsPath,
  smsCodeInput: 'input#code[name="code"][type="text"]',
  smsCodeSubmit: "button#confirm-code",
  accessDenied: '[data-screen="denied"]',
};

async function inSyntheticFrame(framePath: string, frameBody: string, action: (browser: BrowserSession) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-sms-detector-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("**/*", route => {
      const target = new URL(route.request().url());
      if (target.hostname !== "goldis.test") return route.abort();
      return route.fulfill({ contentType: "text/html", body: target.pathname === "/everest"
        ? `${loginForm}<iframe id="secfense_iframe" src="${framePath}"></iframe>`
        : frameBody });
    });
    await page.goto(entryUrl);
    await page.frameLocator(selectors.smsFrame).locator("body").waitFor();
    await action(browser);
  } finally {
    await browser.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("TEST_PROFILE_OUTSIDE_TEMP");
    await rm(directory, { recursive: true, force: true });
  }
}

test("Secfense non-SMS methods with the same code fields are not reported as SMS", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  await inSyntheticFrame("/internalauth/authenticate/totp", codeForm, async browser => {
    const session = new PzuEverestSession(browser, { everestEntryUrl: entryUrl, selectors, transitionTimeoutMs: 150 });
    assert.equal(await session.signIn({ username: "fixture", password: "fixture" }), "unknown");
    const page = await browser.page("pzu");
    assert.deepEqual(await page.locator('input[name="username"],input[name="password"]').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)), ["", ""]);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { loginSubmitted?: boolean }).loginSubmitted)), false);
  });
});

test("an empty or ambiguous Secfense frame cannot create an SMS challenge", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  for (const body of [
    "<p>Authentication is loading</p>",
    '<input id="code" name="code" type="text">',
    '<input id="code" name="code" type="text" hidden><button id="confirm-code">Confirm</button>',
    codeForm.replace("</form>", '<button id="confirm-code">Another confirm</button></form>'),
  ]) {
    await inSyntheticFrame(smsPath, body, async browser => {
      const session = new PzuEverestSession(browser, { everestEntryUrl: entryUrl, selectors, transitionTimeoutMs: 150 });
      assert.equal(await session.signIn({ username: "fixture", password: "fixture" }), "unknown");
      const page = await browser.page("pzu");
      assert.equal(await page.evaluate(() => Boolean((window as unknown as { loginSubmitted?: boolean }).loginSubmitted)), false);
    });
  }
});

test("the confirmed SMS route and visible code form are recognized without submitting anything", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  await inSyntheticFrame(smsPath, codeForm, async browser => {
    const session = new PzuEverestSession(browser, { everestEntryUrl: entryUrl, selectors, transitionTimeoutMs: 150 });
    assert.equal(await session.signIn({ username: "fixture", password: "fixture" }), "waiting_for_sms");
    const page = await browser.page("pzu");
    assert.equal(await page.frameLocator(selectors.smsFrame).locator(selectors.smsCodeInput).inputValue(), "");
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { codeSubmitted?: boolean }).codeSubmitted)), false);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { loginSubmitted?: boolean }).loginSubmitted)), false);
  });
});

test("SMS recognition waits for the code form inside a loading Secfense frame", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  await inSyntheticFrame(smsPath, `<p>Loading</p><script>setTimeout(()=>document.body.innerHTML=${JSON.stringify(codeForm)},250)</script>`, async browser => {
    const session = new PzuEverestSession(browser, { everestEntryUrl: entryUrl, selectors, transitionTimeoutMs: 1000 });
    assert.equal(await session.ensureAuthenticated(), "waiting_for_sms");
    const page = await browser.page("pzu");
    assert.equal(await page.frameLocator(selectors.smsFrame).locator(selectors.smsCodeInput).isVisible(), true);
  });
});
