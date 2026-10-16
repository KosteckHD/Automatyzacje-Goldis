import { BadRequestException } from "@nestjs/common";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,120}$/;

export type StartPreparationRequest = Readonly<{ idempotencyKey: string }>;
export type CancelPreparationRequest = Readonly<{ expectedVersion: number }>;

export function parseStartPreparationRequest(value: unknown): StartPreparationRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "idempotencyKey") ||
    typeof (value as { idempotencyKey?: unknown }).idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY.test((value as { idempotencyKey: string }).idempotencyKey)
  ) {
    throw new BadRequestException("Podaj poprawny klucz idempotencji przygotowania");
  }
  return { idempotencyKey: (value as { idempotencyKey: string }).idempotencyKey };
}

export function parseCancelPreparationRequest(value: unknown): CancelPreparationRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "expectedVersion") ||
    !Number.isSafeInteger((value as { expectedVersion?: unknown }).expectedVersion) ||
    Number((value as { expectedVersion: number }).expectedVersion) < 1
  ) {
    throw new BadRequestException("Podaj poprawną wersję przygotowania");
  }
  return { expectedVersion: (value as { expectedVersion: number }).expectedVersion };
}
