import type { IdentityMatchV1 } from "@goldis/core";
import type { IdentityProvider, IdentityLookupResult, WorkerRunContext } from "./ports";
import { resolveEverestIdentity, type EverestCandidate } from "./identity";

export type SyntheticEverestScenario =
  | "no_result"
  | "one_business"
  | "person_and_business"
  | "multiple_people"
  | "missing_pesel";

const COMPANY = "Fikcyjna Firma Testowa";
const PERSON = "Ala Testowa";
const OTHER_PERSON = "Jan Testowy";
const SYNTHETIC_PESEL = "90010100016";

function candidatesFor(scenario: SyntheticEverestScenario): EverestCandidate[] {
  const business: EverestCandidate = {
    kind: "sole_proprietor",
    regon: "012345678",
    companyName: COMPANY,
    personName: PERSON,
    pesel: SYNTHETIC_PESEL,
  };
  switch (scenario) {
    case "no_result":
      return [];
    case "one_business":
      return [business];
    case "person_and_business":
      return [
        { kind: "person", regon: null, companyName: null, personName: PERSON, pesel: SYNTHETIC_PESEL },
        business,
      ];
    case "multiple_people":
      return [business, { ...business, personName: OTHER_PERSON }];
    case "missing_pesel":
      return [{ ...business, pesel: null }];
  }
}

/** Deterministic fake for tests; it never opens a browser or contacts a portal. */
export class SyntheticEverestProvider implements IdentityProvider {
  constructor(private readonly scenario: SyntheticEverestScenario) {}

  async findIdentity(context: WorkerRunContext): Promise<IdentityLookupResult> {
    const candidates = candidatesFor(this.scenario);
    const decisionMakerName = this.scenario === "multiple_people" ? null : context.source.decisionMakerName;
    const resolution = resolveEverestIdentity({
      regon: context.source.effectiveRegon ?? "",
      companyName: context.source.companyName,
      decisionMakerName,
    }, candidates);

    if (resolution.ok) {
      const [firstName, ...lastNameParts] = resolution.personName.split(/\s+/);
      if (!firstName || lastNameParts.length === 0) {
        return { kind: "identity_review", reason: "name_mismatch", candidateCount: 1 };
      }
      const identity: IdentityMatchV1 = {
        schemaVersion: 1,
        sourceRowId: context.source.id,
        regon: context.source.effectiveRegon ?? "",
        companyName: context.source.companyName,
        firstName,
        lastName: lastNameParts.join(" "),
        pesel: resolution.pesel,
        matchMethod: decisionMakerName ? "regon_company_name_decision_maker" : "unique_business_identity",
        adapterVersion: "synthetic-everest-v1",
      };
      return { kind: "matched", identity };
    }

    switch (resolution.code) {
      case "IDENTITY_NOT_FOUND":
        return { kind: "not_found" };
      case "IDENTITY_AMBIGUOUS":
        return { kind: "ambiguous", candidateCount: 2 };
      case "PESEL_INVALID":
        return { kind: "identity_review", reason: "missing_pesel", candidateCount: 1 };
      case "IDENTITY_MISMATCH":
        return { kind: "identity_review", reason: "name_mismatch", candidateCount: candidates.length };
    }
  }
}
