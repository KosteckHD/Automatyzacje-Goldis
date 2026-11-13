import type { AutomationHealth, AutomationHealthState } from "./use-automation-health";

export function automationStatusMessage(
  status: AutomationHealthState["status"],
  health: AutomationHealth | null,
  message?: string,
): string {
  if (status === "checking") return "Sprawdzam dostępność sprawdzania OC…";
  if (status === "disabled") return "Sprawdzanie OC nie jest dostępne dla tego konta.";
  if (status === "unknown" || !health) return message || "Nie udało się sprawdzić dostępności. Spróbuj ponownie.";
  if (health.automationReady) return "Możesz rozpocząć sprawdzanie OC. Portal może poprosić o logowanie lub kod SMS.";
  if (!health.servicesReady) return "Możesz przygotować plik i dane. Usługi sprawdzania są chwilowo niedostępne.";
  if (health.worker !== "online") return "Możesz przygotować plik i dane. Usługa sprawdzania chwilowo nie odpowiada.";
  if (health.portalMode === "off") return "Możesz przygotować plik i dane. Sprawdzanie OC jest chwilowo wyłączone.";
  if (health.portalConfig !== "valid") return "Możesz przygotować plik i dane. Konfiguracja sprawdzania wymaga uzupełnienia.";
  return "Możesz przygotować plik i dane. Sprawdzanie OC jest chwilowo niedostępne.";
}

export function automationTechnicalStatus(health: AutomationHealth | null): string {
  if (!health) return "Nie otrzymano aktualnego odczytu gotowości usług.";
  const mode = health.portalMode === "off" ? "wyłączone" : health.portalMode === "live" ? "aktywne" : "nieznane";
  const configuration = health.portalConfig === "valid" ? "gotowa" : "niedostępna";
  return `Usługi: ${health.servicesReady ? "gotowe" : "niedostępne"} · Worker: ${health.worker === "online" ? "aktywny" : "nie odpowiada"} · Portale: ${mode} · Konfiguracja: ${configuration}`;
}
