import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOcSnapshotV1, type IdentityMatchV1 } from "@goldis/core";
import { SyntheticPolicyProvider, type SyntheticUfgScenario } from "./oc-fixtures";
import type { WorkerRunContext } from "./ports";

const context: WorkerRunContext = {
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
    decisionMakerName: "Ala Testowa",
    nipRaw: "0000000000",
    address: "ul. Testowa 1",
    postalCode: "00-000",
    city: "Miasto Testowe",
    regonRaw: "012345678",
    regon: "012345678",
    effectiveRegon: "012345678",
    issues: [],
  },
  status: "reading_oc",
  cancelRequested: false,
  identity: null,
};

const identity: IdentityMatchV1 = {
  schemaVersion: 1,
  sourceRowId: context.source.id,
  regon: "012345678",
  companyName: "Fikcyjna Firma Testowa",
  firstName: "Ala",
  lastName: "Testowa",
  pesel: "90010100016",
  matchMethod: "regon_company_name_decision_maker",
  adapterVersion: "synthetic-everest-v1",
};

async function lookup(scenario: SyntheticUfgScenario) {
  return new SyntheticPolicyProvider(scenario).verifyAndReadOc(context, identity);
}

test("syntetyczne snapshoty OC spełniają wspólny kontrakt dla 0, 1 i wielu polis", async () => {
  for (const [scenario, expectedCount] of [["zero_policies", 0], ["one_policy", 1], ["many_policies", 3]] as const) {
    const result = await lookup(scenario);
    assert.equal(result.kind, "snapshot", scenario);
    if (result.kind !== "snapshot") continue;
    assert.equal(validateOcSnapshotV1(result.snapshot).totalCount, expectedCount, scenario);
    assert.equal(result.snapshot.policies.length, expectedCount, scenario);
  }
});

test("puste kolumny opcjonalne są zachowane jako null bez gubienia wymaganej daty i numeru", async () => {
  const result = await lookup("empty_fields");
  assert.equal(result.kind, "snapshot");
  if (result.kind !== "snapshot") return;
  const [policy] = validateOcSnapshotV1(result.snapshot).policies;
  assert.equal(policy.insuredName, null);
  assert.equal(policy.vehicleRegistration, null);
  assert.equal(policy.coverageFrom, null);
  assert.equal(policy.coverageTo, "2027-01-01");
  assert.equal(policy.policyTypeAndNumber, "OC TEST-SPARSE");
});

test("błąd UFG i niekompletna tabela nie zwracają częściowego snapshotu", async () => {
  for (const scenario of ["ufg_error", "incomplete_table"] as const) {
    assert.deepEqual(await lookup(scenario), { kind: "portal_error", errorCode: "UFG_INCOMPLETE" });
  }
});
