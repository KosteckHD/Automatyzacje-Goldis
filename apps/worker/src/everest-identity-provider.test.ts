import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "./browser";
import { EverestIdentityProvider, type EverestResultSelectors } from "./everest-identity-provider";
import { PzuEverestSession, type PzuSessionOptions } from "./pzu-session";
import type { EverestCandidate } from "./identity";
import type { WorkerRunContext } from "./ports";

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

test("Everest adapter wymaga selektorów jawnych i bezpiecznej wersji", () => {
  assert.throws(() => new EverestIdentityProvider({} as BrowserSession, {} as PzuEverestSession, {
    selectors: resultSelectors, adapterVersion: "version with spaces",
  }), /EVEREST_ADAPTER_CONFIG_INVALID/);
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
    assert.deepEqual(await runScenario([candidate("person"), candidate("person", { pesel: "90010100016" })]), {
      kind: "ambiguous", candidateCount: 2,
    });
    const disambiguated = await runScenario([candidate("person"), candidate("person", { personName: "Jan Testowy", pesel: "90010100016" })]);
    assert.equal(disambiguated.kind, "matched", "oczekiwana osoba rozstrzyga listę kilku osób");
    if (disambiguated.kind === "matched") assert.equal(disambiguated.identity.pesel, "90010100016");
    assert.deepEqual(await runScenario([candidate("person")], null), {
      kind: "identity_review", reason: "missing_expected_person", candidateCount: 0,
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
    assert.deepEqual(await runScenario([candidate("person", { pesel: "90010100023" }), candidate("sole_proprietor")]), {
      kind: "identity_review", reason: "name_mismatch", candidateCount: 2,
    });
    assert.deepEqual(await runScenario([candidate("unknown")]), {
      kind: "identity_review", reason: "name_mismatch", candidateCount: 1,
    });

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
