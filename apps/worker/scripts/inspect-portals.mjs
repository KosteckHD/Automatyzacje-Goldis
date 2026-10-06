import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
const require = createRequire(import.meta.url);
const { parseTransportWorkbook } = require("../../api/dist/workbook.js");
const { readOcSnapshot, selectCurrentPolicies } = require("../dist/oc.js");

const profile = resolve(process.env.WORKER_PROFILE_DIR || "worker-profiles/portal-local");
const urls = {
  pzu: process.env.PZU_LOGIN_URL,
  compensa: process.env.COMPENSA_LOGIN_URL,
};
for (const [portal, raw] of Object.entries(urls)) {
  if (!raw || new URL(raw).protocol !== "https:") throw new Error(`${portal.toUpperCase()}_URL_INVALID`);
}

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  acceptDownloads: false,
  locale: "pl-PL",
  timezoneId: "Europe/Warsaw",
  viewport: { width: 1440, height: 900 },
});
const pages = new Map();
let capturedPesel = null;
let lastSearchRowNumber = null;
let verifiedAccount = null;
const normalized = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("pl-PL").replace(/[^a-ząćęłńóśźż0-9]+/g, " ").trim();
context.on("page", (page) => {
  page.on("response", (response) => {
    if (response.status() !== 403) return;
    try {
      const url = new URL(response.url());
      console.log(`HTTP 403 ${url.origin}${url.pathname.replace(/[0-9a-f]{8,}/gi, "[id]")}`);
    } catch {
      console.log("HTTP 403 (adres niedostępny)");
    }
  });
});

async function open(portal) {
  let page = pages.get(portal);
  if (!page || page.isClosed()) {
    page = await context.newPage();
    pages.set(portal, page);
  }
  await page.bringToFront();
  try {
    const response = await page.goto(urls[portal], { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`${portal}: odpowiedź ${response?.status() ?? "brak"}`);
  } catch (error) {
    const code = error instanceof Error ? error.message.match(/net::[A-Z_]+/)?.[0] : undefined;
    console.log(`${portal}: nawigacja nie została potwierdzona (${code ?? "timeout"})`);
  }
  console.log(`${portal}: okno gotowe`);
}

async function inspect(portal) {
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  const result = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const compact = (value) => typeof value === "string" ? value.trim().slice(0, 80) : "";
    const elements = Array.from(document.querySelectorAll("input, select, button, [role=button], table, iframe"))
      .filter(visible).slice(0, 100).map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: compact(element.getAttribute("type")),
        id: compact(element.id),
        name: compact(element.getAttribute("name")),
        className: compact(typeof element.className === "string" ? element.className : ""),
        placeholder: compact(element.getAttribute("placeholder")),
        ariaLabel: compact(element.getAttribute("aria-label")),
        title: compact(element.getAttribute("title")),
        role: compact(element.getAttribute("role")),
        disabled: "disabled" in element ? element.disabled : false,
      }));
    return { origin: location.origin, route: location.pathname.replace(/[0-9a-f]{8,}/gi, "[id]"), elements };
  });
  console.log(JSON.stringify({ portal, ...result }));
}

async function links(portal) {
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  const result = await page.locator("a[href]").evaluateAll((anchors) => anchors.slice(0, 40).map((anchor) => {
    const target = new URL(anchor.href);
    return {
      text: /zalog|login|powr|ponown|start/i.test(anchor.textContent || "") ? anchor.textContent.trim().slice(0, 50) : "",
      origin: target.origin,
      route: target.pathname.replace(/[0-9a-f]{8,}/gi, "[id]"),
    };
  }));
  console.log(JSON.stringify({ portal, links: result }));
}

async function map(portal) {
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  const rows = await page.evaluate(() => {
    const allowedText = /^(?:komunikacj|ubezpiecz|weryfikacj|ufg|szukaj|nowa|zapisz|wyloguj|logowanie|dalej|potwierd|klien|konto|ofert|polisy|menu)/i;
    return Array.from(document.querySelectorAll("a, button, input, select, [role=button]"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).slice(0, 80).map((element) => {
        const label = (element.textContent || "").trim().replace(/\s+/g, " ");
        return {
          tag: element.tagName.toLowerCase(), id: element.id || "",
          className: typeof element.className === "string" ? element.className.slice(0, 100) : "",
          type: element.getAttribute("type") || "",
          placeholder: element.getAttribute("placeholder") || "",
          text: allowedText.test(label) ? label.slice(0, 50) : "",
        };
      });
  });
  rows.forEach((row, index) => console.log(`${portal} ${index}: ${JSON.stringify(row)}`));
}

async function tableShape(portal) {
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  const rows = await page.evaluate(() => {
    const table = document.querySelector("table.gw-ListViewWidget--table");
    if (!table) return [];
    return Array.from(table.querySelectorAll("tr")).slice(0, 8).map((row) => ({
      cells: Array.from(row.querySelectorAll("th, td")).map((cell) => {
        const value = (cell.textContent || "").trim().replace(/\s+/g, " ");
        return {
          tag: cell.tagName.toLowerCase(),
          className: typeof cell.className === "string" ? cell.className.slice(0, 60) : "",
          kind: /^Osoba fizyczna prowadząca działalność gospodarczą$/i.test(value) ? "business"
            : /^Osoba fizyczna$/i.test(value) ? "person" : "",
          numericLengths: Array.from(value.matchAll(/(?<!\d)\d{9,14}(?!\d)/g)).map((match) => match[0].length),
          hasAccountButton: Boolean(cell.querySelector('[id$="-AccountNumber_button"]')),
        };
      }),
    }));
  });
  console.log(JSON.stringify({ portal, tableShape: rows }));
}

async function formShape(portal) {
  if (portal !== "compensa") return console.log("form: tylko Compensa");
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log("compensa: brak otwartej karty");
  const rows = await page.locator("insured-section label").evaluateAll((labels) => labels.slice(0, 100).map((label) => {
    const raw = (label.textContent || "").trim().replace(/\s+/g, " ");
    const fieldName = raw.length <= 60 && !/\d/.test(raw) ? raw : "";
    const parent = label.parentElement;
    const controls = Array.from(parent?.querySelectorAll("input, select, button") || []).slice(0, 5).map((node) => ({
      tag: node.tagName.toLowerCase(), type: node.getAttribute("type") || "", id: node.id || "",
      disabled: "disabled" in node ? node.disabled : false,
      filled: "value" in node ? Boolean(String(node.value || "").trim()) : false,
      title: (node.getAttribute("title") || "").replace(/\d/g, "#").slice(0, 40),
    }));
    return { fieldName, controls };
  }));
  console.log(JSON.stringify({ portal, formShape: rows }));
}

async function searchWorkbookRow(portal, rowNumberText) {
  if (portal !== "pzu" || !/^\d{1,6}$/.test(rowNumberText || "")) return console.log("Wyszukiwanie wymaga numeru wiersza");
  const page = pages.get("pzu");
  if (!page || page.isClosed() || new URL(page.url()).origin !== "https://everest.pzu.pl") {
    return console.log("pzu: brak ekranu Everest");
  }
  const rows = await parseTransportWorkbook(await readFile(resolve("docs/BAZA TRANSPORTOWA.xlsx")));
  const source = rows.find((row) => row.rowNumber === Number(rowNumberText));
  if (!source || source.issues.length || !source.effectiveRegon) return console.log("pzu: wiersz niekwalifikowany");
  const input = page.locator('input[placeholder^="PESEL/REGON"], input[name$="-smartsearch"]').first();
  await input.fill(source.effectiveRegon);
  await input.press("Enter");
  lastSearchRowNumber = source.rowNumber;
  console.log("pzu: wyszukiwanie REGON z wiersza źródłowego wysłane");
}

async function searchNoMatch(portal) {
  if (portal !== "pzu") return console.log("empty: tylko PZU");
  const page = pages.get("pzu");
  if (!page || page.isClosed() || new URL(page.url()).origin !== "https://everest.pzu.pl") {
    return console.log("pzu: brak ekranu Everest");
  }
  const input = page.locator('input[placeholder^="PESEL/REGON"], input[name$="-smartsearch"]').first();
  await input.fill("999999999999999");
  await input.press("Enter");
  lastSearchRowNumber = null;
  capturedPesel = null;
  console.log("pzu: wysłano testowy numer bez danych klienta");
}

async function structuredCommand(command) {
  const { portal, operation, selector } = command;
  if (!Object.hasOwn(urls, portal) || typeof selector !== "string" || selector.length < 1 || selector.length > 240) {
    return console.log("Komenda strukturalna: nieprawidłowe wejście");
  }
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  const locator = page.locator(selector);
  const index = Number.isInteger(command.index) && command.index >= 0 && command.index < 20 ? command.index : 0;
  if (operation === "count") return console.log(`${portal}: count=${await locator.count()}`);
  if (operation === "verifyAccount") {
    if (portal !== "pzu" || !Number.isInteger(command.rowNumber)) return console.log("verifyAccount: nieprawidłowy wiersz");
    const rows = await parseTransportWorkbook(await readFile(resolve("docs/BAZA TRANSPORTOWA.xlsx")));
    const source = rows.find((row) => row.rowNumber === command.rowNumber);
    if (!source || source.issues.length || !source.effectiveRegon || !source.decisionMakerName) return console.log("verifyAccount: niekwalifikowany wiersz");
    const regonWidget = page.locator('div.gw-InputWidget:has(> .gw-label:text-is("REGON")) .gw-value').first();
    const nameWidget = page.locator('div.gw-InputWidget:has(> .gw-label:text-is("Pełna nazwa firmy")) .gw-value').first();
    const regonMatches = (await regonWidget.innerText()).replace(/\D/g, "") === source.effectiveRegon;
    const displayName = normalized(await nameWidget.innerText());
    const decisionMatches = displayName.includes(normalized(source.decisionMakerName));
    const significantSourceWords = normalized(source.companyName).split(" ").filter((word) => word.length >= 4);
    const companyMatches = significantSourceWords.length > 0 && significantSourceWords.every((word) => displayName.split(" ").includes(word));
    const accountText = await page.locator("#AccountFile-AccountFileInfoBar-Account").innerText();
    const accountNumbers = [...accountText.matchAll(/(?<!\d)\d{10}(?!\d)/g)].map((match) => match[0]);
    if (!regonMatches || !decisionMatches || !companyMatches || accountNumbers.length !== 1) {
      verifiedAccount = null;
      return console.log(JSON.stringify({ portal, accountVerified: false, regonMatches, decisionMatches, companyMatches, accountNumberCount: accountNumbers.length }));
    }
    verifiedAccount = { rowNumber: source.rowNumber, accountNumber: accountNumbers[0] };
    return console.log("pzu: szczegóły działalności zgodne z REGON, nazwą i osobą z wiersza źródłowego");
  }
  if (operation === "fieldStatus") {
    const value = await locator.nth(index).inputValue();
    const status = { filled: Boolean(value.trim()), matchesCapturedPesel: Boolean(capturedPesel && value.trim() === capturedPesel) };
    if (Number.isInteger(command.rowNumber) && ["address", "postalCode", "city"].includes(command.field)) {
      const rows = await parseTransportWorkbook(await readFile(resolve("docs/BAZA TRANSPORTOWA.xlsx")));
      const source = rows.find((row) => row.rowNumber === command.rowNumber);
      status.matchesSource = Boolean(source && value.trim() === source[command.field]);
    }
    return console.log(JSON.stringify({ portal, fieldStatus: status }));
  }
  if (operation === "outline") {
    const nodes = await locator.evaluateAll((elements) => elements.slice(0, 8).map((element) => {
      const label = (element.textContent || "").trim().replace(/\s+/g, " ");
      const allowed = /^(?:Everest|Compensa Komunikacja|Ubezpieczający|Pełnomocnik|Podaj REGON lub PESEL|Numer rejestracyjny|Wybierz:|Zapisz|Weryfikacja UFG|Szczegóły polis OC|Osoba fizyczna|Osoba fizyczna prowadząca działalność gospodarczą)$/i;
      return {
        tag: element.tagName.toLowerCase(), id: element.id || "",
        className: typeof element.className === "string" ? element.className.slice(0, 100) : "",
        role: element.getAttribute("role") || "", type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "", placeholder: element.getAttribute("placeholder") || "",
        label: allowed.test(label) ? label : "", numberLengths: [...label.matchAll(/(?<!\d)\d{9,14}(?!\d)/g)].map((match) => match[0].length),
        parent: element.parentElement ? {
          tag: element.parentElement.tagName.toLowerCase(),
          className: typeof element.parentElement.className === "string" ? element.parentElement.className.slice(0, 100) : "",
        } : null,
        children: Array.from(element.children).slice(0, 12).map((child) => ({ tag: child.tagName.toLowerCase(), className: typeof child.className === "string" ? child.className.slice(0, 60) : "" })),
      };
    }));
    return console.log(JSON.stringify({ portal, outline: nodes }));
  }
  if (operation === "click") {
    await locator.nth(index).click();
    return console.log(`${portal}: kliknięto element ${index}`);
  }
  if (operation === "fillSource") {
    const field = command.field;
    if (!Number.isInteger(command.rowNumber) || !["effectiveRegon", "address", "postalCode", "city"].includes(field)) {
      return console.log("fillSource: nieprawidłowe pole");
    }
    const rows = await parseTransportWorkbook(await readFile(resolve("docs/BAZA TRANSPORTOWA.xlsx")));
    const source = rows.find((row) => row.rowNumber === command.rowNumber);
    if (!source || source.issues.length || !source[field]) return console.log("fillSource: brak poprawnej wartości");
    await locator.nth(index).fill(source[field]);
    return console.log(`${portal}: uzupełniono pole ${field}`);
  }
  if (operation === "fillRegistration") {
    await locator.nth(index).fill("RST22339");
    return console.log(`${portal}: uzupełniono numer rejestracyjny`);
  }
  if (operation === "captureBusinessPesel") {
    if (portal !== "pzu" || lastSearchRowNumber !== command.rowNumber || typeof command.cellSelector !== "string") {
      return console.log("captureBusinessPesel: brak potwierdzonego wyszukiwania");
    }
    const rows = await parseTransportWorkbook(await readFile(resolve("docs/BAZA TRANSPORTOWA.xlsx")));
    const source = rows.find((row) => row.rowNumber === command.rowNumber);
    if (!source || source.issues.length || !source.effectiveRegon) return console.log("captureBusinessPesel: nieprawidłowy wiersz");
    const row = locator.nth(index);
    const rowText = (await row.innerText()).normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
    const decisionMaker = normalized(source.decisionMakerName);
    const accountCell = await row.locator("td:first-child").innerText();
    const accountNumber = [...accountCell.matchAll(/(?<!\d)\d{10}(?!\d)/g)].map((match) => match[0]);
    if (!verifiedAccount || verifiedAccount.rowNumber !== source.rowNumber
      || accountNumber.length !== 1 || accountNumber[0] !== verifiedAccount.accountNumber
      || !rowText.includes("osoba fizyczna prowadząca działalność gospodarczą")
      || !normalized(rowText).includes(decisionMaker)) {
      return console.log("pzu: wiersz działalności nie zgadza się z danymi źródłowymi");
    }
    const value = (await row.locator(command.cellSelector).first().innerText()).trim();
    const matches = [...value.matchAll(/(?<!\d)\d{11}(?!\d)/g)].map((match) => match[0]);
    if (matches.length !== 1) return console.log(`pzu: PESEL niejednoznaczny (liczba dopasowań ${matches.length})`);
    capturedPesel = matches[0];
    return console.log("pzu: zachowano jeden PESEL w pamięci procesu");
  }
  if (operation === "fillCapturedPesel") {
    if (portal !== "compensa" || !capturedPesel) return console.log("compensa: brak potwierdzonego PESEL-u");
    await locator.nth(index).fill(capturedPesel);
    return console.log("compensa: wpisano PESEL z Everest");
  }
  if (operation === "capturePersonPesel") {
    if (portal !== "pzu" || lastSearchRowNumber !== command.rowNumber || typeof command.cellSelector !== "string") {
      return console.log("capturePersonPesel: brak potwierdzonego wyszukiwania");
    }
    const rows = await parseTransportWorkbook(await readFile(resolve("docs/BAZA TRANSPORTOWA.xlsx")));
    const source = rows.find((row) => row.rowNumber === command.rowNumber);
    if (!source || source.issues.length || !source.effectiveRegon || !source.decisionMakerName) {
      return console.log("capturePersonPesel: nieprawidłowy wiersz");
    }
    const personRows = page.locator('table.gw-ListViewWidget--table tr:has(td:nth-child(3):has-text("Osoba fizyczna")):not(:has(td:nth-child(3):has-text("prowadząca działalność")))');
    if (await personRows.count() !== 1) return console.log("pzu: wiersz osoby fizycznej niejednoznaczny");
    const personRow = personRows.first();
    const displayedName = normalized(await personRow.locator("td:nth-child(5)").innerText());
    const expectedName = normalized(source.decisionMakerName);
    const companyWords = normalized(source.companyName).split(" ").filter((word) => word.length >= 4);
    const displayWords = new Set(displayedName.split(" "));
    if (!(displayedName === expectedName || displayedName.startsWith(`${expectedName} `))
      || companyWords.length === 0 || !companyWords.every((word) => displayWords.has(word))) {
      return console.log("pzu: osoba lub firma nie zgadza się z arkuszem");
    }
    const value = (await personRow.locator(command.cellSelector).first().innerText()).trim();
    const matches = [...value.matchAll(/(?<!\d)\d{11}(?!\d)/g)].map((match) => match[0]);
    if (matches.length !== 1) return console.log(`pzu: PESEL niejednoznaczny (liczba dopasowań ${matches.length})`);
    const businessRows = page.locator('table.gw-ListViewWidget--table tr:has(td:nth-child(3):has-text("Osoba fizyczna prowadząca działalność gospodarczą"))');
    if (await businessRows.count() === 1) {
      const other = (await businessRows.first().locator(command.cellSelector).innerText()).replace(/\D/g, "");
      if (/^\d{11}$/.test(other) && other !== matches[0]) return console.log("pzu: różne numery PESEL w dwóch wierszach");
    }
    capturedPesel = matches[0];
    return console.log("pzu: zapisano PESEL z wiersza osoby fizycznej w pamięci procesu");
  }
  console.log("Nieznana operacja strukturalna");
}

async function messages(portal) {
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  const result = await page.evaluate(() => {
    const raw = (document.querySelector("#main_table")?.innerText || document.body.innerText || "")
      .trim().replace(/\s+/g, " ").slice(0, 1500);
    return raw.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
      .replace(/\b\d{6,}\b/g, "[number]");
  });
  console.log(`${portal}: ${result}`);
}

async function frames(portal) {
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const url = new URL(frame.url());
      const elements = await frame.locator("input, button, iframe").evaluateAll((nodes) => nodes.slice(0, 30).map((node) => ({
        tag: node.tagName.toLowerCase(), id: node.id || "", type: node.getAttribute("type") || "",
      })));
      console.log(`${portal} frame: ${JSON.stringify({ origin: url.origin, route: url.pathname, elements })}`);
    } catch {
      console.log(`${portal} frame: niedostępna`);
    }
  }
}

async function snapshotUfg(portal) {
  if (portal !== "compensa") return console.log("UFG: tylko Compensa");
  const page = pages.get("compensa");
  if (!page || page.isClosed()) return console.log("compensa: brak otwartej karty");
  const snapshot = await readOcSnapshot(page, new Date().toISOString(), "live-inspection-v1");
  const referenceDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const current = selectCurrentPolicies(snapshot.policies, referenceDate);
  console.log(JSON.stringify({ portal, totalOc: snapshot.totalCount, readOc: snapshot.policies.length, currentOc: current.length, referenceDate }));
}

function listPages() {
  context.pages().forEach((page, index) => {
    try {
      const url = new URL(page.url());
      console.log(`page ${index}: ${url.origin}${url.pathname.replace(/[0-9a-f]{8,}/gi, "[id]")}`);
    } catch {
      console.log(`page ${index}: brak adresu`);
    }
  });
}

const allowedNavigation = new Map([
  ["komunikacja", "Komunikacja"],
  ["klienci", "Klienci"],
  ["ufg", "UFG"],
]);
async function findNavigation(portal, key, shouldClick) {
  const page = pages.get(portal);
  if (!page || page.isClosed()) return console.log(`${portal}: brak otwartej karty`);
  const label = allowedNavigation.get(key);
  if (!label) return console.log("Etykieta poza listą nawigacji");
  const matching = page.getByText(label, { exact: true });
  const count = await matching.count();
  console.log(`${portal}: ${label} count=${count}`);
  if (!shouldClick) {
    for (let index = 0; index < Math.min(count, 8); index += 1) {
      const detail = await matching.nth(index).evaluate((element) => ({
        tag: element.tagName.toLowerCase(), id: element.id || "",
        className: typeof element.className === "string" ? element.className.slice(0, 120) : "",
        parentTag: element.parentElement?.tagName.toLowerCase() || "",
        parentClass: typeof element.parentElement?.className === "string" ? element.parentElement.className.slice(0, 120) : "",
      }));
      console.log(`${portal}: ${JSON.stringify(detail)}`);
    }
    return;
  }
  if (count !== 1) return console.log("Kliknięcie wymaga jednoznacznej etykiety");
  await matching.click();
  console.log(`${portal}: nawigacja ${label}`);
}

async function loginCompensa() {
  const page = pages.get("compensa");
  if (!page || page.isClosed()) return console.log("compensa: brak otwartej karty");
  const username = process.env.COMPENSA_LOGIN;
  const password = process.env.COMPENSA_PASSWORD;
  if (!username || !password) throw new Error("COMPENSA_CREDENTIALS_MISSING");
  await page.locator("#login").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#submitLogin").click();
  console.log("compensa: formularz logowania wysłany");
}

async function loginPzu() {
  const page = pages.get("pzu");
  if (!page || page.isClosed()) return console.log("pzu: brak otwartej karty");
  if (!await page.locator('input[name="username"]').isEnabled()
    || !await page.locator('input[name="password"]').isEnabled()) {
    return console.log("pzu: formularz logowania nieaktywny; poświadczeń nie wysłano");
  }
  const username = process.env.PZU_LOGIN;
  const password = process.env.PZU_PASSWORD;
  if (!username || !password) throw new Error("PZU_CREDENTIALS_MISSING");
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[type="submit"]').first().click();
  console.log("pzu: formularz logowania wysłany");
}

await open("pzu");
console.log("Komendy: pages | inspect|map|links|messages|frames|open|login pzu|compensa | find|click compensa komunikacja|klienci|ufg | quit");
const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
for await (const line of input) {
  if (line.trim().startsWith("{")) {
    try {
      await structuredCommand(JSON.parse(line));
    } catch (error) {
      console.log(`Komenda strukturalna: ${error?.name === "TimeoutError" ? "timeout" : "portal_error"}`);
    }
    continue;
  }
  const [action, portal, key] = line.trim().split(/\s+/);
  if (action === "quit") break;
  if (action === "pages") { listPages(); continue; }
  if (action === "adopt" && portal === "pzu") {
    const matches = context.pages().filter((page) => !page.isClosed() && page.url().startsWith("https://everest.pzu.pl/"));
    if (matches.length === 1) { pages.set("pzu", matches[0]); console.log("pzu: przejęto kartę Everest"); }
    else console.log(`pzu: liczba kart Everest ${matches.length}`);
    continue;
  }
  if (!Object.hasOwn(urls, portal)) {
    console.log("Nieznana komenda lub portal");
    continue;
  }
  try {
    if (action === "inspect") await inspect(portal);
    else if (action === "map") await map(portal);
    else if (action === "messages") await messages(portal);
    else if (action === "shape") await tableShape(portal);
    else if (action === "form") await formShape(portal);
    else if (action === "search") await searchWorkbookRow(portal, key);
    else if (action === "empty") await searchNoMatch(portal);
    else if (action === "frames") await frames(portal);
    else if (action === "snapshot") await snapshotUfg(portal);
    else if (action === "find") await findNavigation(portal, key, false);
    else if (action === "click") await findNavigation(portal, key, true);
    else if (action === "links") await links(portal);
    else if (action === "open") await open(portal);
    else if (action === "login" && portal === "compensa") await loginCompensa();
    else if (action === "login" && portal === "pzu") await loginPzu();
    else console.log("Nieznana komenda");
  } catch (error) {
    // Playwright's error text may contain filled credentials or page content.
    console.log(`${portal}: operacja nieudana (${error?.name === "TimeoutError" ? "timeout" : "portal_error"})`);
  }
}
input.close();
await context.close();
