type ReadinessProbes = Readonly<{
  database: () => Promise<unknown>;
  redis: () => Promise<boolean>;
  deletionJournal: () => Promise<unknown>;
}>;

/** Readiness stays closed unless runtime dependencies and deletion admission all agree. */
export async function probeApiReadiness(probes: ReadinessProbes, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("HEALTH_PROBE_TIMEOUT")), timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.all([probes.database().then(() => true), probes.redis(), probes.deletionJournal().then(() => true)]),
      deadline,
    ]);
    return result[0] && result[1] && result[2];
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
