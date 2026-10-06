import { BadRequestException } from "@nestjs/common";

export type ManualDataField = "address" | "postalCode" | "city" | "countyCode" | "expectedPersonName";
export type ManualDataPatch = Readonly<{ expectedVersion: number; fields: Readonly<Record<ManualDataField, string>>; reason: string }>;

export const fieldForCode: Readonly<Record<string, ManualDataField | undefined>> = {
  ADDRESS: "address", POSTAL_CODE: "postalCode", CITY: "city", COUNTY: "countyCode", EXPECTED_PERSON: "expectedPersonName",
};
export const fieldCodeForField: Readonly<Record<ManualDataField, string>> = {
  address: "ADDRESS", postalCode: "POSTAL_CODE", city: "CITY", countyCode: "COUNTY", expectedPersonName: "EXPECTED_PERSON",
};
const manualFields = new Set<ManualDataField>(Object.keys(fieldCodeForField) as ManualDataField[]);
export const immutableAfterStart = new Set(["compensa_start_intent", "compensa_insured_save_intent", "compensa_insured_save_confirmed_absent", "compensa_insured_data_saved", "ufg_verification_intent"]);

function cleanString(value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== "string") throw new BadRequestException("Wartość poprawki musi być tekstem");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized) || (pattern && !pattern.test(normalized))) {
    throw new BadRequestException("Wartość poprawki ma nieprawidłowy format lub długość");
  }
  return normalized;
}

export function parseManualDataPatch(value: unknown): ManualDataPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Nieprawidłowa poprawka danych");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["expectedVersion", "fields", "reason"].includes(key))
    || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0
    || !body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)
    || typeof body.reason !== "string") throw new BadRequestException("Nieprawidłowa poprawka danych");

  const rawFields = body.fields as Record<string, unknown>;
  const keys = Object.keys(rawFields) as ManualDataField[];
  if (keys.length !== 1 || keys.some((key) => !manualFields.has(key))) {
    throw new BadRequestException("Jedna poprawka może zawierać dokładnie jedno dozwolone pole");
  }
  const key = keys[0];
  const patterns: Partial<Record<ManualDataField, RegExp>> = {
    postalCode: /^\d{2}-\d{3}$/,
    countyCode: /^[A-Za-z0-9._-]{1,80}$/,
    expectedPersonName: /^[\p{L}][\p{L} .'-]{1,149}$/u,
  };
  const limits: Record<ManualDataField, number> = { address: 200, postalCode: 6, city: 100, countyCode: 80, expectedPersonName: 150 };
  const normalized = cleanString(rawFields[key], limits[key], patterns[key]);
  const reason = cleanString(body.reason, 300);
  if (reason.length < 10 || /(?<!\d)\d{11}(?!\d)/.test(reason)) {
    throw new BadRequestException("Powód musi mieć 10–300 znaków i nie może zawierać numeru PESEL");
  }
  return { expectedVersion: Number(body.expectedVersion), fields: { [key]: normalized }, reason } as ManualDataPatch;
}

export function canResumeManualIntervention(input: Readonly<{
  role: string; runStatus: string; fieldCode: string | null; lastSafeStep: string | null; externalCaseRef: string | null;
  manualDataVersion: number; overrideVersion: number | null; fields: Record<string, unknown> | null;
}>): boolean {
  const field = input.fieldCode ? fieldForCode[input.fieldCode] : undefined;
  if (input.role !== "admin" || !field || input.overrideVersion !== input.manualDataVersion
    || !input.fields || typeof input.fields[field] !== "string" || !input.fields[field]?.trim()) return false;
  if (field === "expectedPersonName") {
    return input.runStatus === "identity_review" && !input.lastSafeStep && !input.externalCaseRef;
  }
  if (input.runStatus !== "waiting_for_manual_data" || immutableAfterStart.has(input.lastSafeStep ?? "")) return false;
  if (input.lastSafeStep === "compensa_offer_draft_open") return Boolean(input.externalCaseRef);
  return input.lastSafeStep === null && !input.externalCaseRef;
}
