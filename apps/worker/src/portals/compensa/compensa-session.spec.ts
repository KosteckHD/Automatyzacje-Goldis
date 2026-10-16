import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "../../infrastructure/browser/browser";
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

const noticeSelectors = {
  container: 'ux-dialog.tm-modal-news:has(ux-dialog-header p:text-is("Przerwa techniczna")):has(ux-dialog-body:has-text("będzie niedostępna"))',
  dismissButton: 'button:has-text("Zamknij")',
};

for (const delayMs of [0, 250]) {
  test(`Compensa dismisses a planned-maintenance notice before continuing, delay=${delayMs}`, {
    skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-notice-"));
    const browser = new BrowserSession({ profileDirectory: directory });
    try {
      const page = await browser.page("compensa");
      await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
        <main data-screen="home">Home</main><button id="communication" onclick="window.communicationOpenCount++">Compensa Komunikacja</button>
        <div id="overlay" style="display:none;position:fixed;inset:0;background:white"><ux-dialog class="tm-modal-news"><ux-dialog-header><p>Przerwa techniczna</p></ux-dialog-header><ux-dialog-body>W związku z zaplanowanymi pracami aplikacja będzie niedostępna.</ux-dialog-body><button id="random-${delayMs}" onclick="window.noticeCloseCount++;document.getElementById('overlay').remove()"><span><span class="i-close"></span><span>Zamknij</span></span></button></ux-dialog></div>
        <script>window.noticeCloseCount=0;window.communicationOpenCount=0;setTimeout(()=>{
          document.getElementById('overlay').style.display='block';
        },${delayMs});</script>` }));
      let fencedActions = 0;
      const session = new CompensaPortalSession(browser, { ...options,
        selectors: { ...options.selectors, optionalOverlay: noticeSelectors }, beforeAction: async () => { fencedActions++; } });
      assert.equal(await session.signIn(), "authenticated");
      assert.equal(await page.locator("#overlay").count(), 0);
      await page.locator("#communication").click();
      assert.equal(await page.evaluate(() => (window as unknown as { communicationOpenCount: number }).communicationOpenCount), 1);
      assert.equal(await session.ensureAuthenticated(), "authenticated");
      assert.equal(await page.evaluate(() => (window as unknown as { noticeCloseCount: number }).noticeCloseCount), 1);
      assert.equal(fencedActions, 2, "navigation and dismissal both use the action gate");
    } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("Compensa never guesses between duplicate notice close buttons", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-notice-ambiguous-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
      <main data-screen="home">Home</main><ux-dialog class="tm-modal-news"><ux-dialog-header><p>Przerwa techniczna</p></ux-dialog-header>
      <ux-dialog-body>aplikacja będzie niedostępna</ux-dialog-body><button onclick="window.clicked=true">Zamknij</button><button onclick="window.clicked=true">Zamknij</button></ux-dialog>` }));
    const session = new CompensaPortalSession(browser, { ...options, selectors: { ...options.selectors, optionalOverlay: noticeSelectors } });
    await assert.rejects(session.ensureAuthenticated(), /PORTAL_NOTICE_UNHANDLED/);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { clicked?: boolean }).clicked)), false);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an active maintenance page is not dismissed as a future announcement", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-maintenance-active-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
      <ux-dialog class="tm-modal-news"><ux-dialog-header><p>Przerwa techniczna</p></ux-dialog-header>
      <ux-dialog-body>Przerwa techniczna trwa. Portal jest niedostępny.</ux-dialog-body><button onclick="window.clicked=true">Zamknij</button></ux-dialog>` }));
    const session = new CompensaPortalSession(browser, { ...options, transitionTimeoutMs: 100,
      selectors: { ...options.selectors, optionalOverlay: noticeSelectors } });
    assert.equal(await session.ensureAuthenticated(), "unknown");
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { clicked?: boolean }).clicked)), false);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Compensa waits for the SPA login screen before sending credentials once", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-spa-login-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("compensa");
    await page.route("**/*", route => new URL(route.request().url()).hostname === "goldis.test"
      ? route.fulfill({ contentType: "text/html", body: `<main id="app"></main><script>
        window.submissions=0;
        setTimeout(() => document.querySelector('#app').innerHTML = '<section data-screen="login"><input name="username"><input name="password" type="password"><button data-action="login" onclick="window.submissions++;document.querySelector(\\\'#app\\\').innerHTML=\\\'<section data-screen=home>Home</section>\\\'">Login</button></section>', 250);
      </script>` }) : route.abort());
    const session = new CompensaPortalSession(browser, { ...options, transitionTimeoutMs: 1000 });
    assert.equal(await session.signIn({ username: "synthetic-user", password: "synthetic-password" }), "authenticated");
    assert.equal(await page.evaluate(() => (window as unknown as { submissions: number }).submissions), 1);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a confirmed successful login permits authentication again after a fresh application entry", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-new-login-cycle-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
      <section data-screen="login"><input name="username"><input name="password" type="password"><button data-action="login" onclick="window.submissions++;document.querySelector('section').setAttribute('data-screen','home')">Login</button></section><script>window.submissions=0;</script>` }));
    const session = new CompensaPortalSession(browser, options);
    const credentials = { username: "synthetic-user", password: "synthetic-password" };
    assert.equal(await session.signIn(credentials), "authenticated");
    assert.equal(await page.evaluate(() => (window as unknown as { submissions: number }).submissions), 1);
    assert.equal(await session.openApplicationEntry(), "login_required");
    assert.equal(await session.signIn(credentials), "authenticated");
    assert.equal(await page.evaluate(() => (window as unknown as { submissions: number }).submissions), 1);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

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
    const html = await readFile(resolve(process.cwd(), "src", "testing", "fixtures", "compensa-portal.html"), "utf8");
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
