import { isValidPesel } from "@goldis/core";

export type EverestCandidate = {
  kind: "person" | "sole_proprietor" | "unknown";
  regon: string | null;
  companyName: string | null;
  personName: string | null;
  pesel: string | null;
};

export type IdentityInput = {
  regon: string;
  companyName: string;
  decisionMakerName: string | null;
};

export type IdentityResolution =
  | { ok: true; personName: string; pesel: string }
  | { ok: false; code: "IDENTITY_NOT_FOUND" | "IDENTITY_AMBIGUOUS" | "IDENTITY_MISMATCH" | "PESEL_INVALID" };

function comparable(value: string | null): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
}

/** Resolve only a confirmed sole proprietorship; never infer identity from a person-only result. */
export function resolveEverestIdentity(input: IdentityInput, candidates: EverestCandidate[]): IdentityResolution {
  const business = candidates.filter((candidate) => candidate.kind === "sole_proprietor" && candidate.regon === input.regon);
  if (business.length === 0) return { ok: false, code: candidates.some((candidate) => candidate.kind === "unknown") ? "IDENTITY_MISMATCH" : "IDENTITY_NOT_FOUND" };
  const matchingCompany = business.filter((candidate) => comparable(candidate.companyName) === comparable(input.companyName));
  if (matchingCompany.length === 0) return { ok: false, code: "IDENTITY_MISMATCH" };
  const matchingPerson = input.decisionMakerName
    ? matchingCompany.filter((candidate) => comparable(candidate.personName) === comparable(input.decisionMakerName))
    : matchingCompany;
  if (matchingPerson.length === 0) return { ok: false, code: "IDENTITY_MISMATCH" };
  if (matchingPerson.length !== 1) return { ok: false, code: "IDENTITY_AMBIGUOUS" };
  const person = matchingPerson[0];
  if (!person.personName?.trim()) return { ok: false, code: "IDENTITY_MISMATCH" };
  if (!isValidPesel(person.pesel)) return { ok: false, code: "PESEL_INVALID" };
  return { ok: true, personName: person.personName.trim(), pesel: person.pesel! };
}
