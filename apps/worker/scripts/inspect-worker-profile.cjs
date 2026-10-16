"use strict";

// Supervised selector inspection in the production worker's configured profile.
// This is preparation for acceptance, not a completed end-to-end run.
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { Pool } = require("pg");
const { BrowserSession } = require("../dist/infrastructure/browser/browser.js");
const { PzuEverestSession } = require("../dist/portals/pzu/pzu-session.js");
const { CompensaPortalSession } = require("../dist/portals/compensa/compensa-session.js");
const { parseTransportWorkbook } = require("../../api/dist/features/imports/workbook.js");

async function loadEnvironment(file) {
  const output = {};
  for (const line of (await fs.readFile(file, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) output[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return output;
}

async function inspect(page) {
  const url = new URL(page.url());
  const elements = await page.locator("input,button,select,a,iframe,table").evaluateAll(nodes => nodes
    .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .slice(0, 100).map(element => ({
      tag: element.tagName.toLowerCase(), id: element.id, name: element.getAttribute("name"),
      type: element.getAttribute("type"), className: typeof element.className === "string" ? element.className : "",
      placeholder: element.getAttribute("placeholder"),
      label: /^(Everest|Compensa Komunikacja|Zaloguj|Szybkie wyszukiwanie|Ubezpieczający|Weryfikacja UFG|Szczegóły|Zapisz)$/.test(element.textContent.trim())
        ? element.textContent.trim() : "",
    })));
  console.log(JSON.stringify({ origin: url.origin, path: url.pathname, elements }));
}

async function main() {
  const root = path.resolve(__dirname, "../../..");
  const local = await loadEnvironment(path.join(root, ".env.local"));
  const portals = await loadEnvironment(path.join(root, ".env"));
  const observed = JSON.parse(await fs.readFile(path.join(root, "config/pzu-sms.observed.json"), "utf8"));
  const observedLogin = JSON.parse(await fs.readFile(path.join(root, "config/pzu-login.observed.json"), "utf8"));
  const pool = new Pool({ connectionString: local.DATABASE_URL, max: 1 });
  const owner = await pool.connect();
  let browser;
  try {
    const locked = await owner.query("SELECT pg_try_advisory_lock(205746858, 1) AS acquired");
    if (!locked.rows[0].acquired) throw new Error("PORTAL_WORKER_ALREADY_RUNNING");
    browser = new BrowserSession({ profileDirectory: local.WORKER_PROFILE_DIR, headless: false,
      ...(local.WORKER_BROWSER_CHANNEL ? { channel: local.WORKER_BROWSER_CHANNEL } : {}) });
    const makeSession = async () => new PzuEverestSession(browser, {
      everestEntryUrl: portals.PZU_LOGIN_URL,
      allowedOrigins: ["https://everest.pzu.pl", "https://zaloguj.pzu.pl", "https://strefa.agentpzu.pl"],
      selectors: {
        authenticated: 'input[placeholder^="PESEL/REGON"], input[name$="-smartsearch"]',
        ...JSON.parse(await fs.readFile(path.join(root, "config/pzu-login.observed.json"), "utf8")).session,
        accessDenied: 'text="Access denied"', ...observed.session,
      },
      transitionTimeoutMs: 15000,
    });
    let session = await makeSession();
    let compensaSession;
    let currentPage;
    const page = await browser.page("pzu");
    currentPage = page;
    console.log("WORKER_PROFILE_EXCLUSIVE_OWNER_ACQUIRED");
    console.log(JSON.stringify({ portal: "pzu", initialState: await session.ensureAuthenticated() }));
    await inspect(page);
    console.log("Commands: login | state | inspect | reload | pzu | compensa | compensa-login | conflict | quit. JSON probe is read-only. SMS is entered in the worker browser, never here.");
    const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    for await (const line of input) {
      try {
        if (line.trim() === "quit") break;
        if (line.trim() === "inspect") await inspect(currentPage);
        if (line.trim() === "reload") { session = await makeSession(); compensaSession = undefined; console.log("SELECTORS_RELOADED_IN_SAME_BROWSER"); }
        if (line.trim() === "pzu") currentPage = page;
        if (line.trim() === "search18001") {
          if (await session.ensureAuthenticated() !== "authenticated") throw new Error("PZU_NOT_AUTHENTICATED");
          const rows = await parseTransportWorkbook(await fs.readFile(path.join(root, "exports/live-acceptance/input-18001.xlsx")));
          if (rows.length !== 1 || rows[0].rowNumber !== 18001 || rows[0].issues.length) throw new Error("ACCEPTANCE_INPUT_NOT_READY");
          const search = page.locator('input[placeholder^="PESEL/REGON"]');
          if (await search.count() !== 1) throw new Error("PZU_SEARCH_INPUT_AMBIGUOUS");
          await search.fill(rows[0].effectiveRegon);
          await search.press("Enter");
          currentPage = page;
          console.log("PZU_SEARCH_18001_SUBMITTED");
        }
        if (line.trim() === "compensa") {
          currentPage = await browser.page("compensa");
          if (currentPage.url() === "about:blank") await currentPage.goto(portals.COMPENSA_LOGIN_URL, { waitUntil: "domcontentloaded" });
          await currentPage.bringToFront();
          await inspect(currentPage);
        }
        if (line.trim() === "compensa-login") {
          const config = JSON.parse(await fs.readFile(path.join(root, "config/compensa-login.observed.json"), "utf8"));
          compensaSession ??= new CompensaPortalSession(browser, { entryUrl: portals.COMPENSA_LOGIN_URL, allowedOrigins: config.allowedOrigins, selectors: config.session, transitionTimeoutMs: 15000 });
          console.log(JSON.stringify({ portal: "compensa", state: await compensaSession.signIn({ username: portals.COMPENSA_LOGIN, password: portals.COMPENSA_PASSWORD }) }));
        }
        if (line.trim().startsWith("{")) {
          const command = JSON.parse(line);
          if (command.operation !== "probe" || typeof command.selector !== "string") throw new Error("READ_ONLY_PROBE_REQUIRED");
          const locator = currentPage.locator(command.selector);
          console.log(JSON.stringify({ count: await locator.count(), nodes: await locator.evaluateAll(nodes => nodes.slice(0, 30).map(element => ({
            tag: element.tagName.toLowerCase(), id: element.id, name: element.getAttribute("name"), type: element.getAttribute("type"),
            className: typeof element.className === "string" ? element.className : "", placeholder: element.getAttribute("placeholder"),
            ...(element.tagName === "TD" ? { numericLengths: [...element.textContent.matchAll(/(?<!\d)\d{9,14}(?!\d)/g)].map(match => match[0].length) } : {}),
            label: /^(?:Everest|Szybkie wyszukiwanie|Osoba fizyczna|PESEL.?REGON|Typ konta|Nazwa|Imię|Nazwisko|Adres|Kod pocztowy|Miasto|Powiat|Ubezpieczający|Compensa Komunikacja|Zapisz|Weryfikacja UFG|Szczegóły|Szczegóły polis OC|Podaj REGON lub PESEL|Numer rejestracyjny|Wybierz:)$/i.test(element.textContent.trim()) ? element.textContent.trim() : "",
            ...(element.tagName === "A" && /^Everest$/.test(element.textContent.trim()) ? { href: element.getAttribute("href"), target: element.getAttribute("target") } : {}),
          }))) }));
        }
        if (["lookup18001", "open-communication"].includes(line.trim())) {
          const actionsPath = path.join(__dirname, "inspect-worker-actions.cjs");
          delete require.cache[require.resolve(actionsPath)];
          const result = await require(actionsPath)({ command: line.trim(), browser, owner, session, compensaSession, root, portals });
          if (result?.page) currentPage = result.page;
        }
        if (line.trim() === "state") console.log(JSON.stringify({ portal: "pzu", state: await session.ensureAuthenticated() }));
        if (line.trim() === "login") console.log(JSON.stringify({ portal: "pzu", state: await session.signIn({ username: portals.PZU_LOGIN, password: portals.PZU_PASSWORD }) }));
        if (line.trim() === "conflict") console.log(JSON.stringify({
          sessionConflict: await page.getByText("Przetwarzanie w toku dla Twojej bieżącej sesji.", { exact: false }).count(),
          recoveryLink: await page.locator('a[href="javascript:document.location=redirectURI"]').count(),
        }));
      } catch { console.log("WORKER_PROFILE_INSPECTION_ACTION_FAILED"); }
    }
    input.close();
  } finally {
    await browser?.close();
    await owner.query("SELECT pg_advisory_unlock(205746858, 1)").catch(() => undefined);
    owner.release();
    await pool.end();
  }
}
main().catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "WORKER_PROFILE_INSPECTION_FAILED"); process.exitCode = 1; });
