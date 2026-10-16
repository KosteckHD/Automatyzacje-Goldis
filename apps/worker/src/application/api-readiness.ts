type ReadinessPayload = Readonly<{ status?: unknown }>;
type ReadinessResponse = Readonly<{ ok: boolean; json(): Promise<unknown> }>;
type ReadinessFetch = (url: URL, init: Readonly<{ signal: AbortSignal; redirect: "error" }>) => Promise<ReadinessResponse>;

const readinessPath = "/api/health/ready";

export function workerApiReadinessUrl(environment: Readonly<Record<string, string | undefined>>): URL {
  const configured = environment.GOLDIS_API_READY_URL?.trim();
  const port = environment.API_PORT?.trim() || "3001";
  if (!configured && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error("WORKER_API_READINESS_CONFIG_INVALID");
  }
  let url: URL;
  try { url = new URL(configured || `http://127.0.0.1:${port}${readinessPath}`); }
  catch { throw new Error("WORKER_API_READINESS_CONFIG_INVALID"); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || !url.hostname || url.username || url.password
    || url.pathname !== readinessPath || url.search || url.hash) {
    throw new Error("WORKER_API_READINESS_CONFIG_INVALID");
  }
  return url;
}

/** Requires API readiness, which verifies the database against the signed deletion journal. */
export async function assertWorkerApiReady(
  environment: Readonly<Record<string, string | undefined>>,
  fetcher: ReadinessFetch = fetch as unknown as ReadinessFetch,
): Promise<void> {
  const url = workerApiReadinessUrl(environment);
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(2_000), redirect: "error" });
    if (!response.ok) throw new Error("API_NOT_READY");
    const payload = await response.json() as ReadinessPayload;
    if (!payload || typeof payload !== "object" || payload.status !== "ready") throw new Error("API_NOT_READY");
  } catch {
    throw new Error("WORKER_API_NOT_READY");
  }
}
