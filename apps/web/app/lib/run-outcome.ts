export const automationReasonLabels: Record<string, string> = {
  COMPENSA_PAYER_DATA_SKIPPED: "Pominięto — Compensa wymaga dodatkowych danych ubezpieczającego",
  COMPENSA_CUSTOMER_DATA_INCOMPLETE: "Niekompletne dane klienta w Compensie — kod pocztowy lub powiat są zablokowane",
};

export function runOutcomeLabel(status: string, errorCode: string | null | undefined, fallback: string): string {
  if (status === "failed" && errorCode === "COMPENSA_PAYER_DATA_SKIPPED") return "Pominięto";
  if (status === "failed" && errorCode === "COMPENSA_CUSTOMER_DATA_INCOMPLETE") return "Niekompletne dane Compensy";
  return fallback;
}
