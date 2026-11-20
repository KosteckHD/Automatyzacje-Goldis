import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "../../infrastructure/browser/browser";
import { EverestIdentityProvider, type EverestResultSelectors } from "./everest-identity-provider";
import { PzuEverestSession, type PzuSessionOptions } from "./pzu-session";
import type { EverestCandidate } from "../../features/identity/identity";
import type { WorkerRunContext } from "../../features/execution/ports";

const entryUrl = "https://goldis.test/everest";
const sessionOptions: PzuSessionOptions = {
  everestEntryUrl: entryUrl,
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
const resultSelectors: EverestResultSelectors = {
  searchInput: "#search-regon",
  searchNavigation: "#search-nav",
  resultRows: "tbody#results tr",
  noResults: "#no-results:has-text('Brak wynikow')",
  optionalOverlay: { container: "[data-interstitial]", dismissButton: "[data-dismiss]" },
  fields: { accountType: ".kind", personName: ".person", pesel: ".pesel" },
};

function context(decisionMakerName: string | null): WorkerRunContext {
  return {
    run: {
      schemaVersion: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      sourceRowId: "22222222-2222-4222-8222-222222222222",
      batchId: "33333333-3333-4333-8333-333333333333",
      referenceDate: "2026-09-30",
      toolId: "oc-policy-verification",
    },
    source: {
      id: "22222222-2222-4222-8222-222222222222",
      rowNumber: 18001,
      companyName: "Fikcyjna Firma Testowa",
      decisionMakerName,
      nipRaw: "",
      address: "",
      postalCode: "",
      city: "",
      regonRaw: "012345678",
      regon: "012345678",
      effectiveRegon: "012345678",
      issues: [],
    },
    status: "pzu_login",
    cancelRequested: false,
    identity: null,
  } as WorkerRunContext;
}

function candidate(
  kind: EverestCandidate["kind"],
  overrides: Partial<EverestCandidate> = {},
): EverestCandidate {
  return {
    kind,
    regon: kind === "person" ? null : "012345678",
    companyName: kind === "person" ? null : "Fikcyjna Firma Testowa",
    personName: "Ala Testowa Fikcyjna Firma Testowa",
    pesel: "90010100016",
    ...overrides,
  };
}

function fixtureHtml(): string {
  return `<main data-screen="home">Synthetic Everest</main>
    <button id="search-nav" type="button" onclick="document.querySelector('#results').innerHTML='';document.querySelector('#no-results').style.display='none'">Szybkie wyszukiwanie</button>
    <input id="search-regon" onkeydown="if(event.key !== 'Enter') return;
      const rows = JSON.parse(document.querySelector('#fixture').textContent);
      document.querySelector('#results').innerHTML = rows.map(r => '<tr><td class=kind>' + r.kindLabel + '</td><td class=regon>' + (r.regon || '') + '</td><td class=company>' + (r.companyName || '') + '</td><td class=person>' + (r.personName || '') + '</td><td class=pesel>' + (r.pesel || '') + '</td></tr>').join('');
      document.querySelector('#no-results').style.display = rows.length ? 'none' : 'block';
    "><button id="search-button" type="button">Szukaj</button>
    <div id="no-results" style="display:none">Brak wynikow</div>
    <table><tbody id="results"></tbody></table><pre id="fixture" style="display:none">[]</pre>`;
}

function fixtureRows(rows: readonly EverestCandidate[]): Array<Record<string, string | null>> {
  return rows.map((row) => ({
    kindLabel: row.kind === "sole_proprietor" ? "Osoba fizyczna prowadząca działalność gospodarczą"
      : row.kind === "person" ? "Osoba fizyczna" : "Typ konta nierozpoznany",
    regon: row.regon,
    companyName: row.companyName,
    personName: row.personName,
    pesel: row.pesel,
  }));
}

test("a unique PESEL without a contact defers names to the Communication form without looking up another portal", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-everest-business-name-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixtureHtml() }));
    await page.goto(entryUrl);
    const companyName = "Fikcyjna Firma Testowa Ala";
    await page.locator("#fixture").textContent();
    await page.evaluate(rows => { document.querySelector("#fixture")!.textContent = JSON.stringify(rows); },
      fixtureRows([candidate("person", { personName: companyName }), candidate("sole_proprietor", { personName: companyName })]));
    const provider = new EverestIdentityProvider(browser, new PzuEverestSession(browser, sessionOptions), {
      selectors: resultSelectors, adapterVersion: "business-name-fixture-v1",
    });
    const input = context(null);
    const result = await provider.findIdentity({ ...input, source: { ...input.source, companyName } });
    assert.equal(result.kind, "matched");
    if (result.kind === "matched") {
      assert.equal(result.identity.matchMethod, "regon_unique_pesel");
      assert.equal(result.identity.firstName, ""); assert.equal(result.identity.lastName, "");
      assert.equal(result.identity.pesel, "90010100016");
    }
    assert.deepEqual((await browser.open()).pages().map(p => p.url()).filter(url => url !== "about:blank"), [entryUrl], "identity lookup stays in Everest");
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Everest adapter wymaga selektorów jawnych i bezpiecznej wersji", () => {
  assert.throws(() => new EverestIdentityProvider({} as BrowserSession, {} as PzuEverestSession, {
    selectors: resultSelectors, adapterVersion: "version with spaces",
  }), /EVEREST_ADAPTER_CONFIG_INVALID/);
});

test("Firma uses the exact returned REGON and name ordering does not create a false ambiguity", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-everest-company-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixtureHtml() }));
    await page.goto(entryUrl);
    const provider = new EverestIdentityProvider(browser, new PzuEverestSession(browser, sessionOptions), { selectors: resultSelectors, adapterVersion: "company-fixture-v3" });
    const setRows = (rows: Array<Record<string, unknown>>) => page.evaluate(data => { document.querySelector("#fixture")!.textContent = JSON.stringify(data); }, rows);
    await setRows([{ kindLabel: "Firma", personName: "Fikcyjna Firma Testowa", pesel: "012345678" }]);
    const company = await provider.findIdentity(context("Other Contact"));
    assert.equal(company.kind, "matched");
    if (company.kind === "matched") { assert.equal(company.identity.matchMethod, "regon_company"); assert.equal(company.identity.pesel, ""); assert.equal(company.identity.regon, "012345678"); }
    await setRows([{ kindLabel: "Firma", personName: "Fikcyjna Firma Testowa", pesel: "987654321" }]);
    assert.equal((await provider.findIdentity(context("Ala Testowa"))).kind, "identity_review");
    await setRows([{ kindLabel: "Firma", personName: "Ala Testowa Fikcyjna Firma Testowa", pesel: "90010100016" }]);
    assert.deepEqual(await provider.findIdentity(context("Ala Testowa")), {
      kind: "identity_review", reason: "unsupported_entity_type", candidateCount: 1,
    }, "wiersz Firma nie może zastępować osoby fizycznej nawet z poprawnym PESEL-em");
    await setRows([
      { kindLabel: "Osoba fizyczna", personName: "Fikcyjna Firma Testowa Ala Testowa", pesel: "90010100016" },
      { kindLabel: "Osoba fizyczna prowadząca działalność gospodarczą", personName: "Fikcyjna Firma Testowa Ala Testowa", pesel: "90010100016" },
    ]);
    const person = await provider.findIdentity(context("Testowa Ala"));
    assert.equal(person.kind, "matched");
    if (person.kind === "matched") assert.equal(person.identity.matchMethod, "regon_unique_pesel");
    const strict = context("Testowa Ala");
    await setRows([{ kindLabel: "Osoba fizyczna", personName: "Jan Inny Fikcyjna Firma Testowa", pesel: "90010100016" }]);
    assert.equal((await provider.findIdentity({ ...strict, source: { ...strict.source, expectedPersonName: "Ala Testowa" } })).kind, "identity_review");
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the observed no-result marker accepts the searched identifier suffix and a following successful search", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-everest-not-found-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    const html = fixtureHtml().replace('Brak wynikow</div>', 'Brak wyników wyszukiwania: 012345678</div>');
    await page.route("https://goldis.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(entryUrl);
    const provider = new EverestIdentityProvider(browser, new PzuEverestSession(browser, sessionOptions), { selectors: { ...resultSelectors, noResults: 'text=/^Brak wyników wyszukiwania(?:\\s*:|$)/' }, adapterVersion: "no-results-fixture-v3" });
    assert.deepEqual(await provider.findIdentity(context(null)), { kind: "not_found" });
    await page.evaluate(rows => { document.querySelector("#fixture")!.textContent = JSON.stringify(rows); }, fixtureRows([candidate("person")]));
    assert.equal((await provider.findIdentity(context("Ala Testowa"))).kind, "matched");
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("consecutive unchanged empty searches require an acknowledgement for the exact submitted REGON", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-everest-empty-ack-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    const field = "DesktopClientsAccountsPzu-DesktopClientsAccountsScreen-smartsearch";
    const html = `<main data-screen="home">Fixture</main><div id="no-results">Brak wynikow</div>
      <table><tbody id="results"></tbody></table><input id="search-regon" name="${field}" aria-invalid="false">
      <script>document.querySelector('input').onkeydown=async event=>{
        if(event.key!=='Enter')return;const input=event.target;
        await fetch('/everest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          [input.name]:window.wrongRegon?'000000000':input.value,eventSource:input.name+'_Button_act'})});
        input.value='';
      };</script>`;
    await page.route("https://goldis.test/**", route => route.request().method() === "POST"
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify({ targets: [{ id: field, content: "<input>" }] }) })
      : route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(entryUrl);
    const provider = new EverestIdentityProvider(browser, new PzuEverestSession(browser, sessionOptions), {
      selectors: { ...resultSelectors, searchNavigation: undefined }, adapterVersion: "empty-ack-fixture", resultTimeoutMs: 900,
    });
    assert.deepEqual(await provider.findIdentity(context(null)), { kind: "not_found" });
    const next = context(null);
    assert.deepEqual(await provider.findIdentity({ ...next, source: { ...next.source, effectiveRegon: "987654321" } }), { kind: "not_found" });
    await page.evaluate(() => { (window as Window & { wrongRegon?: boolean }).wrongRegon = true; });
    await assert.rejects(provider.findIdentity(context(null)), /EVEREST_SEARCH_RESULTS_UNAVAILABLE/,
      "a response for a different identifier must not legitimize the old empty result");
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Everest never chooses the first of ambiguous navigation buttons or search inputs", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-everest-safe-navigation-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  let duplicated = "navigation";
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", route => route.fulfill({ status: 200, contentType: "text/html", body:
      '<main data-screen="home">Fixture</main><button class="nav" onclick="window.clicked=true">Search</button>'
      + (duplicated === "navigation" ? '<button class="nav" onclick="window.clicked=true">Other tab</button>' : "")
      + '<input class="search">' + (duplicated === "input" ? '<input class="search">' : "") }));
    for (duplicated of ["navigation", "input"]) {
      await page.goto(entryUrl);
      const provider = new EverestIdentityProvider(browser, new PzuEverestSession(browser, sessionOptions), {
        selectors: { ...resultSelectors, searchNavigation: duplicated === "navigation" ? ".nav" : undefined, searchInput: ".search" },
        adapterVersion: "safe-navigation-v1",
      });
      await assert.rejects(provider.findIdentity(context("Ala Testowa")), /EVEREST_SEARCH_RESULTS_UNAVAILABLE/);
      assert.equal(await page.evaluate(() => Boolean((window as unknown as { clicked?: boolean }).clicked)), false);
      assert.equal((await page.locator(".search").evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).every(value => value === ""), true);
    }
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Everest waits for the new REGON render and ignores unrelated page mutations", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-everest-fresh-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "goldis.test"
      ? route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml() }) : route.abort());
    await page.goto(entryUrl);
    const provider = new EverestIdentityProvider(browser, new PzuEverestSession(browser, sessionOptions), {
      selectors: { ...resultSelectors, searchNavigation: undefined }, adapterVersion: "fresh-fixture-v1", resultTimeoutMs: 2_000,
    });
    await page.evaluate((rows) => {
      document.querySelector("#results")!.innerHTML = rows.map((r) => `<tr><td class="kind">${r.kindLabel}</td><td class="person">${r.personName}</td><td class="pesel">${r.pesel}</td></tr>`).join("");
      const input = document.querySelector("#search-regon") as HTMLInputElement;
      input.onkeydown = (event) => {
        if (event.key !== "Enter") return;
        document.body.setAttribute("data-unrelated", "changed");
        setTimeout(() => { document.querySelector(".person")!.textContent = "Ola Testowa Fikcyjna Firma Testowa"; }, 450);
      };
    }, fixtureRows([candidate("person")]));
    const next = context("Ola Testowa");
    const result = await provider.findIdentity({ ...next, source: { ...next.source, effectiveRegon: "987654321" } });
    assert.equal(result.kind, "matched");
    if (result.kind === "matched") assert.equal(result.identity.firstName, "Ola");
    assert.equal(await page.locator("#search-regon").inputValue(), "987654321");
    await page.evaluate(() => { (document.querySelector("#search-regon") as HTMLInputElement).onkeydown = () => { document.body.classList.add("unrelated"); }; });
    await assert.rejects(provider.findIdentity(context("Ola Testowa")), /EVEREST_SEARCH_RESULTS_UNAVAILABLE/);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Everest pobiera PESEL z wiersza osoby fizycznej po wyszukaniu REGON", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-everest-identity-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("pzu");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml() }));
    await page.goto(entryUrl);
    const session = new PzuEverestSession(browser, sessionOptions);
    const provider = new EverestIdentityProvider(browser, session, { selectors: resultSelectors, adapterVersion: "everest-fixture-v1" });

    const runScenario = async (rows: readonly EverestCandidate[], decisionMakerName: string | null = "Ala Testowa") => {
      await page.evaluate((data) => {
        document.querySelector("#fixture")!.textContent = JSON.stringify(data);
        document.querySelector("#results")!.innerHTML = "";
        (document.querySelector("#no-results") as HTMLElement).style.display = "none";
      }, fixtureRows(rows));
      return provider.findIdentity(context(decisionMakerName));
    };

    const matched = await runScenario([
      candidate("person", { pesel: "90010100016" }),
      candidate("sole_proprietor", { pesel: "90010100016" }),
    ]);
    assert.deepEqual(matched, {
      kind: "matched",
      identity: {
        schemaVersion: 1,
        sourceRowId: "22222222-2222-4222-8222-222222222222",
        regon: "012345678",
        companyName: "Fikcyjna Firma Testowa",
        firstName: "Ala",
        lastName: "Testowa",
        pesel: "90010100016",
        matchMethod: "regon_company_name_decision_maker",
        adapterVersion: "everest-fixture-v1",
      },
    });
    assert.equal(await page.locator(resultSelectors.searchInput).inputValue(), "012345678", "numer rejestracyjny nie jest używany jako filtr");

    await page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-interstitial", "");
      overlay.innerHTML = '<button data-dismiss type="button">Zamknij informację</button>';
      overlay.querySelector("button")!.addEventListener("click", () => overlay.remove());
      document.body.append(overlay);
    });
    assert.equal((await runScenario([candidate("person")])).kind, "matched");
    assert.equal(await page.locator("[data-interstitial]").count(), 0, "znane okno informacyjne zostało zamknięte przed wyszukiwaniem");

    await page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-interstitial", "");
      overlay.textContent = "Nieznane okno";
      document.body.append(overlay);
    });
    await assert.rejects(() => runScenario([candidate("person")]), /EVEREST_OVERLAY_UNHANDLED/);
    await page.locator("[data-interstitial]").evaluate((element) => element.remove());

    assert.deepEqual(await runScenario([]), { kind: "not_found" });
    assert.equal((await runScenario([candidate("person")])).kind, "matched", "kolejne wyszukiwanie wraca z ekranu bez wyników");
    assert.equal((await runScenario([candidate("person"), candidate("person", { pesel: "90010100016" })])).kind, "matched", "duplicate accounts with one PESEL are one identity");
    const disambiguated = await runScenario([candidate("person"), candidate("person", { personName: "Jan Testowy", pesel: "90010100016" })]);
    assert.equal(disambiguated.kind, "matched", "oczekiwana osoba rozstrzyga listę kilku osób");
    if (disambiguated.kind === "matched") assert.equal(disambiguated.identity.pesel, "90010100016");
    const withoutContact = await runScenario([candidate("person")], null);
    assert.equal(withoutContact.kind, "matched");
    if (withoutContact.kind === "matched") {
      assert.equal(withoutContact.identity.firstName, "Ala");
      assert.equal(withoutContact.identity.lastName, "Testowa");
      assert.equal(withoutContact.identity.matchMethod, "unique_business_identity");
    }
    assert.deepEqual(await runScenario([candidate("person"), candidate("person", { pesel: "90010100023" })], null), {
      kind: "ambiguous", candidateCount: 2,
    });
    assert.deepEqual(await runScenario([candidate("person", { personName: "Inna Osoba Inna Firma" })], null), {
      kind: "identity_review", reason: "name_mismatch", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("person", { personName: "Inna Osoba" })]), {
      kind: "identity_review", reason: "name_mismatch", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("person", { personName: "Ala Testowa Inna Firma" })]), {
      kind: "identity_review", reason: "name_mismatch", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("person", { pesel: null })]), {
      kind: "identity_review", reason: "missing_pesel", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("person", { pesel: "90010100024" })]), {
      kind: "identity_review", reason: "invalid_pesel", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("person", { pesel: "90010100023" }), candidate("sole_proprietor")]), {
      kind: "identity_review", reason: "name_mismatch", candidateCount: 2,
    });
    assert.deepEqual(await runScenario([candidate("unknown")]), {
      kind: "identity_review", reason: "unsupported_entity_type", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("unknown"), candidate("unknown", { personName: "Inna firma" })]), {
      kind: "identity_review", reason: "unsupported_entity_type", candidateCount: 2,
    });
    const businessFallback = await runScenario([candidate("sole_proprietor")]);
    assert.equal(businessFallback.kind, "matched", "przy braku osoby fizycznej można użyć wiersza działalności");
    if (businessFallback.kind === "matched") assert.equal(businessFallback.identity.pesel, "90010100016");
    assert.deepEqual(await runScenario([candidate("sole_proprietor", { pesel: null })]), {
      kind: "identity_review", reason: "missing_pesel", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("sole_proprietor", { pesel: "90010100024" })]), {
      kind: "identity_review", reason: "invalid_pesel", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([candidate("sole_proprietor", { personName: "Inna Osoba Inna Firma" })]), {
      kind: "identity_review", reason: "name_mismatch", candidateCount: 1,
    });
    assert.deepEqual(await runScenario([
      candidate("sole_proprietor"), candidate("sole_proprietor", { pesel: "90010100023" }),
    ], null), { kind: "ambiguous", candidateCount: 2 });
    assert.deepEqual(await runScenario([candidate("person", { pesel: null }), candidate("sole_proprietor")]), {
      kind: "identity_review", reason: "missing_pesel", candidateCount: 2,
    }, "działalność jest ścieżką przy braku wiersza osoby fizycznej, nie obejściem błędów obecnego wiersza");

    const syntheticPesel = "98765432109";
    const capturedLogs: string[] = [];
    const originalConsoleMethods = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      await runScenario([candidate("person", { pesel: syntheticPesel })]);
    } finally {
      console.log = originalConsoleMethods.log;
      console.warn = originalConsoleMethods.warn;
      console.error = originalConsoleMethods.error;
    }
    assert.equal(capturedLogs.join("\n").includes(syntheticPesel), false, "adapter nie loguje PESEL-u z ekranu");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
