import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { BrowserSession } from "./browser";
import type { BrowserContext } from "playwright";
import { collectCurrentOc, readOcRows, readOcSummaryCount, readOcSnapshot, selectCurrentPolicies } from "../../features/results/oc";

test("każdy właściciel profilu przeglądarki otrzymuje osobny, niejawny identyfikator sesji", () => {
  const first = new BrowserSession({ profileDirectory: join(tmpdir(), "goldis-session-id-test-a") });
  const second = new BrowserSession({ profileDirectory: join(tmpdir(), "goldis-session-id-test-b") });
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(first.sessionId, second.sessionId);
});

test("ustawia sandbox Chromium jawnie dla kontenera produkcyjnego", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-browser-sandbox-"));
  const launchOptions: Array<Record<string, unknown>> = [];
  const browser = new BrowserSession({
    profileDirectory: directory,
    chromiumSandbox: true,
    launch: async (_path, options) => {
      launchOptions.push(options as Record<string, unknown>);
      return {
        setDefaultTimeout: () => undefined,
        setDefaultNavigationTimeout: () => undefined,
        close: async () => undefined,
      } as unknown as BrowserContext;
    },
  });
  try {
    await browser.open();
    assert.equal(launchOptions[0]?.chromiumSandbox, true);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("profil Chromium zachowuje sesję, a tabela OC jest czytana w całości", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-worker-test-"));
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
  try {
    const first = new BrowserSession({ profileDirectory: directory });
    assert.match(first.sessionId, /^[0-9a-f-]{36}$/i);
    const pzu = await first.page("pzu");
    assert.equal(await first.page("pzu"), pzu);
    await pzu.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, body: "<title>Pilot</title>" }));
    await pzu.goto("https://goldis.test/pzu");
    await pzu.evaluate(() => localStorage.setItem("remembered", "yes"));
    const runSyntheticCompany = (regon: string) => pzu.evaluate((companyRegon) => {
      const promptCount = Number(localStorage.getItem("synthetic.smsPromptCount") ?? "0");
      if (localStorage.getItem("synthetic.authenticated") !== "yes") {
        localStorage.setItem("synthetic.smsPromptCount", String(promptCount + 1));
        localStorage.setItem("synthetic.authenticated", "yes");
      }
      const processed = JSON.parse(localStorage.getItem("synthetic.processedRegons") ?? "[]") as string[];
      processed.push(companyRegon);
      localStorage.setItem("synthetic.processedRegons", JSON.stringify(processed));
      return {
        promptCount: Number(localStorage.getItem("synthetic.smsPromptCount") ?? "0"),
        processedRegons: processed,
      };
    }, regon);
    const firstCompany = await runSyntheticCompany("111111111");
    const secondCompany = await runSyntheticCompany("222222222");
    assert.equal(firstCompany.promptCount, 1, "pierwsza firma uruchamia jeden syntetyczny prompt MFA");
    assert.equal(secondCompany.promptCount, 1, "druga firma korzysta z tej samej zalogowanej sesji");
    assert.deepEqual(secondCompany.processedRegons, ["111111111", "222222222"]);
    const compensa = await first.page("compensa");
    assert.notEqual(compensa, pzu);
    await first.close();

    const second = new BrowserSession({ profileDirectory: directory });
    assert.notEqual(second.sessionId, first.sessionId);
    try {
      const page = await second.page("pzu");
      await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, body: "<title>Pilot</title>" }));
      await page.goto("https://goldis.test/pzu");
      assert.equal(await page.evaluate(() => localStorage.getItem("remembered")), "yes");
      const afterRestart = await page.evaluate(() => {
        const promptCount = Number(localStorage.getItem("synthetic.smsPromptCount") ?? "0");
        if (localStorage.getItem("synthetic.authenticated") !== "yes") {
          localStorage.setItem("synthetic.smsPromptCount", String(promptCount + 1));
          localStorage.setItem("synthetic.authenticated", "yes");
        }
        const processed = JSON.parse(localStorage.getItem("synthetic.processedRegons") ?? "[]") as string[];
        processed.push("333333333");
        localStorage.setItem("synthetic.processedRegons", JSON.stringify(processed));
        return {
          promptCount: Number(localStorage.getItem("synthetic.smsPromptCount") ?? "0"),
          processedRegons: processed,
        };
      });
      assert.equal(afterRestart.promptCount, 1, "restart z zachowanym profilem nie wywołuje kolejnego promptu MFA");
      assert.deepEqual(afterRestart.processedRegons, ["111111111", "222222222", "333333333"]);
      await page.setContent(`<table><thead><tr><th>Podsumowanie</th><th>OC</th><th>AC</th></tr></thead><tbody><tr><td>Liczba polis</td><td>2</td><td>0</td></tr></tbody></table>
        <button onclick="document.querySelector('#oc').style.display='table'">Szczegóły polis OC</button>
        <table id="oc" style="display:none"><thead><tr><th>L.p.</th><th>Ubezpieczony</th><th>Typ i nr polisy</th><th>Rodzaj umowy</th><th>Liczba szkód Ubezpieczonego</th><th>Nr rejestracyjny</th><th>Grupa pojazdu</th><th>Marka</th><th>Model</th><th>ZU</th><th>Okres ub. od</th><th>Okres ub. do</th><th>Akcje</th></tr></thead><tbody>
        <tr><td>1</td><td>Osoba</td><td>OC 1</td><td>Nowa</td><td>0</td><td>AAA111</td><td>Auto</td><td>Marka</td><td>Model</td><td>ZU</td><td>2026-01-01</td><td>2026-09-28</td><td></td></tr>
        <tr><td>2</td><td>Osoba</td><td>OC 2</td><td>Nowa</td><td>0</td><td>BBB222</td><td>Auto</td><td>Marka</td><td>Model</td><td>ZU</td><td>2026-01-01</td><td>2026-09-29</td><td></td></tr>
        </tbody></table>`);
      const collected = await collectCurrentOc(page, "2026-09-29");
      assert.equal(collected.totalCount, 2);
      assert.equal(collected.policies.length, 1);
      const expectedCount = await readOcSummaryCount(page);
      assert.equal(expectedCount, 2);
      const policies = await readOcRows(page, expectedCount);
      assert.equal(policies.length, 2);
      assert.equal(selectCurrentPolicies(policies, "2026-09-29")[0].vehicleRegistration, "BBB222");
      await assert.rejects(readOcRows(page, 3), /UFG_INCOMPLETE/);
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wirtualizowana tabela OC przewijana wewnątrz modalu zwraca wszystkie rekordy albo jawny błąd", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-oc-virtualized-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("compensa");
    const fixtureRows = Array.from({ length: 158 }, (_, index) => {
      const ordinal = index + 1;
      return [String(ordinal), "Osoba testowa", `OC TEST ${ordinal}`, "Nowa", "0", `TEST${String(ordinal).padStart(4, "0")}`,
        "Samochód", "Marka testowa", "Model testowy", "ZU testowe", "2026-01-01", "2027-01-01", ""];
    });
    const data = JSON.stringify(fixtureRows);
    await page.setContent(`<style>
      #viewport { height: 210px; width: 900px; overflow-y: auto; position: relative; }
      #spacer { height: 4740px; }
      #oc-table { position: absolute; top: 0; left: 0; width: 1100px; background: white; }
      #oc-table td, #oc-table th { height: 30px; min-width: 70px; }
    </style>
    <div id="viewport"><div id="spacer"></div>
      <table id="oc-table"><thead><tr><th>L.p.</th><th>Ubezpieczony</th><th>Typ i nr polisy</th><th>Rodzaj umowy</th>
        <th>Liczba szkód Ubezpieczonego</th><th>Nr rejestracyjny</th><th>Grupa pojazdu</th><th>Marka</th><th>Model</th><th>ZU</th>
        <th>Okres ub. od</th><th>Okres ub. do</th><th>Akcje</th></tr></thead><tbody></tbody></table>
    </div>
    <script>
      const allRows = ${data};
      const viewport = document.querySelector('#viewport');
      const body = document.querySelector('#oc-table tbody');
      function render() {
        const first = Math.floor(viewport.scrollTop / 30);
        body.innerHTML = allRows.slice(first, first + 7).map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('');
      }
      viewport.addEventListener('scroll', render);
      render();
    </script>`);

    await page.locator("#viewport").evaluate(element => { element.scrollTop = 900; });
    await page.waitForTimeout(100);
    const policies = await readOcRows(page, 158);
    assert.equal(policies.length, 158);
    assert.equal(policies[0].sourceOrdinal, 1);
    assert.equal(policies[157].sourceOrdinal, 158);
    assert.equal(policies[157].vehicleRegistration, "TEST0158");
    await assert.rejects(readOcRows(page, 159), /UFG_INCOMPLETE/);

    const headings = ["L.p.", "Ubezpieczony", "Typ i nr polisy", "Rodzaj umowy", "Liczba szkód Ubezpieczonego",
      "Nr rejestracyjny", "Grupa pojazdu", "Marka", "Model", "ZU", "Okres ub. od", "Okres ub. do", "Akcje"];
    const swappedHeadings = [...headings];
    [swappedHeadings[1], swappedHeadings[5]] = [swappedHeadings[5], swappedHeadings[1]];
    const swappedRow = [...fixtureRows[0]];
    [swappedRow[1], swappedRow[5]] = [swappedRow[5], swappedRow[1]];
    await page.setContent(`<table><thead><tr>${swappedHeadings.map((heading) => `<th>${heading}</th>`).join("")}</tr></thead>
      <tbody><tr>${swappedRow.map((cell) => `<td>${cell}</td>`).join("")}</tr></tbody></table>`);
    const reordered = await readOcRows(page, 1);
    assert.equal(reordered[0].insuredName, "Osoba testowa");
    assert.equal(reordered[0].vehicleRegistration, "TEST0001", "mapowanie korzysta z nagłówka, a nie pozycji kolumny");
    const brokenHeadings = [...headings];
    brokenHeadings[12] = "Nieznana kolumna";
    await page.setContent(`<table><thead><tr>${brokenHeadings.map((heading) => `<th>${heading}</th>`).join("")}</tr></thead><tbody></tbody></table>`);
    await assert.rejects(readOcRows(page, 0), /UFG_SCHEMA_CHANGED/);
    const goodTable = `<table><thead><tr>${headings.map(heading => `<th>${heading}</th>`).join("")}</tr></thead><tbody><tr>${fixtureRows[0].map(cell => `<td>${cell}</td>`).join("")}</tr></tbody></table>`;
    await page.setContent(goodTable.replace("<table>", "<table hidden>") + goodTable);
    assert.equal((await readOcRows(page, 1))[0].sourceOrdinal, 1, "hidden stale tables are ignored");
    await page.setContent(goodTable + goodTable);
    await assert.rejects(readOcRows(page, 1), /UFG_TABLE_AMBIGUOUS/);
    await page.setContent(goodTable.replace("</tbody>", `<tr>${fixtureRows[0].map(cell => `<td>${cell}</td>`).join("")}</tr></tbody>`));
    await assert.rejects(readOcRows(page, 1), /UFG_ORDINAL_INVALID/);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("zero OC without a details button produces an empty complete snapshot", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-oc-zero-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await browser.page("compensa");
    await page.setContent('<table><tr><th></th><th>OC</th></tr><tr><td>Liczba polis</td><td>0</td></tr></table>');
    page.setDefaultTimeout(300);
    const snapshot = await readOcSnapshot(page, "2026-10-09T10:00:00.000Z", "fixture-v1");
    assert.equal(snapshot.totalCount, 0);
    assert.deepEqual(snapshot.policies, []);
    assert.deepEqual(await collectCurrentOc(page, "2026-10-09"), { totalCount: 0, policies: [] });
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("summary ignores hidden stale tables and rejects ambiguous or unsafe counts", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-oc-summary-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  const table = (value: string, hidden = false) => `<table ${hidden ? "hidden" : ""}><tr><th></th><th>OC</th></tr><tr><td>Liczba polis</td><td>${value}</td></tr></table>`;
  try {
    const page = await browser.page("compensa"); page.setDefaultTimeout(300);
    await page.setContent(table("99", true) + table("1"));
    assert.equal(await readOcSummaryCount(page), 1);
    await page.setContent(table("1") + table("2"));
    await assert.rejects(readOcSummaryCount(page), /UFG_SUMMARY_AMBIGUOUS/);
    for (const value of ["", "-1", "1.5", "9007199254740992"]) {
      await page.setContent(table(value));
      await assert.rejects(readOcSummaryCount(page), /UFG_COUNT_INVALID/);
    }
    await page.setContent('<table><tr><th></th><th>OC</th><th>OC</th></tr><tr><td>Liczba polis</td><td>1</td><td>2</td></tr></table>');
    await assert.rejects(readOcSummaryCount(page), /UFG_COUNT_INVALID/);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
