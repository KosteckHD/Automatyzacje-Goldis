import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BrowserSession } from "./browser";
import { CompensaPortalSession, type CompensaSessionOptions } from "./compensa-session";
import { CompensaUfgReader, type CompensaUfgOptions } from "./compensa-ufg";
import { selectCurrentPolicies } from "./oc";

const sessionOptions: CompensaSessionOptions = {
  entryUrl: "https://goldis.test/compensa",
  selectors: {
    authenticated: '[data-screen="home"]', loginForm: '[data-screen="login"]', usernameInput: 'input[name="username"]',
    passwordInput: 'input[name="password"]', loginSubmit: '[data-action="login"]', smsChallenge: '[data-screen="sms"]',
    accessDenied: '[data-screen="denied"]',
  },
};

function ufgOptions(authorizeVerification: CompensaUfgOptions["authorizeVerification"]): CompensaUfgOptions {
  return {
    selectors: { caseReference: "#offer-reference", verifyUfgButton: "#verify-ufg", summaryTable: "#ufg-summary", openUfgSummary: "#open-ufg-summary" },
    parserVersion: "compensa-ufg-fixture-v1",
    authorizeVerification,
  };
}

async function startSyntheticCase(page: Awaited<ReturnType<BrowserSession["page"]>>, html: string) {
  await page.route("https://goldis.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto(sessionOptions.entryUrl);
  await page.getByRole("button", { name: "Compensa Komunikacja", exact: true }).click();
  await page.locator('input[name="insuredIdentifier"]').fill("90010100016");
  await page.locator('input[name="vehicleRegistration"]').fill("RST22339");
  await page.locator("#start-communication").click();
}

test("UFG weryfikuje raz, zbiera pełny snapshot i filtr daty pozostawia osobnym krokiem", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-ufg-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await startSyntheticCase(page, html);
    const session = new CompensaPortalSession(browser, sessionOptions);
    let authorized = 0;
    const reader = new CompensaUfgReader(browser, session, ufgOptions(async (input) => {
      authorized += 1;
      assert.equal(input.runId, "11111111-1111-4111-8111-111111111111");
      assert.equal(input.caseReference, "SYNTH-CASE-1");
      return true;
    }), () => new Date("2026-09-30T10:00:00.000Z"));

    const result = await reader.readSnapshot("11111111-1111-4111-8111-111111111111", "SYNTH-CASE-1");
    assert.equal(result.kind, "snapshot");
    if (result.kind !== "snapshot") return;
    assert.equal(result.snapshot.totalCount, 3);
    assert.equal(result.snapshot.policies.length, 3);
    assert.deepEqual(selectCurrentPolicies(result.snapshot.policies, "2026-09-30").map((policy) => policy.sourceOrdinal), [2, 3]);
    assert.equal(authorized, 1);
    assert.equal(await page.evaluate(() => Number((window as unknown as { syntheticVerifyCount?: number }).syntheticVerifyCount ?? 0)), 1);

    const secondRead = await reader.readSnapshot("11111111-1111-4111-8111-111111111111", "SYNTH-CASE-1");
    assert.equal(secondRead.kind, "snapshot");
    assert.equal(authorized, 1, "widoczne podsumowanie zapobiega ponownej weryfikacji");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("UFG wymaga zatwierdzenia niepewnej weryfikacji, właściwego case i pełnej liczby rekordów", {
  skip: process.env.PLAYWRIGHT_INTEGRATION !== "1",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-compensa-ufg-guard-"));
  const browser = new BrowserSession({ profileDirectory: directory });
  try {
    const html = await readFile(resolve(process.cwd(), "test-fixtures", "compensa-portal.html"), "utf8");
    const page = await browser.page("compensa");
    await startSyntheticCase(page, html);
    const session = new CompensaPortalSession(browser, sessionOptions);
    let calls = 0;
    const blockedReader = new CompensaUfgReader(browser, session, ufgOptions(async () => { calls += 1; return false; }));
    assert.deepEqual(await blockedReader.readSnapshot("11111111-1111-4111-8111-111111111111", "SYNTH-CASE-1"), {
      kind: "waiting_for_manual_data", fieldCode: "UFG_ACTION_REVIEW",
    });
    assert.deepEqual(await blockedReader.readSnapshot("11111111-1111-4111-8111-111111111111", "OTHER-CASE"), {
      kind: "waiting_for_manual_data", fieldCode: "CASE_REFERENCE_REVIEW",
    });
    assert.equal(calls, 1);
    assert.equal(await page.locator("#ufg-details").isVisible(), false, "brak zgody na działanie nie uruchamia UFG");

    await page.locator("#ufg-summary tbody tr:first-child td:nth-child(2)").evaluate((cell) => { cell.textContent = "4"; });
    const mismatchReader = new CompensaUfgReader(browser, session, ufgOptions(async () => true));
    assert.deepEqual(await mismatchReader.readSnapshot("11111111-1111-4111-8111-111111111111", "SYNTH-CASE-1"), {
      kind: "portal_error", errorCode: "UFG_INCOMPLETE",
    });
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
