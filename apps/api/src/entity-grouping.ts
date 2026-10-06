import { normalizeNip, normalizeRegon } from "@goldis/core";
import { normalizeBusinessName } from "./registry-result";

export type CanonicalIdentityCandidate = Readonly<{
  canonicalEntityId: string;
  nipNormalized: string | null;
  regon: string | null;
  businessName: string;
}>;

export type EntityGroupingConflictCode =
  | "INVALID_NIP"
  | "INVALID_REGON"
  | "IDENTIFIER_MISSING"
  | "SOURCE_NAME_MISSING"
  | "CANONICAL_IDENTITY_INVALID"
  | "SAME_NIP_DIFFERENT_REGON"
  | "SAME_REGON_DIFFERENT_NIP"
  | "NAME_MISMATCH"
  | "MULTIPLE_CANONICAL_MATCHES";

export type EntityGroupingDecision =
  | Readonly<{ outcome: "create_new"; nipNormalized: string | null; regon: string | null; businessName: string }>
  | Readonly<{
      outcome: "link_existing";
      canonicalEntityId: string;
      nipNormalized: string | null;
      regon: string | null;
      fillMissingNip: boolean;
      fillMissingRegon: boolean;
    }>
  | Readonly<{ outcome: "conflict"; reasonCode: EntityGroupingConflictCode; candidateEntityIds: readonly string[] }>;

function validateCandidate(candidate: CanonicalIdentityCandidate): {
  nipNormalized: string | null;
  regon: string | null;
  normalizedName: string;
} | null {
  if (!candidate || typeof candidate.canonicalEntityId !== "string" || !candidate.canonicalEntityId
    || typeof candidate.businessName !== "string") return null;
  const nip = candidate.nipNormalized === null ? null : normalizeNip(candidate.nipNormalized).normalized;
  const regon = candidate.regon === null ? null : normalizeRegon(candidate.regon).normalized;
  const normalizedName = normalizeBusinessName(candidate.businessName);
  if ((candidate.nipNormalized !== null && !nip)
    || (candidate.regon !== null && !regon)
    || (!nip && !regon)
    || !normalizedName) return null;
  return { nipNormalized: nip, regon, normalizedName };
}

/** Matches only shared identifiers and a strictly normalized exact business name. */
export function assessEntityGrouping(input: {
  nipRaw: string;
  effectiveRegon: string | null;
  companyName: string;
  candidates: readonly CanonicalIdentityCandidate[];
}): EntityGroupingDecision {
  const nipNormalized = input.nipRaw.trim() ? normalizeNip(input.nipRaw).normalized : null;
  if (input.nipRaw.trim() && !nipNormalized) {
    return { outcome: "conflict", reasonCode: "INVALID_NIP", candidateEntityIds: [] };
  }
  const regon = input.effectiveRegon?.trim() ? normalizeRegon(input.effectiveRegon).normalized : null;
  if (input.effectiveRegon?.trim() && !regon) {
    return { outcome: "conflict", reasonCode: "INVALID_REGON", candidateEntityIds: [] };
  }
  if (!nipNormalized && !regon) {
    return { outcome: "conflict", reasonCode: "IDENTIFIER_MISSING", candidateEntityIds: [] };
  }
  const normalizedName = normalizeBusinessName(input.companyName);
  if (!normalizedName) {
    return { outcome: "conflict", reasonCode: "SOURCE_NAME_MISSING", candidateEntityIds: [] };
  }

  const matching: Array<{ candidate: CanonicalIdentityCandidate; nip: string | null; regon: string | null }> = [];
  for (const candidate of input.candidates) {
    const identity = validateCandidate(candidate);
    if (!identity) {
      return { outcome: "conflict", reasonCode: "CANONICAL_IDENTITY_INVALID", candidateEntityIds: [candidate?.canonicalEntityId].filter(Boolean) };
    }
    const sharesNip = nipNormalized !== null && identity.nipNormalized === nipNormalized;
    const sharesRegon = regon !== null && identity.regon === regon;
    if (sharesNip && regon && identity.regon && regon !== identity.regon) {
      return { outcome: "conflict", reasonCode: "SAME_NIP_DIFFERENT_REGON", candidateEntityIds: [candidate.canonicalEntityId] };
    }
    if (sharesRegon && nipNormalized && identity.nipNormalized && nipNormalized !== identity.nipNormalized) {
      return { outcome: "conflict", reasonCode: "SAME_REGON_DIFFERENT_NIP", candidateEntityIds: [candidate.canonicalEntityId] };
    }
    if (!sharesNip && !sharesRegon) continue;
    if (identity.normalizedName !== normalizedName) {
      return { outcome: "conflict", reasonCode: "NAME_MISMATCH", candidateEntityIds: [candidate.canonicalEntityId] };
    }
    matching.push({ candidate, nip: identity.nipNormalized, regon: identity.regon });
  }

  if (matching.length > 1) {
    return {
      outcome: "conflict",
      reasonCode: "MULTIPLE_CANONICAL_MATCHES",
      candidateEntityIds: matching.map(({ candidate }) => candidate.canonicalEntityId),
    };
  }
  if (matching.length === 0) return { outcome: "create_new", nipNormalized, regon, businessName: input.companyName.trim() };

  const match = matching[0];
  return {
    outcome: "link_existing",
    canonicalEntityId: match.candidate.canonicalEntityId,
    nipNormalized: nipNormalized ?? match.nip,
    regon: regon ?? match.regon,
    fillMissingNip: match.nip === null && nipNormalized !== null,
    fillMissingRegon: match.regon === null && regon !== null,
  };
}
