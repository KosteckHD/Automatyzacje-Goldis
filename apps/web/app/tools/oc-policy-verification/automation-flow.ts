import type { AutomationStep } from "./automation-workspace";

export type AutomationStepState = "complete" | "attention" | "upcoming";
export type AutomationPreviewState = {
  kind: "all" | "selected"; readyCount: number; preparationId: string | null;
  revision: number | null; fingerprint: string; referenceDate: string;
} | null;

export type AutomationFlowInput = {
  hasImport: boolean;
  preparation: "missing" | "working" | "ready" | "attention";
  preview: AutomationPreviewState;
  canExecute: boolean;
  health: "ready" | "waiting" | "unknown" | "disabled";
  operationStatus: string | null;
  resultStatus: string | null;
  hasResultSet: boolean;
};

export type AutomationFlow = {
  labels: Record<AutomationStep, string>;
  states: Record<AutomationStep, AutomationStepState>;
};

const operationLabels: Record<string, string> = {
  queued: "W kolejce", running: "W toku", waiting_attention: "Wymaga uwagi",
  pause_requested: "Wstrzymywanie", paused: "Wstrzymano", completed: "Zakończono",
  cancelled: "Anulowano", failed: "Błąd",
};

export function deriveAutomationFlow(input: AutomationFlowInput): AutomationFlow {
  const hasOperation = Boolean(input.operationStatus);
  const operationStatus = input.operationStatus ?? "";
  const operationTerminal = ["completed", "cancelled", "failed"].includes(operationStatus);
  const resultStatus = input.resultStatus ?? "";
  const resultReady = resultStatus === "completed" || input.hasResultSet && !resultStatus;
  const labels: Record<AutomationStep, string> = {
    upload: input.hasImport ? "Plik zaimportowany" : "Wybierz plik",
    validation: input.hasImport ? "Kontrola dostępna" : "Oczekuje na import",
    regon: input.hasImport ? "Dane do sprawdzenia" : "Oczekuje na import",
    deduplication: input.preparation === "ready" ? "Zestaw przygotowany"
      : input.preparation === "working" ? "Przygotowanie w toku"
        : input.preparation === "attention" ? "Wymaga uwagi"
          : input.hasImport ? "Wymaga przygotowania" : "Oczekuje na dane",
    selection: input.preparation !== "ready" ? "Oczekuje na przygotowanie"
      : input.preview ? input.preview.readyCount > 0 ? "Podsumowanie gotowe" : "Brak gotowych wierszy"
        : "Wybierz firmy",
    launch: hasOperation ? operationLabels[operationStatus] ?? operationStatus
      : !input.preview ? "Oczekuje na podsumowanie"
        : input.preview.readyCount === 0 ? "Brak gotowych firm"
          : !input.canExecute ? "Brak uprawnienia"
            : input.health === "unknown" || input.health === "disabled" ? "Sprawdź stan usług"
              : input.health === "waiting" ? "Usługi wymagają uwagi"
                : "Wymaga potwierdzenia",
    progress: hasOperation ? operationLabels[operationStatus] ?? operationStatus : "Brak uruchomienia",
    results: input.hasResultSet ? resultStatus === "completed" ? "Wyniki dostępne"
      : resultStatus ? "Wyniki aktualizowane" : "Zestaw zapisany"
      : hasOperation ? "Oczekuje na wynik" : "Brak wyników",
  };
  const states: Record<AutomationStep, AutomationStepState> = {
    upload: input.hasImport ? "complete" : "upcoming",
    validation: input.hasImport ? "complete" : "upcoming",
    regon: input.hasImport ? "attention" : "upcoming",
    deduplication: input.preparation === "ready" ? "complete"
      : input.preparation === "working" || input.preparation === "attention" ? "attention" : "upcoming",
    selection: input.preview?.readyCount ? "complete" : input.preparation === "ready" ? "attention" : "upcoming",
    launch: hasOperation ? operationTerminal ? operationStatus === "completed" ? "complete" : "attention" : "attention"
      : input.preview?.readyCount && input.canExecute && input.health === "ready" ? "attention"
        : input.preview ? "attention" : "upcoming",
    progress: hasOperation ? operationTerminal ? operationStatus === "completed" ? "complete" : "attention" : "attention" : "upcoming",
    results: input.hasResultSet ? resultReady ? "complete" : "attention" : hasOperation ? "attention" : "upcoming",
  };
  return { labels, states };
}
