import { BadRequestException } from "@nestjs/common";
import { strictObject } from "./admin.support";

export type AdminToolSettingsUpdate = Readonly<{
  enabledForNewRuns: boolean;
  maxNewRunsPerHour: number | null;
  allowedLocalStart: string | null;
  allowedLocalEnd: string | null;
  timezone: string;
  expectedVersion: number;
}>;

export function parseAdminToolSettingsUpdate(input: unknown): AdminToolSettingsUpdate {
  const body = strictObject(input, [
    "enabledForNewRuns",
    "maxNewRunsPerHour",
    "allowedLocalStart",
    "allowedLocalEnd",
    "timezone",
    "expectedVersion",
  ]);
  if (
    typeof body.enabledForNewRuns !== "boolean" ||
    !Number.isInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1
  ) {
    throw new BadRequestException("Nieprawidłowa wersja lub stan ustawień");
  }
  const limit = body.maxNewRunsPerHour;
  if (limit !== null && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10000)) {
    throw new BadRequestException("Limit musi być pusty albo liczbą od 1 do 10000");
  }
  const start = body.allowedLocalStart;
  const end = body.allowedLocalEnd;
  const validTime = (value: unknown) =>
    value === null || (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  if (!validTime(start) || !validTime(end) || (start === null) !== (end === null)) {
    throw new BadRequestException("Podaj oba czasy okna pracy w formacie HH:mm albo wyczyść oba");
  }
  if (start !== null && end !== null && start === end) {
    throw new BadRequestException("Godzina końca musi być różna od godziny początku");
  }
  const timezone = body.timezone;
  if (typeof timezone !== "string" || timezone.length > 80) {
    throw new BadRequestException("Nieprawidłowa strefa czasowa");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new BadRequestException("Nieznana strefa czasowa");
  }
  return {
    enabledForNewRuns: body.enabledForNewRuns,
    maxNewRunsPerHour: limit as number | null,
    allowedLocalStart: start as string | null,
    allowedLocalEnd: end as string | null,
    timezone,
    expectedVersion: Number(body.expectedVersion),
  };
}
