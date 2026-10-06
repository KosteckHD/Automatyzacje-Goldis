export type WorkerRuntimeStatus = Readonly<{ mode: "off" | "live"; portalConfigValid: boolean; observedAt: Date }>;

export function automationReadiness(input: {
  servicesReady: boolean; worker: WorkerRuntimeStatus | null; now?: number; freshnessMs?: number;
}) {
  const now = input.now ?? Date.now();
  const observedAt = input.worker ? new Date(input.worker.observedAt).getTime() : Number.NaN;
  const fresh = Boolean(input.worker && Number.isFinite(observedAt) && now >= observedAt
    && now - observedAt <= (input.freshnessMs ?? 30_000));
  const automationReady = input.servicesReady && fresh && input.worker?.mode === "live" && input.worker.portalConfigValid;
  return {
    status: automationReady ? "ready" : "waiting",
    automationReady,
    servicesReady: input.servicesReady,
    worker: fresh ? "online" : "offline",
    portalMode: fresh && input.worker ? input.worker.mode : "unknown",
    portalConfig: fresh && input.worker?.portalConfigValid ? "valid" : "unavailable",
    message: !input.servicesReady ? "Sprawdź dostępność API, bazy i kolejki."
      : !fresh ? "Worker automatyzacji nie odpowiada."
        : input.worker?.mode === "off" ? "Portale wyłączone."
          : !input.worker?.portalConfigValid ? "Konfiguracja portali nie jest gotowa."
            : "Automatyzacja gotowa.",
  } as const;
}
