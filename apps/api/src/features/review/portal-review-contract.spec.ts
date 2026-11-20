import assert from "node:assert/strict";
import { test } from "node:test";
import { canRecheckPortalIntervention } from "./portal-review-contract";

const base = {
  role: "admin",
  runStatus: "waiting_for_manual_data",
  portal: "compensa",
  kind: "portal_error",
  reasonCode: "OFFER_SAVE_UNCONFIRMED",
  fieldCode: "OFFER_SAVE_REVIEW",
  lastSafeStep: "compensa_insured_save_intent",
  externalCaseRef: "SYNTH-1",
};

test("ponowne sprawdzenie wymaga zapisanej sprawy i zachowuje bariery wznowienia", () => {
  for (const role of ["admin", "manager"]) assert.equal(canRecheckPortalIntervention({ ...base, role }), true);
  for (const patch of [
    { role: "operator" },
    { runStatus: "compensa_form" },
    { portal: "pzu" },
    { kind: "sms" },
    { reasonCode: "IDENTITY_AMBIGUOUS" },
    { fieldCode: "CASE_REFERENCE_REVIEW" },
    { fieldCode: "COUNTY" },
    { fieldCode: "EXPECTED_PERSON" },
    { lastSafeStep: null },
    { externalCaseRef: null },
    { externalCaseRef: "  " },
    { lastSafeStep: "unknown_step" },
  ])
    assert.equal(canRecheckPortalIntervention({ ...base, ...patch }), false, JSON.stringify(patch));
});

test("po próbie rozpoczęcia można tylko zlecić sprawdzenie istniejącego formularza", () => {
  assert.equal(
    canRecheckPortalIntervention({
      ...base,
      lastSafeStep: "compensa_start_intent",
      fieldCode: "PORTAL_ACTION_REVIEW",
      reasonCode: "MANUAL_DATA_REQUIRED",
    }),
    true,
  );
  assert.equal(
    canRecheckPortalIntervention({
      ...base,
      lastSafeStep: "compensa_start_intent",
      fieldCode: "PORTAL_ACTION_REVIEW",
      reasonCode: "MANUAL_DATA_REQUIRED",
      externalCaseRef: null,
    }),
    false,
  );
  assert.equal(
    canRecheckPortalIntervention({ ...base, lastSafeStep: "compensa_start_intent", externalCaseRef: null }),
    false,
  );
});

test("starsza interwencja zapisu bez fieldCode nadal wymaga checkpointu i numeru sprawy", () => {
  assert.equal(canRecheckPortalIntervention({ ...base, fieldCode: null }), true);
  assert.equal(canRecheckPortalIntervention({ ...base, fieldCode: null, lastSafeStep: null }), false);
});

test("admin PZU session recheck never permits replaying an uncertain code or resuming an external case", () => {
  const pzu = { ...base, portal: "pzu", kind: "sms", reasonCode: "SMS_DELIVERY_UNCERTAIN",
    fieldCode: null, lastSafeStep: null, externalCaseRef: null };
  assert.equal(canRecheckPortalIntervention(pzu), true);
  for (const patch of [
    { role: "operator" }, { role: "auditor" }, { runStatus: "waiting_for_sms" },
    { reasonCode: "SMS_CODE_REJECTED" }, { reasonCode: "SMS_TIMEOUT" },
    { kind: "portal_error" }, { fieldCode: "EXPECTED_PERSON" },
    { lastSafeStep: "compensa_start_intent" }, { externalCaseRef: "SYNTH-CASE" },
  ]) assert.equal(canRecheckPortalIntervention({ ...pzu, ...patch }), false, JSON.stringify(patch));
});

test("technical failure recheck restarts only before an external case and only for administrative roles", () => {
  const failure = { ...base, portal: null, kind: "portal_error", reasonCode: "PORTAL_FAILURE",
    fieldCode: null, lastSafeStep: null, externalCaseRef: null };
  assert.equal(canRecheckPortalIntervention(failure), true);
  for (const patch of [{ role: "operator" }, { lastSafeStep: "compensa_start_intent" },
    { externalCaseRef: "SYNTH-CASE" }, { reasonCode: "OFFER_SAVE_UNCONFIRMED" }, { kind: "sms" }]) {
    assert.equal(canRecheckPortalIntervention({ ...failure, ...patch }), false);
  }
});

test("a reviewed PZU portal failure can retry entry only before an external case", () => {
  const failure = { ...base, portal: "pzu", kind: "portal_error",
    fieldCode: null, lastSafeStep: null, externalCaseRef: null };
  for (const reasonCode of ["PORTAL_FAILURE", "PORTAL_SESSION_EXPIRED", "PORTAL_SCHEMA_CHANGED"]) {
    for (const role of ["admin", "manager"]) {
      assert.equal(canRecheckPortalIntervention({ ...failure, reasonCode, role }), true);
    }
    for (const patch of [{ role: "operator" }, { runStatus: "pzu_login" }, { fieldCode: "EXPECTED_PERSON" },
      { lastSafeStep: "compensa_start_intent" }, { externalCaseRef: "CASE/1" }]) {
      assert.equal(canRecheckPortalIntervention({ ...failure, reasonCode, ...patch }), false);
    }
  }
});
