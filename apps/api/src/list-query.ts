import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

export const defaultListLimit = 50;
export const maximumListLimit = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toolIdPattern = /^[a-z0-9][a-z0-9-]{1,79}$/;
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

export type ListCursor = Readonly<{ createdAt: string; id: string }>;

export function parseListLimit(value: string | undefined): number {
  if (value === undefined) return defaultListLimit;
  if (!/^\d{1,3}$/.test(value)) throw new BadRequestException("Nieprawidłowy limit listy");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumListLimit) {
    throw new BadRequestException("Limit listy musi mieścić się w zakresie 1–100");
  }
  return limit;
}

export function parseToolId(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!toolIdPattern.test(value)) throw new BadRequestException("Nieprawidłowy identyfikator narzędzia");
  return value;
}

export function parseUuidFilter(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!uuidPattern.test(value)) throw new BadRequestException(`Nieprawidłowy filtr: ${label}`);
  return value.toLowerCase();
}

export function parseIsoDateTime(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!isoDateTimePattern.test(value) || !match) {
    throw new BadRequestException(`Filtr ${label} musi być datą ISO 8601 ze strefą czasową`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const parts = { year: Number(yearText), month: Number(monthText), day: Number(dayText), hour: Number(hourText), minute: Number(minuteText), second: Number(secondText) };
  const calendar = new Date(0);
  calendar.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  calendar.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  const calendarValid = calendar.getUTCFullYear() === parts.year && calendar.getUTCMonth() + 1 === parts.month
    && calendar.getUTCDate() === parts.day && parts.hour <= 23 && parts.minute <= 59 && parts.second <= 59;
  const offsetValid = !offsetHourText || (Number(offsetHourText) <= 14 && Number(offsetMinuteText) <= 59
    && (Number(offsetHourText) < 14 || Number(offsetMinuteText) === 0));
  if (!calendarValid || !offsetValid || !Number.isFinite(Date.parse(value))) {
    throw new BadRequestException(`Filtr ${label} musi być prawidłową datą ISO 8601 ze strefą czasową`);
  }
  return new Date(value).toISOString();
}

export function validateDateRange(from: string | undefined, to: string | undefined): void {
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw new BadRequestException("Początek zakresu nie może być późniejszy niż koniec");
  }
}

export function filterFingerprint(listName: string, filters: Readonly<Record<string, string | number | undefined>>): string {
  const canonical = Object.fromEntries(Object.entries(filters).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify({ v: 1, listName, filters: canonical })).digest("hex");
}

export function parseListCursor(value: string | undefined, fingerprint: string): ListCursor | null {
  if (value === undefined || value === "") return null;
  if (value.length > 2048) throw new BadRequestException("Nieprawidłowy kursor listy");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !== "f,i,t,v") throw new Error("invalid cursor shape");
    if (parsed.v !== 1 || parsed.f !== fingerprint || typeof parsed.t !== "string" || typeof parsed.i !== "string"
      || !isoDateTimePattern.test(parsed.t) || !Number.isFinite(Date.parse(parsed.t)) || !uuidPattern.test(parsed.i)) {
      throw new Error("invalid cursor");
    }
    return { createdAt: new Date(parsed.t).toISOString(), id: parsed.i.toLowerCase() };
  } catch {
    throw new BadRequestException("Kursor listy jest nieprawidłowy lub dotyczy innych filtrów");
  }
}

export function createListCursor(createdAt: Date | string, id: string, fingerprint: string): string {
  const timestamp = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  const payload = Buffer.from(JSON.stringify({ v: 1, t: timestamp, i: id, f: fingerprint })).toString("base64url");
  return payload;
}
