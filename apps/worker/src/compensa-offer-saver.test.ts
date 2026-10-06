import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "./browser";
import { CompensaPortalSession, type CompensaSessionOptions } from "./compensa-session";
import type { CompensaOfferCheckpoint, CompensaOfferCheckpointStore } from "./compensa-offer-checkpoint";
import { CompensaOfferSaver, type CompensaOfferSaverOptions } from "./compensa-offer-saver";

const runId = "11111111-1111-4111-8111-111111111111";
const caseReference = "SYNTH-CASE-1";
const sessionOptions: CompensaSessionOptions = {
  entryUrl: "https://goldis.test/compensa",
  selectors: {
    authenticated: '[data-screen="home"]', loginForm: '[data-screen="login"]', usernameInput: 'input[name="username"]',
    passwordInput: 'input[name="password"]', loginSubmit: '[data-action="login"]', smsChallenge: '[data-screen="sms"]',
    accessDenied: '[data-screen="denied"]',
  },
};

class MemoryCheckpointStore implements CompensaOfferCheckpointStore {
  private reference: string | null = null;
  private step: string | null = null;
  async load(): Promise<CompensaOfferCheckpoint | null> {
    if (this.step === "saved" && this.reference) return { kind: "saved", caseReference: this.reference };
    if (!this.reference) return { kind: "ready" };
    if (this.step === "intent") return { kind: "save_intent", caseReference: this.reference };
    if (this.step === "absent") return { kind: "save_confirmed_absent", caseReference: this.reference };
    return { kind: "ready" };
  }
  async recordDraftReference(_runId: string, reference: string): Promise<boolean> {
    if (this.reference && this.reference !== reference) return false;
    this.reference = reference;
    this.step ??= "draft";
    return true;
  }
  async beginSave(_runId: string, reference: string, _adapterVersion: string): Promise<"started" | "already_saved" | "reconcile_required" | "state_conflict"> {
    if (this.reference !== reference) return "state_conflict";
    if (this.step === "saved") return "already_saved";
    if (this.step === "intent") return "reconcile_required";
    if (this.step !== "draft" && this.step !== "absent") return "state_conflict";
    this.step = "intent";
    return "started";
  }
  async confirmSaveAbsent(_runId: string, reference: string): Promise<boolean> {
    if (this.reference !== reference || this.step !== "intent") return false;
    this.step = "absent";
    return true;
  }
  async recordSaved(_runId: string, reference: string): Promise<boolean> {
    if (this.reference !== reference || !["intent", "absent", "saved"].includes(this.step ?? "")) return false;
    this.step = "saved";
    return true;
  }
}

function saverOptions(store: CompensaOfferCheckpointStore, pageState: () => Promise<boolean>, timeout = 1_000): CompensaOfferSaverOptions {
  return {
    selectors: {
      insuredDataSection: "#insured-data", caseReference: "#offer-reference", saveButton: "#save-insured",
      savedConfirmation: "#saved-confirmation",
    },
    adapterVersion: "compensa-test-v1",
    resultTimeoutMs: timeout,
    lookupSave: async ({ caseReference: expected }) => {
      if (expected !== caseReference) return { kind: "unknown" };
      return await pageState() ? { kind: "saved", caseReference: expected } : { kind: "unknown" };
    },
  };
}

async function openFixture(browser: BrowserSession) {
  const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
  const page = await browser.page("compensa");
  await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto(sessionOptions.entryUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#compensa-communication-tile").click();
  await page.locator("#start-communication").click();
  await page.locator("#insured-data").waitFor({ state: "visible" });
  return page;
}

test("Compensa Save intent zapisuje jedną akcję i retry zwraca already_saved", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-save-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await openFixture(browser);
    const store = new MemoryCheckpointStore();
    const session = new CompensaPortalSession(browser, sessionOptions);
    const saver = new CompensaOfferSaver(browser, session, store, saverOptions(store,
      async () => Boolean(await page.evaluate(() => (window as unknown as { syntheticSaved?: boolean }).syntheticSaved))));

    assert.deepEqual(await saver.saveInsuredData(runId), { kind: "saved", caseReference });
    assert.deepEqual(await saver.saveInsuredData(runId), { kind: "already_saved", caseReference });
    assert.equal(await page.evaluate(() => (window as unknown as { syntheticSaveClickCount?: number }).syntheticSaveClickCount), 1);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Compensa normalizuje odstępy w numerze oferty przed checkpointem", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-reference-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await openFixture(browser);
    await page.locator("#offer-reference").evaluate((element) => { element.textContent = "SYNTH-CASE-1 / 1"; });
    const store = new MemoryCheckpointStore();
    const session = new CompensaPortalSession(browser, sessionOptions);
    const saver = new CompensaOfferSaver(browser, session, store, saverOptions(store, async () => false));
    assert.deepEqual(await saver.saveInsuredData(runId), { kind: "saved", caseReference: "SYNTH-CASE-1/1" });
    assert.deepEqual(await store.load(), { kind: "saved", caseReference: "SYNTH-CASE-1/1" });
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("po niepotwierdzonym timeoutcie Compensa retry najpierw uzgadnia portal i nie klika drugi raz", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-save-timeout-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await openFixture(browser);
    await page.evaluate(() => { (window as unknown as { syntheticHideSaveConfirmation?: boolean }).syntheticHideSaveConfirmation = true; });
    const store = new MemoryCheckpointStore();
    const session = new CompensaPortalSession(browser, sessionOptions);
    const saver = new CompensaOfferSaver(browser, session, store, saverOptions(store,
      async () => Boolean(await page.evaluate(() => (window as unknown as { syntheticSaved?: boolean }).syntheticSaved)), 150));

    assert.deepEqual(await saver.saveInsuredData(runId), { kind: "outcome_uncertain", errorCode: "OFFER_SAVE_UNCONFIRMED" });
    await page.evaluate(() => { (window as unknown as { syntheticHideSaveConfirmation?: boolean }).syntheticHideSaveConfirmation = false; });
    assert.deepEqual(await saver.saveInsuredData(runId), { kind: "saved", caseReference });
    assert.equal(await page.evaluate(() => (window as unknown as { syntheticSaveClickCount?: number }).syntheticSaveClickCount), 1);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("nierozstrzygnięty wynik lookup zatrzymuje run przed drugim kliknięciem Zapisz", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-save-unknown-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await openFixture(browser);
    await page.evaluate(() => { (window as unknown as { syntheticHideSaveConfirmation?: boolean }).syntheticHideSaveConfirmation = true; });
    const store = new MemoryCheckpointStore();
    const session = new CompensaPortalSession(browser, sessionOptions);
    const base = saverOptions(store, async () => false, 150);
    const saver = new CompensaOfferSaver(browser, session, store, base);

    assert.equal((await saver.saveInsuredData(runId)).kind, "outcome_uncertain");
    assert.deepEqual(await saver.saveInsuredData(runId), { kind: "outcome_uncertain", errorCode: "OFFER_SAVE_UNCONFIRMED" });
    assert.equal(await page.evaluate(() => (window as unknown as { syntheticSaveClickCount?: number }).syntheticSaveClickCount), 1);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retry klika ponownie dopiero po autorytatywnym potwierdzeniu braku zapisu dla tej samej sprawy", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-save-absent-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await openFixture(browser);
    await page.evaluate(() => {
      (window as unknown as { syntheticHideSaveConfirmation?: boolean }).syntheticHideSaveConfirmation = true;
      (window as unknown as { syntheticSaveNeverStored?: boolean }).syntheticSaveNeverStored = true;
    });
    const store = new MemoryCheckpointStore();
    const session = new CompensaPortalSession(browser, sessionOptions);
    const saver = new CompensaOfferSaver(browser, session, store, {
      ...saverOptions(store, async () => false, 150),
      lookupSave: async ({ caseReference: expected }) => expected === caseReference
        ? { kind: "absent", authoritative: true } : { kind: "unknown" },
    });

    assert.equal((await saver.saveInsuredData(runId)).kind, "outcome_uncertain");
    await page.evaluate(() => { (window as unknown as { syntheticHideSaveConfirmation?: boolean }).syntheticHideSaveConfirmation = false; });
    assert.deepEqual(await saver.saveInsuredData(runId), { kind: "saved", caseReference });
    assert.equal(await page.evaluate(() => (window as unknown as { syntheticSaveClickCount?: number }).syntheticSaveClickCount), 2);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("anulowanie po trwałym zamiarze, ale przed akcją portalu nie klika Zapisz", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-save-cancel-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const page = await openFixture(browser);
    const controller = new AbortController();
    const store = new class extends MemoryCheckpointStore {
      override async beginSave(id: string, reference: string, version: string) {
        const result = await super.beginSave(id, reference, version);
        controller.abort();
        return result;
      }
    }();
    const session = new CompensaPortalSession(browser, sessionOptions);
    const saver = new CompensaOfferSaver(browser, session, store, saverOptions(store, async () => false));
    assert.deepEqual(await saver.saveInsuredData(runId, controller.signal), { kind: "cancelled" });
    assert.equal(await page.evaluate(() => (window as unknown as { syntheticSaveClickCount?: number }).syntheticSaveClickCount), undefined);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
