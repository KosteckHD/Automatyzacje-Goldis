export const uiLabels = {
  overview: "Przegląd",
  myCompanies: "Moje firmy",
  companyPool: "Pula firm",
  automations: "Automatyzacje",
  ocVerification: "Sprawdzanie OC",
  runs: "Zadania firmowe",
  importHistory: "Historia importów",
  notifications: "Powiadomienia",
  activityLog: "Dziennik aktywności",
  account: "Moje konto",
} as const;

export function polishCount(value: number, one: string, few: string, many: string): string {
  const count = Math.abs(Math.trunc(value));
  const remainder10 = count % 10;
  const remainder100 = count % 100;
  const form = count === 1 ? one : remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14) ? few : many;
  return `${new Intl.NumberFormat("pl-PL").format(value)} ${form}`;
}
