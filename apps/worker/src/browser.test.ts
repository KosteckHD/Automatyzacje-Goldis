import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { BrowserSession } from "./browser";
import { collectCurrentOc, readOcRows, readOcSummaryCount, selectCurrentPolicies } from "./oc";

test("każdy właściciel profilu przeglądarki otrzymuje osobny, niejawny identyfikator sesji", () => {
  const first = new BrowserSession({ profileDirectory: join(tmpdir(), "goldis-session-id-test-a") });
  const second = new BrowserSession({ profileDirectory: join(tmpdir(), "goldis-session-id-test-b") });
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(first.sessionId, second.sessionId);
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
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
