import assert from "node:assert/strict";
import { test } from "node:test";
import { canResumeManualIntervention, parseManualDataPatch } from "./manual-data-contract";

test("manual data patch accepts one versioned allowlisted correction without returning source fields", () => {
  assert.deepEqual(parseManualDataPatch({
    expectedVersion: 2, fields: { postalCode: " 12-345 " }, reason: "Uzupełnienie brakującego kodu",
  }), {
    expectedVersion: 2, fields: { postalCode: "12-345" }, reason: "Uzupełnienie brakującego kodu",
  });
  assert.deepEqual(parseManualDataPatch({
    expectedVersion: 0, fields: { countyCode: "county_01" }, reason: "Wskazanie dokładnej opcji z listy",
  }).fields, { countyCode: "county_01" });
});

test("manual data patch rejects stale shape, invalid Polish postal code, guessed county text and PII in reason", () => {
  for (const body of [
    { expectedVersion: -1, fields: { address: "ul. Testowa 1" }, reason: "Zmiana adresu z dokumentu" },
    { expectedVersion: 0, fields: { postalCode: "12345" }, reason: "Uzupełnienie kodu pocztowego" },
    { expectedVersion: 0, fields: { countyCode: "Powiat testowy" }, reason: "Uzupełnienie wartości powiatu" },
    { expectedVersion: 0, fields: { address: "ul. Testowa 1", city: "Testowo" }, reason: "Uzupełnienie adresu i miasta" },
    { expectedVersion: 0, fields: { address: "ul. Testowa 1" }, reason: "PESEL 12345678901" },
    { expectedVersion: 0, fields: { pesel: "12345678901" }, reason: "Wpisanie osoby klienta" },
  ]) assert.throws(() => parseManualDataPatch(body));
});

const resolvable = {
  role: "admin", runStatus: "waiting_for_manual_data", fieldCode: "COUNTY", lastSafeStep: "compensa_offer_draft_open",
  externalCaseRef: "SYNTH-CASE-1", manualDataVersion: 1, overrideVersion: 1, fields: { countyCode: "COUNTY-01" },
} as const;

test("manual resume needs the current matching correction and the exact same pre-save offer", () => {
  assert.equal(canResumeManualIntervention(resolvable), true);
  assert.equal(canResumeManualIntervention({ ...resolvable, role: "reviewer" }), false);
  assert.equal(canResumeManualIntervention({ ...resolvable, overrideVersion: 0 }), false);
  assert.equal(canResumeManualIntervention({ ...resolvable, fields: { postalCode: "12-345" } }), false);
  assert.equal(canResumeManualIntervention({ ...resolvable, lastSafeStep: "compensa_insured_save_intent" }), false);
  assert.equal(canResumeManualIntervention({ ...resolvable, externalCaseRef: null }), false);
  assert.equal(canResumeManualIntervention({ ...resolvable, fieldCode: "CASE_REFERENCE_REVIEW" }), false);
  assert.equal(canResumeManualIntervention({
    ...resolvable, runStatus: "identity_review", fieldCode: "EXPECTED_PERSON", lastSafeStep: null,
    externalCaseRef: null, fields: { expectedPersonName: "Ala Testowa" },
  }), true);
  assert.equal(canResumeManualIntervention({
    ...resolvable, runStatus: "identity_review", fieldCode: "EXPECTED_PERSON", lastSafeStep: "compensa_start_intent",
    externalCaseRef: "SYNTH-CASE-1", fields: { expectedPersonName: "Ala Testowa" },
  }), false);
});
