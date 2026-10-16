function partsInWarsaw(date: Date) {
  const entries = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(entries.map((part) => [part.type, part.value]));
}

export function dateStringInWarsaw(date: Date): string {
  const parts = partsInWarsaw(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextWarsawMidnight(date: Date): Date {
  const today = partsInWarsaw(date);
  const tomorrowDate = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) + 1));
  const target = {
    year: tomorrowDate.getUTCFullYear(), month: tomorrowDate.getUTCMonth() + 1, day: tomorrowDate.getUTCDate(),
  };
  let guess = Date.UTC(target.year, target.month - 1, target.day);
  for (let pass = 0; pass < 3; pass += 1) {
    const local = partsInWarsaw(new Date(guess));
    const localAsUtc = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day),
      Number(local.hour ?? 0), Number(local.minute ?? 0), Number(local.second ?? 0));
    const offset = localAsUtc - guess;
    const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day);
    guess = targetAsUtc - offset;
  }
  return new Date(guess);
}

export function secondsUntilNextWarsawDay(date: Date): number {
  if (!Number.isFinite(date.getTime())) throw new Error("REGISTRY_BUDGET_DATE_INVALID");
  return Math.max(1, Math.ceil((nextWarsawMidnight(date).getTime() - date.getTime()) / 1000));
}
