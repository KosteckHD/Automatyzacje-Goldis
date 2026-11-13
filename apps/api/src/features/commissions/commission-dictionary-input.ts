import { BadRequestException } from "@nestjs/common";

const allowedAgents = new Set(["Ola", "Maciek"]);
const allowedStatuses = new Set([
  "RATE", "MISSING", "NO_COMMISSION", "NOT_OFFERED", "UNKNOWN_CODE", "NO_DEFINED_RATE", "INDIVIDUAL",
]);

export type EditDictionaryEntryInput = Readonly<{
  revision: number;
  agent: "Ola" | "Maciek";
  status: string;
  rate?: number | null;
}>;

export function parseEditDictionaryEntryInput(value: unknown): EditDictionaryEntryInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("INVALID_DICTIONARY_ENTRY");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new BadRequestException("INVALID_DICTIONARY_ENTRY");
  const body = value as Record<string, unknown>;
  if (Reflect.ownKeys(body).some((key) => typeof key !== "string" || !["revision", "agent", "status", "rate"].includes(key)))
    throw new BadRequestException("INVALID_DICTIONARY_ENTRY");
  if (!Object.hasOwn(body, "revision") || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1)
    throw new BadRequestException("INVALID_DICTIONARY_ENTRY");
  if (!Object.hasOwn(body, "agent") || typeof body.agent !== "string" || !allowedAgents.has(body.agent))
    throw new BadRequestException("INVALID_DICTIONARY_ENTRY");
  if (!Object.hasOwn(body, "status") || typeof body.status !== "string" || !allowedStatuses.has(body.status))
    throw new BadRequestException("INVALID_DICTIONARY_ENTRY");
  if (body.status === "RATE") {
    if (typeof body.rate !== "number" || !Number.isFinite(body.rate) || body.rate < 0 || body.rate > 100)
      throw new BadRequestException("INVALID_COMMISSION_RATE");
  } else if (body.rate !== undefined && body.rate !== null) {
    throw new BadRequestException("INVALID_DICTIONARY_ENTRY");
  }
  return {
    revision: Number(body.revision),
    agent: body.agent as "Ola" | "Maciek",
    status: body.status,
    ...(body.rate === undefined ? {} : { rate: body.rate as number | null }),
  };
}
