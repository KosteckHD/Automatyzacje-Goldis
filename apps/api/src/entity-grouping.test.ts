import assert from "node:assert/strict";
import { test } from "node:test";
import { assessEntityGrouping, CanonicalIdentityCandidate } from "./entity-grouping";

const nip = "0000000000";
const otherNip = "0000000017";
const regon = "012345678";
const companyName = "Fikcyjna Firma Łódź";

function existing(overrides: Partial<CanonicalIdentityCandidate> = {}): CanonicalIdentityCandidate {
  return {
    canonicalEntityId: "entity-a",
    nipNormalized: nip,
    regon,
    businessName: companyName,
    ...overrides,
  };
}

test("T-DUP-01: te same NIP/REGON i dokładnie zgodna nazwa łączą się z jedną encją", () => {
  assert.deepEqual(assessEntityGrouping({
    nipRaw: "00-000-000-00",
    effectiveRegon: regon,
    companyName: " FIKCYJNA   FIRMA-ŁÓDŹ ",
    candidates: [existing()],
  }), {
    outcome: "link_existing", canonicalEntityId: "entity-a", nipNormalized: nip,
    regon, fillMissingNip: false, fillMissingRegon: false,
  });
});

test("T-DUP-02: brakujący identyfikator istniejącej encji można uzupełnić po zgodnym identyfikatorze i nazwie", () => {
  assert.deepEqual(assessEntityGrouping({
    nipRaw: nip,
    effectiveRegon: "00123456789012",
    companyName,
    candidates: [existing({ regon: null })],
  }), {
    outcome: "link_existing", canonicalEntityId: "entity-a", nipNormalized: nip,
    regon: "00123456789012", fillMissingNip: false, fillMissingRegon: true,
  });
});

test("T-DUP-03: ten sam NIP przy innym REGON-ie jest konfliktem", () => {
  const decision = assessEntityGrouping({
    nipRaw: nip,
    effectiveRegon: "987654321",
    companyName,
    candidates: [existing()],
  });
  assert.equal(decision.outcome, "conflict");
  assert.equal(decision.reasonCode, "SAME_NIP_DIFFERENT_REGON");
});

test("T-DUP-04: ten sam REGON przy innym NIP-ie jest konfliktem", () => {
  const decision = assessEntityGrouping({
    nipRaw: otherNip,
    effectiveRegon: regon,
    companyName,
    candidates: [existing()],
  });
  assert.equal(decision.outcome, "conflict");
  assert.equal(decision.reasonCode, "SAME_REGON_DIFFERENT_NIP");
});

test("T-DUP-05: podobna nazwa bez wspólnego identyfikatora nie łączy podmiotów", () => {
  const decision = assessEntityGrouping({
    nipRaw: otherNip,
    effectiveRegon: "987654321",
    companyName: "Fikcyjna Firma Łódź Sp. z o.o.",
    candidates: [existing()],
  });
  assert.equal(decision.outcome, "create_new");
  if (decision.outcome === "create_new") {
    assert.equal(decision.nipNormalized, otherNip);
    assert.equal(decision.regon, "987654321");
  }
});

test("nie scala przy różnicy nazwy albo wielu kanonicznych dopasowaniach", () => {
  const nameConflict = assessEntityGrouping({
    nipRaw: nip, effectiveRegon: regon, companyName: "Inna Firma",
    candidates: [existing()],
  });
  assert.equal(nameConflict.outcome, "conflict");
  assert.equal(nameConflict.reasonCode, "NAME_MISMATCH");

  const multiple = assessEntityGrouping({
    nipRaw: nip, effectiveRegon: regon, companyName,
    candidates: [existing(), existing({ canonicalEntityId: "entity-b" })],
  });
  assert.equal(multiple.outcome, "conflict");
  assert.equal(multiple.reasonCode, "MULTIPLE_CANONICAL_MATCHES");
});

test("wadliwy albo niepełny identyfikator kieruje podmiot do konfliktu", () => {
  const invalidNip = assessEntityGrouping({
    nipRaw: "123", effectiveRegon: regon, companyName, candidates: [],
  });
  assert.equal(invalidNip.outcome, "conflict");
  assert.equal(invalidNip.reasonCode, "INVALID_NIP");

  const missingIdentifiers = assessEntityGrouping({
    nipRaw: "", effectiveRegon: null, companyName, candidates: [],
  });
  assert.equal(missingIdentifiers.outcome, "conflict");
  assert.equal(missingIdentifiers.reasonCode, "IDENTIFIER_MISSING");
});
