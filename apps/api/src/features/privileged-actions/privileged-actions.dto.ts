import { BadRequestException } from "@nestjs/common";
import { canonicalJsonStringify } from "../results/public";

export type CreatePrivilegedActionInput = Readonly<{
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  currentPassword: string;
  idempotencyKey: string;
}>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Nieprawidłowy zakres potwierdzenia");
  let serialized: string;
  try {
    serialized = canonicalJsonStringify(value);
  } catch {
    throw new BadRequestException("Nieprawidłowy zakres potwierdzenia");
  }
  if (Buffer.byteLength(serialized, "utf8") > 16_384)
    throw new BadRequestException("Zakres potwierdzenia jest za duży");
  return value as Record<string, unknown>;
}

export function parseCreatePrivilegedActionInput(value: unknown): CreatePrivilegedActionInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Nieprawidłowe dane potwierdzenia");
  const body = value as Record<string, unknown>;
  const allowedKeys = new Set(["action", "targetId", "payload", "currentPassword", "idempotencyKey"]);
  if (
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    typeof body.action !== "string" ||
    typeof body.idempotencyKey !== "string" ||
    !uuidPattern.test(body.idempotencyKey) ||
    (body.targetId !== null && (typeof body.targetId !== "string" || body.targetId.length > 180)) ||
    typeof body.currentPassword !== "string" ||
    body.currentPassword.length > 1024 ||
    Buffer.byteLength(body.currentPassword, "utf8") > 4096
  ) {
    throw new BadRequestException("Nieprawidłowe dane potwierdzenia");
  }
  return {
    action: body.action,
    targetId: body.targetId as string | null,
    payload: parsePayload(body.payload),
    currentPassword: body.currentPassword,
    idempotencyKey: body.idempotencyKey as string,
  };
}
