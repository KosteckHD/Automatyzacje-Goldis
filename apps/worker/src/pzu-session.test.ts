import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "./browser";
import { PzuEverestSession, type PzuSessionOptions } from "./pzu-session";

const url = "https://goldis.test/everest";
const options: PzuSessionOptions = {
  everestEntryUrl: url,
  selectors: {
    authenticated: '[data-screen="home"]',
    loginForm: '[data-screen="login"]',
    usernameInput: 'input[name="username"]',
    passwordInput: 'input[name="password"]',
    loginSubmit: '[data-action="login"]',
    smsChallenge: '[data-screen="sms"]',
    smsCodeInput: 'input[name="code"]',
    smsCodeSubmit: '[data-action="submit-sms"]',
    accessDenied: '[data-screen="denied"]',
  },
  transitionTimeoutMs: 1_000,
};

test("observed PZU selectors submit through the SMS frame and remember the device", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const observed = JSON.parse(await readFile(resolve(__dirname, "../../../config/pzu-sms.observed.json"), "utf8"));
  const example = JSON.parse(await readFile(resolve(__dirname, "../../../config/portal-selectors.example.json"), "utf8"));
  const documented = JSON.parse(await readFile(resolve(__dirname, "../../../docs/portal-selectors.example.json"), "utf8"));
  for (const [key, selector] of Object.entries(observed.session)) {
    assert.equal(example.pzu.session[key], selector, "example must use the captured SMS selectors");
    assert.equal(documented.pzu.session[key], selector, "documented example must use the captured SMS selectors");
  }
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-observed-sms-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("**/*", (route) => {
      const target = new URL(route.request().url());
      if (target.hostname !== "goldis.test") return route.abort();
      return route.fulfill({ status: 200, contentType: "text/html", body: target.pathname === "/sms"
        ? `<form onsubmit="return false"><div class="bg-image totp-auth">
          <input id="code" name="code" type="text">
          <div class="fprint_wrap"><input id="fprint_state" name="fprint_state" type="checkbox"></div>
          <div class="buttons"><a id="needHelpBtn">Help</a><a id="resend" onclick="parent.resends=(parent.resends||0)+1">Resend</a>
          <button class="btn btn-primary" onclick="parent.submissions=(parent.submissions||0)+1;parent.correctCode=document.querySelector('#code').value==='123456';parent.remembered=document.querySelector('#fprint_state').checked;parent.document.body.innerHTML='<main data-screen=home>Authenticated</main>'"><span>Submit</span></button></div>
          </div></form>`
        : `<iframe id="secfense_iframe" src="/sms"></iframe>` });
    });
    await page.goto(url);
    await page.frameLocator(observed.session.smsFrame).locator(observed.session.smsCodeInput).waitFor();
    const session = new PzuEverestSession(browser, { ...options, selectors: { ...options.selectors, ...observed.session } });
    assert.equal(await session.ensureAuthenticated(), "waiting_for_sms");
    await page.frameLocator(observed.session.smsFrame).locator("form").evaluate((form) => {
      form.insertAdjacentHTML("beforeend", '<div class="errors_wrapper"><span class="errors">SMS code expired</span></div>');
    });
    const expired = Buffer.from("654321");
    assert.equal(await session.submitSmsCode(expired, new Date(Date.now() + 300_000)), "expired");
    assert.deepEqual([...expired], [0, 0, 0, 0, 0, 0]);
    assert.equal(await page.frameLocator(observed.session.smsFrame).locator(observed.session.smsCodeInput).inputValue(), "");
    assert.equal(await page.evaluate(() => (window as unknown as { submissions?: number }).submissions ?? 0), 0);
    await page.frameLocator(observed.session.smsFrame).locator(".errors_wrapper").evaluate((element) => element.remove());
    const code = Buffer.from("123456");
    assert.equal(await session.submitSmsCode(code, new Date(Date.now() + 300_000)), "accepted");
    assert.deepEqual([...code], [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(await page.evaluate(() => {
      const state = window as unknown as { submissions: number; correctCode: boolean; remembered: boolean; resends?: number };
      return { submissions: state.submissions, correctCode: state.correctCode, remembered: state.remembered, resends: state.resends ?? 0 };
    }), { submissions: 1, correctCode: true, remembered: true, resends: 0 });
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PZU does not submit an expired code, including expiry immediately before the browser action", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-deadline-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "goldis.test"
      ? route.fulfill({ status: 200, contentType: "text/html", body: `<main data-screen="sms"><input name="code"><button data-action="submit-sms" onclick="window.submissions=(window.submissions||0)+1">Submit</button></main>` })
      : route.abort());
    await page.goto(url);
    const session = new PzuEverestSession(browser, options);
    const expired = Buffer.from("123456");
    assert.equal(await session.submitSmsCode(expired, new Date(Date.now() - 1)), "expired");
    assert.deepEqual([...expired], [0, 0, 0, 0, 0, 0]);
    const duringAction = new PzuEverestSession(browser, { ...options, beforeAction: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    } });
    const late = Buffer.from("654321");
    assert.equal(await duringAction.submitSmsCode(late, new Date(Date.now() + 150)), "expired");
    assert.deepEqual([...late], [0, 0, 0, 0, 0, 0]);
    assert.equal(await page.locator('input[name="code"]').inputValue(), "");
    assert.equal(await page.evaluate(() => (window as unknown as { submissions?: number }).submissions ?? 0), 0);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("observed PZU resend waits for a delayed link and never falls back to login", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const observed = JSON.parse(await readFile(resolve(__dirname, "../../../config/pzu-sms.observed.json"), "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-delayed-resend-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  let mode: "delayed" | "absent" | "duplicate" | "revoked" = "delayed";
  try {
    const page = await browser.page("pzu");
    await page.route("**/*", (route) => {
      const target = new URL(route.request().url());
      if (target.hostname !== "goldis.test") return route.abort();
      const link = `<a id="resend" onclick="parent.resends=(parent.resends||0)+1">Resend</a>`;
      const body = `<form><input id="code" name="code" type="text"><div class="buttons">${mode === "duplicate" ? link + link : ""}</div></form>`;
      return route.fulfill({ status: 200, contentType: "text/html", body: target.pathname === "/sms"
        ? body + (mode === "delayed" ? `<script>setTimeout(()=>document.querySelector('.buttons').insertAdjacentHTML('beforeend', ${JSON.stringify(link)}),20000)</script>` : "")
        : `<iframe id="secfense_iframe" src="/sms"></iframe>` });
    });
    const session = new PzuEverestSession(browser, { ...options, selectors: { ...options.selectors, ...observed.session } });
    const open = async () => {
      await page.goto(url);
      await page.frameLocator(observed.session.smsFrame).locator(observed.session.smsCodeInput).waitFor();
    };
    await open();
    assert.equal(await session.resendSmsCodeIfAvailable(), "resent");
    assert.equal(await page.evaluate(() => (window as unknown as { resends?: number }).resends ?? 0), 1);
    mode = "absent";
    await open();
    assert.equal(await session.resendSmsCodeIfAvailable(150), "error");
    assert.equal(page.url(), url);
    assert.equal(await page.evaluate(() => (window as unknown as { resends?: number }).resends ?? 0), 0);
    mode = "duplicate";
    await open();
    assert.equal(await session.resendSmsCodeIfAvailable(150), "error");
    assert.equal(await page.evaluate(() => (window as unknown as { resends?: number }).resends ?? 0), 0);
    mode = "revoked";
    await open();
    const revoked = new PzuEverestSession(browser, { ...options, selectors: { ...options.selectors, ...observed.session },
      beforeAction: async () => { throw new Error("EXECUTION_REVOKED"); } });
    assert.equal(await revoked.resendSmsCodeIfAvailable(150), "error");
    assert.equal(await page.evaluate(() => (window as unknown as { resends?: number }).resends ?? 0), 0);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PZU wymaga HTTPS i jawnych markerów ekranów", () => {
  assert.throws(() => new PzuEverestSession({} as BrowserSession, { ...options, everestEntryUrl: "http://goldis.test" }), /PZU_SESSION_CONFIG_INVALID/);
  assert.throws(() => new PzuEverestSession({} as BrowserSession, {
    ...options, selectors: { ...options.selectors, authenticated: " " },
  }), /PZU_SESSION_CONFIG_INVALID/);
});

test("sesja Everest rozpoznaje istniejące logowanie i ekrany wymagające interwencji na fikcyjnej stronie", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-session-"));
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    let navigations = 0;
    await page.route("https://goldis.test/**", async (route) => {
      navigations += 1;
      await route.fulfill({ status: 200, contentType: "text/html", body: '<main data-screen="home">Synthetic Everest</main>' });
    });
    const session = new PzuEverestSession(browser, options);
    assert.equal(await session.ensureAuthenticated(), "authenticated");
    assert.equal(navigations, 1, "pusta karta przechodzi do wskazanego ekranu Everest");
    assert.equal(await session.ensureAuthenticated(), "authenticated");
    assert.equal(navigations, 1, "aktywna sesja nie uruchamia ponownej nawigacji ani logowania");
    assert.equal(await session.signIn({ username: "synthetic-user", password: "synthetic-password" }), "authenticated");
    assert.equal(navigations, 1, "aktywna sesja nie wysyła ponownie poświadczeń");

    const scenarios = [
      ['<main data-screen="login">Synthetic login</main>', "login_required"],
      ['<main data-screen="sms">Synthetic SMS</main>', "waiting_for_sms"],
      ['<main data-screen="denied">Synthetic access denied</main>', "access_denied"],
      ["<main>Unrecognized synthetic screen</main>", "unknown"],
    ] as const;
    for (const [html, expected] of scenarios) {
      await page.setContent(html);
      assert.equal(await session.ensureAuthenticated(), expected);
    }
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logowanie jest pojedynczą próbą i zatrzymuje się na prawdziwym ekranie SMS", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-login-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<form data-screen="login">
        <input name="username"><input name="password" type="password">
        <button type="button" data-action="login" onclick="document.body.innerHTML='<main data-screen=&quot;sms&quot;><input name=&quot;code&quot;></main>'">Zaloguj</button>
      </form>`,
    }));
    const session = new PzuEverestSession(browser, options);
    assert.equal(await session.signIn({ username: "synthetic-user", password: "synthetic-password" }), "waiting_for_sms");
    assert.equal(await page.locator('input[name="code"]').inputValue(), "", "kod SMS pozostaje do ręcznego wpisania przez operatora");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("kod SMS z bufora ręcznego jest wysłany raz, a bufor zostaje wyzerowany", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-sms-submit-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<main data-screen="home" hidden>Everest</main>
        <form data-screen="login"><input name="username"><input name="password">
          <button type="button" data-action="login" onclick="document.querySelector('[data-screen=login]').hidden=true;document.querySelector('[data-screen=sms]').hidden=false">Zaloguj</button>
        </form>
        <form data-screen="sms" hidden><input name="code"><button type="button" data-action="submit-sms"
          onclick="window.syntheticCodeAccepted=document.querySelector('[data-screen=sms] input').value==='123456';document.querySelector('[data-screen=sms]').hidden=true;document.querySelector('[data-screen=home]').hidden=false">Potwierdź</button>
        </form>`,
    }));
    const session = new PzuEverestSession(browser, options);
    assert.equal(await session.signIn({ username: "synthetic-user", password: "synthetic-password" }), "waiting_for_sms");
    const submittedCode = Buffer.from("123456", "ascii");
    assert.equal(await session.submitSmsCode(submittedCode), "accepted");
    assert.deepEqual([...submittedCode], [0, 0, 0, 0, 0, 0], "bufor kodu jest wyzerowany po submit");
    assert.equal(await page.locator('input[name="code"]').inputValue(), "", "pole przeglądarki nie zachowuje kodu po wysłaniu");
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { syntheticCodeAccepted?: boolean }).syntheticCodeAccepted)), true);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("kod SMS w ramce PZU jest podawany do właściwej ramki i zerowany", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-iframe-sms-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: route.request().url().endsWith("/sms")
        ? `<input id="code"><button onclick="parent.postMessage({accepted:document.querySelector('#code').value==='123456'},'*')">Potwierdź</button>`
        : `<main data-screen="home" hidden>Everest</main><iframe id="sms-frame" src="/sms"></iframe>
           <script>addEventListener('message',event=>{if(event.data.accepted){document.querySelector('#sms-frame').hidden=true;document.querySelector('[data-screen=home]').hidden=false}})</script>`,
    }));
    await page.goto(url);
    const framed = new PzuEverestSession(browser, {
      ...options,
      selectors: { ...options.selectors, smsChallenge: "#sms-frame", smsFrame: "#sms-frame", smsCodeInput: "#code", smsCodeSubmit: "button" },
    });
    assert.equal(await framed.ensureAuthenticated(), "waiting_for_sms");
    const code = Buffer.from("123456", "ascii");
    assert.equal(await framed.submitSmsCode(code), "accepted");
    assert.deepEqual([...code], [0, 0, 0, 0, 0, 0]);
    assert.equal(await page.frameLocator("#sms-frame").locator("#code").inputValue(), "");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PZU zaznacza zapamiętanie urządzenia przed przekazaniem SMS, gdy portal pokazuje tę opcję", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-remember-device-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html",
      body: `<main data-screen="home" hidden>Everest</main><form data-screen="sms"><input name="code"><label><input type="checkbox" name="remember">Zapamiętaj to urządzenie</label><button type="button" data-action="submit-sms" onclick="window.syntheticRemembered=document.querySelector('[name=remember]').checked;document.querySelector('[data-screen=sms]').hidden=true;document.querySelector('[data-screen=home]').hidden=false">Potwierdź</button></form>`,
    }));
    await page.goto(url);
    const session = new PzuEverestSession(browser, {
      ...options, selectors: { ...options.selectors, smsRememberDevice: 'input[name="remember"]' },
    });
    const code = Buffer.from("123456", "ascii");
    assert.equal(await session.submitSmsCode(code), "accepted");
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { syntheticRemembered?: boolean }).syntheticRemembered)), true);
    assert.deepEqual([...code], [0, 0, 0, 0, 0, 0]);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PZU nie klika przycisku SMS, gdy selektor obejmuje więcej niż jedną akcję", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-ambiguous-sms-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html",
      body: `<form data-screen="sms"><input name="code"><button type="button" onclick="window.syntheticClicked=true">Wyślij</button><button type="button" onclick="window.syntheticClicked=true">Ponów</button></form>`,
    }));
    await page.goto(url);
    const session = new PzuEverestSession(browser, options);
    assert.equal(await session.submitSmsCode(Buffer.from("123456", "ascii")), "uncertain");
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { syntheticClicked?: boolean }).syntheticClicked)), false);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("utrzymany formularz SMS bez jawnego markera jest niepewny, a markery odróżniają błędny i wygasły kod", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-sms-outcome-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    let outcome: "rejected" | "expired" | "none" = "none";
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html",
      body: `<main data-screen="sms"><input name="code"><button data-action="submit-sms" onclick="document.querySelector('[data-screen=expired]').hidden=window.syntheticOutcome!=='expired';document.querySelector('[data-screen=rejected]').hidden=window.syntheticOutcome!=='rejected'">Potwierdź</button><p data-screen="rejected" hidden>Kod nieprawidłowy</p><p data-screen="expired" hidden>Kod wygasł</p></main>`,
    }));
    await page.goto(url);
    const session = new PzuEverestSession(browser, {
      ...options,
      transitionTimeoutMs: 150,
      selectors: { ...options.selectors, smsCodeRejected: '[data-screen="rejected"]', smsCodeExpired: '[data-screen="expired"]' },
    });
    assert.equal(await session.submitSmsCode(Buffer.from("123456", "ascii")), "uncertain");
    outcome = "rejected";
    await page.evaluate((value) => { (window as unknown as { syntheticOutcome?: string }).syntheticOutcome = value; }, outcome);
    assert.equal(await session.submitSmsCode(Buffer.from("123456", "ascii")), "rejected");
    outcome = "expired";
    await page.evaluate((value) => { (window as unknown as { syntheticOutcome?: string }).syntheticOutcome = value; }, outcome);
    assert.equal(await session.submitSmsCode(Buffer.from("123456", "ascii")), "expired");
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("po timeoutcie PZU otwiera nowy cykl logowania zamiast używać starego formularza SMS", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-reopen-sms-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    let pageLoads = 0;
    page.on("request", (request) => { if (request.url() === url) pageLoads += 1; });
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html",
      body: `<form data-screen="login"><input name="username"><input name="password"><button type="button" data-action="login" onclick="document.querySelector('[data-screen=login]').hidden=true;document.querySelector('[data-screen=sms]').hidden=false;window.syntheticLoginCount=1">Zaloguj</button></form><form data-screen="sms" hidden><input name="code"></form>`,
    }));
    const session = new PzuEverestSession(browser, options);
    assert.equal(await session.signIn({ username: "synthetic-user", password: "synthetic-password" }), "waiting_for_sms");
    assert.equal(await session.reopenAfterSmsTimeout(), "login_required");
    assert.equal(await page.locator('[data-screen="sms"]').isVisible(), false);
    assert.equal(await session.signIn({ username: "synthetic-user", password: "synthetic-password" }), "waiting_for_sms");
    assert.equal(pageLoads, 2);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PZU ponawia SMS tylko przez jednoznaczny przycisk dostępny po timeoutcie", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-resend-sms-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html",
      body: `<form data-screen="sms"><input name="code"><button type="button" data-action="resend" onclick="window.syntheticResends=(window.syntheticResends||0)+1">Wyślij kod ponownie</button></form>`,
    }));
    await page.goto(url);
    const session = new PzuEverestSession(browser, {
      ...options, selectors: { ...options.selectors, smsResendCode: 'button[data-action="resend"]' },
    });
    assert.equal(await session.resendSmsCodeIfAvailable(), "resent");
    assert.equal(await page.evaluate(() => (window as unknown as { syntheticResends?: number }).syntheticResends), 1);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("po SMS-ie sesja przechodzi ze strony usług SSO do Everest bez drugiego logowania", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-sso-landing-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    let everestVisits = 0;
    await page.route("https://goldis.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/everest") everestVisits += 1;
      return route.fulfill({
        status: 200, contentType: "text/html",
        body: path === "/landing"
          ? '<main data-screen="services"><a href="/everest">Everest</a></main>'
          : '<main data-screen="home">Synthetic Everest</main>',
      });
    });
    await page.goto("https://goldis.test/landing");
    const session = new PzuEverestSession(browser, {
      ...options,
      selectors: { ...options.selectors, postLoginLanding: '[data-screen="services"]' },
    });
    assert.equal(await session.ensureAuthenticated(), "authenticated");
    assert.equal(new URL(page.url()).pathname, "/everest");
    assert.equal(everestVisits, 1);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("brak poświadczeń nie powoduje wpisywania ani wysłania pustego formularza", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-no-credentials-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    let submitted = 0;
    await page.route("https://goldis.test/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<form data-screen="login"><input name="username"><input name="password"><button data-action="login" onclick="window.syntheticSubmitted=true">Zaloguj</button></form>',
    }));
    const session = new PzuEverestSession(browser, options);
    assert.equal(await session.signIn(), "login_required");
    submitted = await page.evaluate(() => Number(Boolean((window as unknown as { syntheticSubmitted?: boolean }).syntheticSubmitted)));
    assert.equal(submitted, 0);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("błąd nawigacji kończy sprawdzenie sesji kodem bez retry ani obejścia TLS", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-pzu-navigation-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.abort("failed"));
    const session = new PzuEverestSession(browser, options);
    assert.equal(await session.ensureAuthenticated(), "navigation_error");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
