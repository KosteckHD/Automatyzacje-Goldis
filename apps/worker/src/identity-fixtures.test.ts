import { test } from "node:test";
import assert from "node:assert/strict";
import { SyntheticEverestProvider, type SyntheticEverestScenario } from "./identity-fixtures";
import type { WorkerRunContext } from "./ports";

function context(scenario: SyntheticEverestScenario): WorkerRunContext {
  return {
    run: {
      schemaVersion: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      sourceRowId: "22222222-2222-4222-8222-222222222222",
      batchId: "33333333-3333-4333-8333-333333333333",
      referenceDate: "2026-09-29",
      toolId: "oc-policy-verification",
    },
    source: {
      id: "22222222-2222-4222-8222-222222222222",
      rowNumber: 18001,
      companyName: "Fikcyjna Firma Testowa",
      decisionMakerName: scenario === "multiple_people" ? null : "Ala Testowa",
      nipRaw: "0000000000",
      address: "ul. Testowa 1",
      postalCode: "00-000",
      city: "Miasto Testowe",
      regonRaw: "012345678",
      regon: "012345678",
      effectiveRegon: "012345678",
      issues: [],
    },
    status: "everest_search",
    cancelRequested: false,
    identity: null,
  };
}

test("Everest fake resolves one business to a versioned identity contract", async () => {
  const result = await new SyntheticEverestProvider("one_business").findIdentity(context("one_business"));
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") return;
  assert.equal(result.identity.regon, "012345678");
  assert.equal(result.identity.matchMethod, "regon_company_name_decision_maker");
  assert.equal(result.identity.pesel, "90010100016");
});

test("Everest fake ignores a person-only row beside the matching business", async () => {
  const result = await new SyntheticEverestProvider("person_and_business").findIdentity(context("person_and_business"));
  assert.equal(result.kind, "matched");
});

test("Everest fake distinguishes no result, ambiguous people, and a missing PESEL", async () => {
  assert.deepEqual(await new SyntheticEverestProvider("no_result").findIdentity(context("no_result")), { kind: "not_found" });
  assert.deepEqual(await new SyntheticEverestProvider("multiple_people").findIdentity(context("multiple_people")), {
    kind: "ambiguous",
    candidateCount: 2,
  });
  assert.deepEqual(await new SyntheticEverestProvider("missing_pesel").findIdentity(context("missing_pesel")), {
    kind: "identity_review",
    reason: "missing_pesel",
    candidateCount: 1,
  });
});
