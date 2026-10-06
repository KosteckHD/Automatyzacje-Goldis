import { normalizeNip, normalizeRegon } from "@goldis/core";
import type { RegistryProviderResult } from "./registry-provider";

export type RegistryReviewReasonCode =
  | "INPUT_NIP_INVALID"
  | "INPUT_NAME_MISSING"
  | "RESULT_SHAPE_INVALID"
  | "RESULT_NIP_INVALID"
  | "RESULT_NIP_MISMATCH"
  | "RESULT_NAME_INVALID"
  | "RESULT_NAME_MISMATCH"
  | "RESULT_REGON_INVALID";

export type RegistryEnrichmentDecision =
  | Readonly<{ status: "matched"; nipNormalized: string; regon: string; registryName: string }>
  | Readonly<{ status: "not_found"; reasonCode: "NO_RESULTS" }>
  | Readonly<{ status: "ambiguous"; reasonCode: "MULTIPLE_CANDIDATES" | "LOCAL_UNIT"; candidateCount: number }>
  | Readonly<{ status: "manual_review"; reasonCode: RegistryReviewReasonCode; candidateCount: number }>;

export function normalizeBusinessName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.normalize("NFKC").toLocaleLowerCase("pl-PL")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function candidateIsLocal(candidate: Record<string, unknown>): boolean | null {
  if (candidate.isLocalUnit !== undefined && typeof candidate.isLocalUnit !== "boolean") return null;
  if (candidate.unitType !== undefined && typeof candidate.unitType !== "string") return null;
  if (candidate.parentRegon !== undefined && typeof candidate.parentRegon !== "string") return null;
  const unitType = typeof candidate.unitType === "string"
    ? candidate.unitType.normalize("NFKC").toLocaleUpperCase("pl-PL").replace(/[\s-]+/g, "_")
    : "";
  return candidate.isLocalUnit === true
    || unitType === "LOCAL"
    || unitType === "LOCAL_UNIT"
    || unitType === "BRANCH"
    || unitType === "JEDNOSTKA_LOKALNA"
    || (typeof candidate.parentRegon === "string" && candidate.parentRegon.trim().length > 0);
}

/**
 * Classifies provider data without persisting it or changing source/effective
 * REGON. Only one exact identity match can produce a candidate REGON.
 */
export function assessRegistryResult(input: {
  expectedNip: string;
  expectedCompanyName: string;
  result: RegistryProviderResult;
}): RegistryEnrichmentDecision {
  const expectedNip = normalizeNip(input.expectedNip).normalized;
  if (!expectedNip) return { status: "manual_review", reasonCode: "INPUT_NIP_INVALID", candidateCount: 0 };
  const expectedName = normalizeBusinessName(input.expectedCompanyName);
  if (!expectedName) return { status: "manual_review", reasonCode: "INPUT_NAME_MISSING", candidateCount: 0 };

  const candidates: unknown = input.result?.candidates;
  if (!Array.isArray(candidates)) {
    return { status: "manual_review", reasonCode: "RESULT_SHAPE_INVALID", candidateCount: 0 };
  }
  if (candidates.length === 0) return { status: "not_found", reasonCode: "NO_RESULTS" };

  const validated: Array<{ nip: string; regon: string; name: string; isLocal: boolean }> = [];
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "manual_review", reasonCode: "RESULT_SHAPE_INVALID", candidateCount: candidates.length };
    }
    const candidate = value as Record<string, unknown>;
    const nip = typeof candidate.nip === "string" ? normalizeNip(candidate.nip).normalized : null;
    if (!nip) return { status: "manual_review", reasonCode: "RESULT_NIP_INVALID", candidateCount: candidates.length };
    if (nip !== expectedNip) return { status: "manual_review", reasonCode: "RESULT_NIP_MISMATCH", candidateCount: candidates.length };

    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const normalizedName = normalizeBusinessName(name);
    if (!normalizedName) return { status: "manual_review", reasonCode: "RESULT_NAME_INVALID", candidateCount: candidates.length };
    if (normalizedName !== expectedName) {
      return { status: "manual_review", reasonCode: "RESULT_NAME_MISMATCH", candidateCount: candidates.length };
    }

    const regon = typeof candidate.regon === "string" ? normalizeRegon(candidate.regon).normalized : null;
    if (!regon) return { status: "manual_review", reasonCode: "RESULT_REGON_INVALID", candidateCount: candidates.length };

    const isLocal = candidateIsLocal(candidate);
    if (isLocal === null) return { status: "manual_review", reasonCode: "RESULT_SHAPE_INVALID", candidateCount: candidates.length };
    validated.push({ nip, regon, name, isLocal });
  }

  if (validated.length > 1) {
    return { status: "ambiguous", reasonCode: "MULTIPLE_CANDIDATES", candidateCount: validated.length };
  }
  const only = validated[0];
  if (only.isLocal) return { status: "ambiguous", reasonCode: "LOCAL_UNIT", candidateCount: 1 };
  return { status: "matched", nipNormalized: only.nip, regon: only.regon, registryName: only.name };
}
