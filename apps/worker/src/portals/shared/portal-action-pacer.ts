export const DEFAULT_PORTAL_ACTION_INTERVAL_MS = 1_000;
const maximumIntervalMs = 60_000;

export type PortalActionPacerDependencies = Readonly<{
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export function portalActionIntervalFromEnvironment(environment: Readonly<Record<string, string | undefined>>): number {
  const configured = environment.WORKER_PORTAL_MIN_ACTION_INTERVAL_MS;
  if (configured === undefined || configured.trim() === "") return DEFAULT_PORTAL_ACTION_INTERVAL_MS;
  const normalized = configured.trim();
  if (!/^\d+$/.test(normalized)) throw new Error("WORKER_PORTAL_MIN_ACTION_INTERVAL_MS_INVALID");
  const milliseconds = Number(normalized);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > maximumIntervalMs) {
    throw new Error("WORKER_PORTAL_MIN_ACTION_INTERVAL_MS_INVALID");
  }
  return milliseconds;
}

/** Spaces controlled actions on the single persistent browser profile owned by this worker. */
export class PortalActionPacer {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(readonly minIntervalMs: number, dependencies: PortalActionPacerDependencies = {}) {
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1 || minIntervalMs > maximumIntervalMs) {
      throw new Error("WORKER_PORTAL_MIN_ACTION_INTERVAL_MS_INVALID");
    }
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? wait;
  }

  async beforeAction(profileId: string, recheckLease: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(profileId)) throw new Error("WORKER_PORTAL_PROFILE_INVALID");
    const previous = this.tails.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.tails.set(profileId, queued);
    await previous;
    try {
      const currentTime = this.now();
      if (!Number.isFinite(currentTime)) throw new Error("WORKER_PORTAL_PACING_CLOCK_INVALID");
      const delay = Math.max(0, (this.nextAllowedAt.get(profileId) ?? currentTime) - currentTime);
      if (delay > 0) await this.sleep(delay, signal);
      await recheckLease();
      const admittedAt = this.now();
      if (!Number.isFinite(admittedAt)) throw new Error("WORKER_PORTAL_PACING_CLOCK_INVALID");
      this.nextAllowedAt.set(profileId, admittedAt + this.minIntervalMs);
    } finally {
      release();
      if (this.tails.get(profileId) === queued) this.tails.delete(profileId);
    }
  }
}
