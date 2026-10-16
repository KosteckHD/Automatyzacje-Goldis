export type EnrichmentWorkerRuntimeStatus = Readonly<{
  status: "disabled" | "ready" | "degraded";
  providerName: string | null;
  observedAt: Date;
}>;

export function enrichmentWorkerHealth(input: {
  worker: EnrichmentWorkerRuntimeStatus | null;
  now?: number;
  freshnessMs?: number;
}) {
  const now = input.now ?? Date.now();
  const observedAt = input.worker ? new Date(input.worker.observedAt).getTime() : Number.NaN;
  const fresh = Boolean(
    input.worker &&
      Number.isFinite(observedAt) &&
      observedAt <= now &&
      now - observedAt <= (input.freshnessMs ?? 30_000),
  );
  const workerState = fresh && input.worker ? input.worker.status : "offline";
  const available = fresh && workerState !== "degraded";
  return {
    status: available ? "ready" : "not_ready",
    available,
    worker: workerState,
    provider: !fresh ? "unknown" : input.worker?.providerName ? "configured" : "disabled",
    providerName: fresh ? (input.worker?.providerName ?? null) : null,
    message:
      workerState === "offline"
        ? "Worker wzbogacania nie odpowiada."
        : workerState === "degraded"
          ? "Worker wzbogacania ma problem z usługą lub bazą."
          : workerState === "disabled"
            ? "Worker działa; dostawca rejestru jest wyłączony."
            : "Worker wzbogacania odpowiada.",
  } as const;
}
