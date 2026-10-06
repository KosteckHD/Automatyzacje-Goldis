import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPortalRuntimeConfig } from "./portal-runtime-config";

function verifiedFixture() {
  const selector = (key: string) => `[data-fixture="${key}"]`;
  const pzuSession = Object.fromEntries([
    "authenticated", "loginForm", "usernameInput", "passwordInput", "loginSubmit", "smsChallenge",
    "smsCodeInput", "smsCodeSubmit", "accessDenied", "smsFrame", "smsRememberDevice", "smsResendCode",
    "smsCodeRejected", "smsCodeExpired", "postLoginLanding",
  ].map((key) => [key, selector(`pzu-${key}`)]));
  const compensaSession = Object.fromEntries([
    "authenticated", "loginForm", "usernameInput", "passwordInput", "loginSubmit", "smsChallenge",
    "smsCodeInput", "smsCodeSubmit", "accessDenied", "smsFrame", "smsCodeRejected", "smsCodeExpired", "postLoginLanding",
  ].map((key) => [key, selector(`compensa-${key}`)]));
  const fields = Object.fromEntries(["accountType", "personName", "pesel"].map((key) => [key, selector(`everest-${key}`)]));
  const form = Object.fromEntries([
    "communicationTile", "startDialog", "identifierInput", "registrationInput", "startCommunication", "insuredDataSection",
    "roleSelect", "firstNameInput", "lastNameInput", "peselInput", "postalCodeInput", "countyInput", "saveButton",
    "addressInput", "cityInput",
  ].map((key) => [key, selector(`form-${key}`)]));
  return {
    pzu: {
      entryUrl: "https://everest.pzu.pl/pc/PolicyCenter.do", allowedOrigins: ["https://everest.pzu.pl"], adapterVersion: "fixture-v1",
      session: pzuSession,
      everest: {
        searchNavigation: selector("search-nav"), searchInput: selector("search"), resultRows: selector("rows"), noResults: selector("empty"),
        optionalOverlay: { container: selector("ad"), dismissButton: selector("close-ad") }, fields,
      },
    },
    compensa: {
      entryUrl: "https://cportal.compensa.pl/Portal/", allowedOrigins: ["https://cportal.compensa.pl"], registrationNumber: "RST22339",
      adapterVersion: "fixture-v1", parserVersion: "fixture-v1", session: compensaSession, form,
      save: { insuredDataSection: selector("insured"), caseReference: selector("case"), saveButton: selector("save"), savedConfirmation: selector("saved") },
      ufg: { caseReference: selector("case-ref"), verifyUfgButton: selector("verify"), summaryTable: selector("summary"), openUfgSummary: selector("open-summary") },
    },
  };
}

async function inTempConfig(config: unknown, action: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "goldis-portal-config-"));
  const configPath = join(directory, "selectors.json");
  try { await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await action(configPath); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("runtime config accepts explicit selector fixture and typed optional PZU SMS/overlay selectors", async () => {
  await inTempConfig(verifiedFixture(), async (path) => {
    const config = await loadPortalRuntimeConfig(path);
    assert.equal(config.pzu.session.smsRememberDevice, '[data-fixture="pzu-smsRememberDevice"]');
    assert.equal(config.pzu.session.smsResendCode, '[data-fixture="pzu-smsResendCode"]');
    assert.equal(config.pzu.everest.optionalOverlay?.dismissButton, '[data-fixture="close-ad"]');
    assert.equal(config.compensa.registrationNumber, "RST22339");
  });
});

test("runtime config rejects generic SMS submit selectors and unverified placeholders", async () => {
  const generic = verifiedFixture() as ReturnType<typeof verifiedFixture>;
  (generic.pzu.session as Record<string, unknown>).smsCodeSubmit = "button";
  await inTempConfig(generic, async (path) => {
    await assert.rejects(loadPortalRuntimeConfig(path), /PORTAL_CONFIG_AMBIGUOUS_SMS_SUBMIT/);
  });
  const placeholder = verifiedFixture() as ReturnType<typeof verifiedFixture>;
  (placeholder.pzu.session as Record<string, unknown>).smsRememberDevice = "UNVERIFIED_REMEMBER_DEVICE";
  await inTempConfig(placeholder, async (path) => {
    await assert.rejects(loadPortalRuntimeConfig(path), /PORTAL_CONFIG_UNVERIFIED_SELECTOR/);
  });
});
