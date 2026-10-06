import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "./browser";
import { CompensaPortalSession, type CompensaSessionOptions } from "./compensa-session";
import { CompensaFormAssistant, type CompensaFormOptions } from "./compensa-form";
import type { WorkerRunContext } from "./ports";

const sessionOptions: CompensaSessionOptions = {
  entryUrl: "https://goldis.test/compensa",
  selectors: {
    authenticated: '[data-screen="home"]', loginForm: '[data-screen="login"]', usernameInput: 'input[name="username"]',
    passwordInput: 'input[name="password"]', loginSubmit: '[data-action="login"]', smsChallenge: '[data-screen="sms"]',
    accessDenied: '[data-screen="denied"]',
  },
};

function context(): WorkerRunContext {
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
      id: "22222222-2222-4222-8222-222222222222", rowNumber: 18001, companyName: "Fikcyjna Firma Testowa",
      decisionMakerName: "Ala Testowa", nipRaw: "", address: "Uliczna 9", postalCode: "11-111", city: "Testowo",
      regonRaw: "012345678", regon: "012345678", effectiveRegon: "012345678", issues: [],
    },
    status: "compensa_form", cancelRequested: false,
    identity: {
      schemaVersion: 1, sourceRowId: "22222222-2222-4222-8222-222222222222", regon: "012345678",
      companyName: "Fikcyjna Firma Testowa", firstName: "Ala", lastName: "Testowa", pesel: "90010100016",
      matchMethod: "regon_company_name_decision_maker", adapterVersion: "everest-fixture-v1",
    },
  } as WorkerRunContext;
}

function formOptions(authorizeStart: CompensaFormOptions["authorizeStart"]): CompensaFormOptions {
  return {
    selectors: {
      communicationTile: "#compensa-communication-tile", startDialog: "#start-dialog",
      identifierInput: 'input[name="insuredIdentifier"]', registrationInput: 'input[name="vehicleRegistration"]',
      startCommunication: "#start-communication", insuredDataSection: "#insured-data", roleSelect: 'select[name="role"]',
      firstNameInput: 'input[name="firstName"]', lastNameInput: 'input[name="lastName"]', peselInput: 'input[name="pesel"]',
      addressInput: 'input[name="address"]', postalCodeInput: 'input[name="postalCode"]', cityInput: 'input[name="city"]',
      countyInput: 'input[name="county"]', saveButton: "#save-insured",
    },
    configuredRegistrationNumber: "RST22339",
    adapterVersion: "compensa-fixture-v1",
    authorizeStart,
    recordDraftReference: async () => true,
  };
}

test("Compensa form wybiera Ubezpieczającego, podaje PESEL i tablicę, zachowuje dane i nie klika Zapisz", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-form-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const session = new CompensaPortalSession(browser, sessionOptions);
    let authorizedCalls = 0;
    const assistant = new CompensaFormAssistant(browser, session, formOptions(async (input) => {
      authorizedCalls += 1;
      assert.equal(input.runId, context().run.runId);
      assert.equal(input.sourceRowId, context().source.id);
      return true;
    }));

    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "ready_to_save" });
    assert.equal(authorizedCalls, 1, "zamiar uruchomienia formularza jest autoryzowany raz");
    assert.equal(await page.locator('input[name="insuredIdentifier"]').inputValue(), "90010100016");
    assert.equal(await page.locator('input[name="vehicleRegistration"]').inputValue(), "RST22339");
    assert.equal(await page.locator('select[name="role"]').inputValue(), "Ubezpieczający");
    assert.equal(await page.locator('input[name="address"]').inputValue(), "Portalowa 1", "wypełniony adres portalu nie jest nadpisany");
    assert.equal(await page.locator('input[name="postalCode"]').inputValue(), "00-000");
    assert.equal(await page.locator('input[name="city"]').inputValue(), "Portalowo");
    assert.equal(await page.locator('input[name="maidenName"]').inputValue(), "", "puste nazwisko rodowe jest opcjonalne");
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { syntheticSaved?: boolean }).syntheticSaved)), false);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Compensa zaznacza rolę Ubezpieczający, gdy portal pokazuje przycisk radio", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-radio-role-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const original = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const html = original.replace(
      '<select name="role"><option>Właściciel</option><option>Ubezpieczający</option></select>',
      '<label><input type="radio" name="role" value="Ubezpieczający">Ubezpieczający</label>',
    );
    assert.notEqual(html, original);
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const session = new CompensaPortalSession(browser, sessionOptions);
    const configured = formOptions(async () => true);
    const assistant = new CompensaFormAssistant(browser, session, {
      ...configured, selectors: { ...configured.selectors, roleSelect: 'label:has-text("Ubezpieczający")' },
    });
    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "ready_to_save" });
    assert.equal(await page.locator('input[name="role"]').isChecked(), true);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Compensa wybiera Ubezpieczającego w oknie startowym przed wpisaniem danych", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-dialog-role-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const original = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const html = original
      .replace('<h2>Compensa Komunikacja</h2>', '<h2>Compensa Komunikacja</h2><label><input type="radio" name="dialogRole" value="Ubezpieczający">Ubezpieczający</label>')
      .replace(/<label>Rola\s*<select name="role">[\s\S]*?<\/select>\s*<\/label>/, "")
      .replace("const dialog = document.querySelector('#start-dialog');", "const dialog = document.querySelector('#start-dialog'); document.querySelector('input[name=\"insuredIdentifier\"]').addEventListener('input', () => { if (!document.querySelector('input[name=\"dialogRole\"]').checked) window.syntheticEarlyFill = true; });")
      .replace("dialog.hidden = true;", "if (!document.querySelector('input[name=\"dialogRole\"]').checked) return; dialog.hidden = true;");
    assert.notEqual(html, original);
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const session = new CompensaPortalSession(browser, sessionOptions);
    const configured = formOptions(async () => true);
    const assistant = new CompensaFormAssistant(browser, session, {
      ...configured, selectors: { ...configured.selectors, roleSelect: 'input[name="dialogRole"]' },
    });
    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "ready_to_save" });
    assert.equal(await page.locator('input[name="dialogRole"]').isChecked(), true);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { syntheticEarlyFill?: boolean }).syntheticEarlyFill)), false);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Compensa uzupełnia tylko puste pola z tego samego wiersza, a brak powiatu wymaga operatora", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-address-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const session = new CompensaPortalSession(browser, sessionOptions);
    const assistant = new CompensaFormAssistant(browser, session, formOptions(async () => true));
    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "ready_to_save" });
    await page.locator('input[name="firstName"]').fill("");
    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "ready_to_save" });
    assert.equal(await page.locator('input[name="firstName"]').inputValue(), "Ala", "puste pole osoby jest uzupełniane z potwierdzonej tożsamości");
    await page.locator('input[name="address"]').fill("");
    await page.locator('input[name="postalCode"]').fill("");
    await page.locator('input[name="city"]').fill("");
    await page.locator('input[name="county"]').fill("");

    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "waiting_for_manual_data", fieldCode: "COUNTY" });
    assert.equal(await page.locator('input[name="address"]').inputValue(), "Uliczna 9");
    assert.equal(await page.locator('input[name="postalCode"]').inputValue(), "11-111");
    assert.equal(await page.locator('input[name="city"]').inputValue(), "Testowo");
    await page.locator('input[name="county"]').fill("Powiat ręczny");
    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "ready_to_save" });
    assert.equal(await page.locator('input[name="county"]').inputValue(), "Powiat ręczny", "wypełniona wartość nie jest nadpisana");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Compensa wybiera wyłącznie istniejącą opcję powiatu z zatwierdzonej poprawki", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-county-option-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const original = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const html = original.replace(
      '<label>Powiat<input name="county" value="Powiat testowy" /></label>',
      '<label>Powiat<select name="county"><option value="" selected>Wybierz</option><option value="COUNTY-TEST">Powiat testowy</option></select></label>',
    );
    assert.notEqual(html, original);
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const session = new CompensaPortalSession(browser, sessionOptions);
    const options = formOptions(async () => true);
    const assistant = new CompensaFormAssistant(browser, session, {
      ...options, selectors: { ...options.selectors, countyInput: '[name="county"]' },
    });
    const correctedContext = { ...context(), source: { ...context().source, countyCode: "COUNTY-TEST" } };
    assert.deepEqual(await assistant.prepareInsuredForm(correctedContext, context().identity), { kind: "ready_to_save" });
    assert.equal(await page.locator('select[name="county"]').inputValue(), "COUNTY-TEST");
    await page.locator('select[name="county"]').selectOption({ value: "" });
    const unknownOptionContext = { ...context(), source: { ...context().source, countyCode: "NOT-IN-PORTAL" } };
    assert.deepEqual(await assistant.prepareInsuredForm(unknownOptionContext, context().identity),
      { kind: "waiting_for_manual_data", fieldCode: "COUNTY" });
    assert.equal(await page.locator('select[name="county"]').inputValue(), "", "nieznana opcja nie jest zgadywana ani wybierana");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Compensa zatrzymuje formularz przy konflikcie osoby przed zapisem", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-identity-mismatch-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const session = new CompensaPortalSession(browser, sessionOptions);
    const assistant = new CompensaFormAssistant(browser, session, formOptions(async () => true));
    await page.goto(sessionOptions.entryUrl);
    await page.getByRole("button", { name: "Compensa Komunikacja", exact: true }).click();
    await page.locator('input[name="insuredIdentifier"]').fill("90010100016");
    await page.locator('input[name="vehicleRegistration"]').fill("RST22339");
    await page.locator("#start-communication").click();
    await page.locator('input[name="lastName"]').fill("Inna osoba");

    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "identity_review", reason: "identity_mismatch" });
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { syntheticSaved?: boolean }).syntheticSaved)), false);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Compensa zatrzymuje produkcyjny przebieg, gdy wyszukiwanie nie wypełni danych osoby", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-identity-empty-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const session = new CompensaPortalSession(browser, sessionOptions);
    const assistant = new CompensaFormAssistant(browser, session, {
      ...formOptions(async () => true), requirePrefilledIdentity: true,
    });
    await page.goto(sessionOptions.entryUrl);
    await page.getByRole("button", { name: "Compensa Komunikacja", exact: true }).click();
    await page.locator('input[name="insuredIdentifier"]').fill("90010100016");
    await page.locator('input[name="vehicleRegistration"]').fill("RST22339");
    await page.locator("#start-communication").click();
    await page.locator('input[name="firstName"]').fill("");

    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity), { kind: "identity_review", reason: "identity_mismatch" });
    assert.equal(await page.locator('input[name="firstName"]').inputValue(), "");
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { syntheticSaved?: boolean }).syntheticSaved)), false);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("wznowienie otwartego szkicu nie rozpoczyna drugiej oferty, gdy formularz zniknął", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-missing-draft-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    const assistant = new CompensaFormAssistant(browser, new CompensaPortalSession(browser, sessionOptions), {
      ...formOptions(async () => { throw new Error("MUST_NOT_CREATE_DRAFT"); }), requirePrefilledIdentity: true,
    });
    assert.deepEqual(await assistant.prepareInsuredForm(context(), context().identity, undefined, true),
      { kind: "waiting_for_manual_data", fieldCode: "PORTAL_ACTION_REVIEW" });
    assert.equal(await page.locator("#start-dialog").isVisible(), false);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
