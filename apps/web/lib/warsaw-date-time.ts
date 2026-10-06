const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

type WallClockParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsAt(timestamp: number): WallClockParts {
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
  };
}

function wallClockEpoch(parts: WallClockParts): number {
  const normalized = new Date(0);
  normalized.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  normalized.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return normalized.getTime();
}

function sameMinute(a: WallClockParts, b: WallClockParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute && a.second === 0;
}

export function formatWarsawDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const { year, month, day, hour, minute } = partsAt(timestamp);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function warsawDateTimeCandidates(value: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return [];
  const wall: WallClockParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: 0,
  };
  const target = wallClockEpoch(wall);
  const normalized = new Date(target);
  if (normalized.getUTCFullYear() !== wall.year || normalized.getUTCMonth() + 1 !== wall.month
    || normalized.getUTCDate() !== wall.day || normalized.getUTCHours() !== wall.hour
    || normalized.getUTCMinutes() !== wall.minute) return [];

  const offsets = new Set<number>();
  const sixHours = 6 * 60 * 60 * 1000;
  for (let delta = -48 * 60 * 60 * 1000; delta <= 48 * 60 * 60 * 1000; delta += sixHours) {
    const instant = target + delta;
    offsets.add(wallClockEpoch(partsAt(instant)) - instant);
  }

  return [...new Set([...offsets]
    .map((offset) => target - offset)
    .filter((candidate) => sameMinute(partsAt(candidate), wall)))]
    .sort((a, b) => a - b)
    .map((candidate) => new Date(candidate).toISOString());
}

export function warsawUtcOffsetLabel(iso: string): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso)).find((part) => part.type === "timeZoneName")?.value ?? "UTC";
}
