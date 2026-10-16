import { BadRequestException } from "@nestjs/common";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const correctionReasons = new Set(["SOURCE_DOCUMENT_VERIFIED", "REGISTRY_MATCH_VERIFIED", "DUPLICATE_IMPORT", "OTHER"]);
const conflictReasons = new Set(["IDENTIFIERS_VERIFIED", "SOURCE_DATA_UPDATED", "CANDIDATE_REJECTED"]);

export type CorrectionDecisionRequest = Readonly<{
  decision: "approved" | "rejected";
  expectedRowVersion: number;
  reasonCode: string;
}>;

export type ConflictResolutionRequest = Readonly<
  | {
      action: "link_existing";
      expectedRowVersion: number;
      reasonCode: "IDENTIFIERS_VERIFIED";
      canonicalEntityId: string;
    }
  | { action: "recheck"; expectedRowVersion: number; reasonCode: "SOURCE_DATA_UPDATED" }
  | { action: "reject_link"; expectedRowVersion: number; reasonCode: "CANDIDATE_REJECTED" }
>;

function objectBody(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(message);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in value))) {
    throw new BadRequestException("Dane decyzji zawierają niedozwolone lub brakujące pola");
  }
}

export function parseCorrectionDecisionRequest(value: unknown): CorrectionDecisionRequest {
  const body = objectBody(value, "Nieprawidłowe dane decyzji");
  requireExactKeys(body, ["decision", "expectedRowVersion", "reasonCode"]);
  if (
    (body.decision !== "approved" && body.decision !== "rejected") ||
    !Number.isSafeInteger(body.expectedRowVersion) ||
    Number(body.expectedRowVersion) < 1 ||
    typeof body.reasonCode !== "string" ||
    !correctionReasons.has(body.reasonCode)
  ) {
    throw new BadRequestException("Nieprawidłowa decyzja korekty");
  }
  return {
    decision: body.decision,
    expectedRowVersion: body.expectedRowVersion as number,
    reasonCode: body.reasonCode,
  };
}

export function parseConflictResolutionRequest(value: unknown): ConflictResolutionRequest {
  const body = objectBody(value, "Nieprawidłowe rozstrzygnięcie konfliktu");
  const allowed =
    body.action === "link_existing"
      ? ["action", "expectedRowVersion", "reasonCode", "canonicalEntityId"]
      : ["action", "expectedRowVersion", "reasonCode"];
  requireExactKeys(body, allowed);
  const action = body.action;
  if (
    (action !== "link_existing" && action !== "recheck" && action !== "reject_link") ||
    !Number.isSafeInteger(body.expectedRowVersion) ||
    Number(body.expectedRowVersion) < 1 ||
    typeof body.reasonCode !== "string" ||
    !conflictReasons.has(body.reasonCode) ||
    (action === "link_existing" && (typeof body.canonicalEntityId !== "string" || !UUID.test(body.canonicalEntityId)))
  ) {
    throw new BadRequestException("Nieprawidłowe rozstrzygnięcie konfliktu");
  }
  if (
    (action === "link_existing" && body.reasonCode !== "IDENTIFIERS_VERIFIED") ||
    (action === "recheck" && body.reasonCode !== "SOURCE_DATA_UPDATED") ||
    (action === "reject_link" && body.reasonCode !== "CANDIDATE_REJECTED")
  ) {
    throw new BadRequestException("Kod przyczyny nie pasuje do rodzaju decyzji");
  }
  if (action === "link_existing") {
    return {
      action,
      expectedRowVersion: body.expectedRowVersion as number,
      reasonCode: "IDENTIFIERS_VERIFIED",
      canonicalEntityId: body.canonicalEntityId as string,
    };
  }
  if (action === "recheck") {
    return { action, expectedRowVersion: body.expectedRowVersion as number, reasonCode: "SOURCE_DATA_UPDATED" };
  }
  return { action, expectedRowVersion: body.expectedRowVersion as number, reasonCode: "CANDIDATE_REJECTED" };
}
