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
