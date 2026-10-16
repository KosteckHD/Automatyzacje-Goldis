import { BadRequestException } from "@nestjs/common";

const controlIdempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/;
const maxControlRevision = 9_223_372_036_854_775_807n;

export type RunControlRequest = Readonly<{ expectedRevision: string; idempotencyKey: string }>;

export function validateRunControlRequest(value: unknown): RunControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("Nieprawidłowe polecenie sterowania");
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !["expectedRevision", "idempotencyKey"].includes(key)) ||
    typeof body.expectedRevision !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(body.expectedRevision) ||
    BigInt(body.expectedRevision) > maxControlRevision ||
    typeof body.idempotencyKey !== "string" ||
    !controlIdempotencyPattern.test(body.idempotencyKey)
  ) {
    throw new BadRequestException("Sterowanie wymaga aktualnej rewizji i klucza idempotencji");
  }
  return { expectedRevision: body.expectedRevision, idempotencyKey: body.idempotencyKey };
}
