import { BadRequestException } from "@nestjs/common";

export type RegonCorrectionRequest = Readonly<{
  proposedRegon: string;
  reason: string;
  expectedVersion: number;
}>;

const correctionKeys = new Set(["proposedRegon", "reason", "expectedVersion"]);

export function parseRegonCorrectionRequest(value: unknown): RegonCorrectionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("Brak danych korekty");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !correctionKeys.has(key))) {
    throw new BadRequestException("Nieprawidłowe dane korekty");
  }
  if (typeof input.proposedRegon !== "string") throw new BadRequestException("REGON musi być tekstem");
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 1000) {
    throw new BadRequestException("Powód korekty musi mieć od 3 do 1000 znaków");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new BadRequestException("Nieprawidłowy import, numer wiersza lub wersja danych");
  }
  return {
    proposedRegon: input.proposedRegon,
    reason: input.reason,
    expectedVersion: input.expectedVersion as number,
  };
}
