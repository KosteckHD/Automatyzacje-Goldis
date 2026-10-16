import { QueryTypes } from "sequelize";
import { RegistryProviderError } from "./registry-provider";

const providerPattern = /^[a-z0-9-]{1,60}$/;
const maximumIntervalMs = 60_000;
const maximumCooldownSeconds = 86_400;

export type RegistryPacerDependencies = Readonly<{
  now?: () => Date;
  reserveSlot?: (providerName: string, intervalMs: number, now: Date) => Promise<Date>;
  saveCooldown?: (providerName: string, intervalMs: number, until: Date, now: Date) => Promise<void>;
}>;

type RegistryPacerRow = Readonly<{ slot_at?: Date | string; provider_name?: string }>;
type RegistryPacerBind = string | number | Date | null;
type RegistryPacerQuery = (sql: string, bind: RegistryPacerBind[]) => Promise<readonly RegistryPacerRow[]>;

const reserveSlotSql = `INSERT INTO registry_provider_request_pacing AS pacing
       (provider_name, min_interval_ms, next_allowed_at, cooldown_until, updated_at)
     VALUES ($1, $2, $3::timestamptz + (INTERVAL '1 millisecond' * $2::integer), NULL, $3::timestamptz)
     ON CONFLICT (provider_name) DO UPDATE SET
       next_allowed_at = GREATEST(pacing.next_allowed_at,
         COALESCE(pacing.cooldown_until, EXCLUDED.updated_at), EXCLUDED.updated_at)
         + (EXCLUDED.min_interval_ms * INTERVAL '1 millisecond'),
       updated_at = EXCLUDED.updated_at
     WHERE pacing.min_interval_ms = EXCLUDED.min_interval_ms
     RETURNING (next_allowed_at - (min_interval_ms * INTERVAL '1 millisecond')) AS slot_at`;

const saveCooldownSql = `INSERT INTO registry_provider_request_pacing AS pacing
       (provider_name, min_interval_ms, next_allowed_at, cooldown_until, updated_at)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $4::timestamptz)
     ON CONFLICT (provider_name) DO UPDATE SET
       next_allowed_at = GREATEST(pacing.next_allowed_at, EXCLUDED.cooldown_until),
       cooldown_until = GREATEST(COALESCE(pacing.cooldown_until, EXCLUDED.cooldown_until), EXCLUDED.cooldown_until),
       updated_at = EXCLUDED.updated_at
     WHERE pacing.min_interval_ms = EXCLUDED.min_interval_ms
     RETURNING provider_name`;

/** Store factory lets database integration tests exercise the exact production SQL. */
export function createRegistryRequestPacerStore(query: RegistryPacerQuery) {
  return {
    async reserveSlot(providerName: string, intervalMs: number, now: Date): Promise<Date> {
      const rows = await query(reserveSlotSql, [providerName, intervalMs, now]);
      if (rows.length !== 1) throw new Error("REGISTRY_REQUEST_PACER_CONFIGURATION_MISMATCH");
      const slotAt = new Date(rows[0].slot_at ?? Number.NaN);
      if (!Number.isFinite(slotAt.getTime())) throw new Error("REGISTRY_REQUEST_PACER_SLOT_INVALID");
      return slotAt;
    },
    async saveCooldown(providerName: string, intervalMs: number, until: Date, now: Date): Promise<void> {
      const rows = await query(saveCooldownSql, [providerName, intervalMs, until, now]);
      if (rows.length !== 1) throw new Error("REGISTRY_REQUEST_PACER_CONFIGURATION_MISMATCH");
    },
  };
}

export async function reserveRegistryRequestSlot(providerName: string, intervalMs: number, now: Date): Promise<Date> {
  const { sequelize } = await import("../../infrastructure/database/db");
  const store = createRegistryRequestPacerStore(async (sql, bind) =>
    sequelize.query<RegistryPacerRow>(sql, { bind, type: QueryTypes.SELECT }),
  );
  return store.reserveSlot(providerName, intervalMs, now);
}

export async function saveRegistryProviderCooldown(
  providerName: string,
  intervalMs: number,
  until: Date,
  now: Date,
): Promise<void> {
  const { sequelize } = await import("../../infrastructure/database/db");
  const store = createRegistryRequestPacerStore(async (sql, bind) =>
    sequelize.query<RegistryPacerRow>(sql, { bind, type: QueryTypes.SELECT }),
  );
  await store.saveCooldown(providerName, intervalMs, until, now);
}

function retryAfterSeconds(header: string | null, now: Date): number {
  if (header && /^\d+$/.test(header)) return Math.min(maximumCooldownSeconds, Number(header));
  if (header) {
    const retryAt = Date.parse(header);
    if (Number.isFinite(retryAt))
      return Math.min(maximumCooldownSeconds, Math.max(0, Math.ceil((retryAt - now.getTime()) / 1000)));
  }
  return 300;
}

function waitForSlot(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RegistryProviderError("TIMEOUT", "Registry request was cancelled"));
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(new RegistryProviderError("TIMEOUT", "Registry request was cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

/** Serializes actual upstream HTTP starts across processes using a durable PostgreSQL reservation. */
export class RegistryRequestPacer {
  private readonly now: () => Date;
  private readonly reserveSlot: NonNullable<RegistryPacerDependencies["reserveSlot"]>;
  private readonly saveCooldown: NonNullable<RegistryPacerDependencies["saveCooldown"]>;

  constructor(
    readonly providerName: string,
    readonly minIntervalMs: number,
    dependencies: RegistryPacerDependencies = {},
  ) {
    if (!providerPattern.test(providerName)) throw new Error("REGISTRY_REQUEST_PACER_PROVIDER_INVALID");
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1 || minIntervalMs > maximumIntervalMs) {
      throw new Error("REGISTRY_REQUEST_PACER_INTERVAL_INVALID");
    }
    this.now = dependencies.now ?? (() => new Date());
    this.reserveSlot = dependencies.reserveSlot ?? reserveRegistryRequestSlot;
    this.saveCooldown = dependencies.saveCooldown ?? saveRegistryProviderCooldown;
  }

  wrap(fetchImpl: typeof fetch = fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const now = this.now();
      if (!Number.isFinite(now.getTime()))
        throw new RegistryProviderError("UNAVAILABLE", "Registry pacing clock is invalid");
      let slotAt: Date;
      try {
        slotAt = await this.reserveSlot(this.providerName, this.minIntervalMs, now);
      } catch {
        throw new RegistryProviderError("UNAVAILABLE", "Registry pacing is unavailable");
      }
      if (!Number.isFinite(slotAt.getTime()))
        throw new RegistryProviderError("UNAVAILABLE", "Registry pacing slot is invalid");
      await waitForSlot(slotAt.getTime() - this.now().getTime(), signal);
      if (signal?.aborted) throw new RegistryProviderError("TIMEOUT", "Registry request was cancelled");

      const response = await fetchImpl(input, init);
      if (response.status === 429) {
        const observedAt = this.now();
        const seconds = retryAfterSeconds(response.headers.get("retry-after"), observedAt);
        try {
          await this.saveCooldown(
            this.providerName,
            this.minIntervalMs,
            new Date(observedAt.getTime() + seconds * 1000),
            observedAt,
          );
        } catch {
          await response.body?.cancel().catch(() => undefined);
          throw new RegistryProviderError("UNAVAILABLE", "Registry cooldown could not be persisted");
        }
      }
      return response;
    }) as typeof fetch;
  }
}
