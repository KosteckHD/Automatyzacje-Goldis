import { createHmac } from "node:crypto";
import { normalizeNip, normalizeRegon } from "@goldis/core";
import { QueryTypes } from "sequelize";
import { dateStringInWarsaw } from "../../shared/warsaw-time";
import {
  type RegistryProvider,
  type RegistryProviderBatchOutcome,
  type RegistryProviderBatchResult,
  RegistryProviderError,
  type RegistryProviderResult,
} from "./registry-provider";

const PROVIDER_NAME = /^[a-z0-9-]{1,60}$/;
const DATA_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CANDIDATES = 100;

export type RegistryCachedValue = Readonly<{ result: RegistryProviderResult; expiresAt: Date }>;
export type RegistryCacheWrite = Readonly<{ nip: string; result: RegistryProviderResult; expiresAt: Date }>;

export interface RegistryResultCacheStore {
  getMany(
    providerName: string,
    dataDay: string,
    nips: readonly string[],
    now: Date,
  ): Promise<ReadonlyMap<string, RegistryCachedValue>>;
  setMany(providerName: string, dataDay: string, entries: readonly RegistryCacheWrite[]): Promise<void>;
}

export type RegistryPersistentCacheOptions = Readonly<{
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => Date;
}>;

function validateProviderName(providerName: string): void {
  if (!PROVIDER_NAME.test(providerName)) throw new Error("REGISTRY_CACHE_PROVIDER_INVALID");
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new Error(code);
  return value;
}

function safeCandidate(value: unknown, requestedNip: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache received an invalid candidate");
  }
  const candidate = value as Record<string, unknown>;
  const candidateNip = typeof candidate.nip === "string" ? normalizeNip(candidate.nip).normalized : null;
  if (
    candidateNip !== requestedNip ||
    typeof candidate.name !== "string" ||
    !candidate.name.trim() ||
    candidate.name.length > 256
  ) {
    throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache received an invalid candidate identity");
  }
  const sanitized: Record<string, unknown> = { nip: requestedNip, name: candidate.name.trim() };
  if (candidate.regon !== undefined && candidate.regon !== null && candidate.regon !== "") {
    if (typeof candidate.regon !== "string" || !normalizeRegon(candidate.regon).normalized) {
      throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache received an invalid REGON");
    }
    sanitized.regon = normalizeRegon(candidate.regon).normalized;
  }
  if (candidate.unitType !== undefined) {
    if (typeof candidate.unitType !== "string" || candidate.unitType.length > 80) {
      throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache received an invalid unit type");
    }
    sanitized.unitType = candidate.unitType;
  }
  if (candidate.parentRegon !== undefined) {
    if (typeof candidate.parentRegon !== "string" || !normalizeRegon(candidate.parentRegon).normalized) {
      throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache received an invalid parent REGON");
    }
    sanitized.parentRegon = normalizeRegon(candidate.parentRegon).normalized;
  }
  if (candidate.isLocalUnit !== undefined) {
    if (typeof candidate.isLocalUnit !== "boolean") {
      throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache received an invalid local-unit flag");
    }
    sanitized.isLocalUnit = candidate.isLocalUnit;
  }
  return sanitized;
}

function sanitizeResult(
  value: RegistryProviderResult,
  providerName: string,
  requestedNip: string,
): RegistryProviderResult {
  if (
    !value ||
    typeof value !== "object" ||
    value.providerName !== providerName ||
    typeof value.providerVersion !== "string" ||
    !value.providerVersion.trim() ||
    value.providerVersion.length > 80 ||
    !(value.dataVersion === null || (typeof value.dataVersion === "string" && value.dataVersion.length <= 256)) ||
    !(value.fetchedAt instanceof Date) ||
    !Number.isFinite(value.fetchedAt.getTime()) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_CANDIDATES
  ) {
    throw new RegistryProviderError("INVALID_RESPONSE", "Registry provider returned data outside the cache contract");
  }
  return {
    providerName,
    providerVersion: value.providerVersion,
    dataVersion: value.dataVersion,
    fetchedAt: new Date(value.fetchedAt),
    candidates: value.candidates.map((candidate) => safeCandidate(candidate, requestedNip)),
  };
}

/**
 * Short-lived shared cache in Postgres. NIPs are stored only as keyed HMACs;
 * cached candidate payloads omit NIP and reconstruct it from the lookup key.
 */
export class PostgresRegistryResultCache implements RegistryResultCacheStore {
  private readonly key: Buffer;

  constructor(hmacKeyHex: string) {
    if (typeof hmacKeyHex !== "string" || !/^[a-fA-F0-9]{64,128}$/.test(hmacKeyHex) || hmacKeyHex.length % 2 !== 0) {
      throw new Error("REGISTRY_CACHE_HMAC_KEY_MUST_BE_32_TO_64_BYTES_OF_HEX");
    }
    this.key = Buffer.from(hmacKeyHex, "hex");
  }

  async getMany(
    providerName: string,
    dataDay: string,
    nips: readonly string[],
    now: Date,
  ): Promise<ReadonlyMap<string, RegistryCachedValue>> {
    validateProviderName(providerName);
    if (!DATA_DAY.test(dataDay) || !Number.isFinite(now.getTime())) throw new Error("REGISTRY_CACHE_QUERY_INVALID");
    if (nips.length === 0) return new Map();
    const hashes = nips.map((nip) => this.hashNip(nip));
    const { sequelize } = await import("../../infrastructure/database/db");
    const rows = await sequelize.query<{ nip_hash: string; result_payload: unknown; expires_at: Date | string }>(
      `SELECT nip_hash, result_payload, expires_at
         FROM registry_result_cache
        WHERE provider_name = $1 AND data_day = $2 AND nip_hash = ANY($3::text[]) AND expires_at > $4`,
      { bind: [providerName, dataDay, hashes, now], type: QueryTypes.SELECT },
    );
    const requestedByHash = new Map(hashes.map((hash, index) => [hash, nips[index]]));
    const result = new Map<string, RegistryCachedValue>();
    for (const row of rows) {
      const nip = requestedByHash.get(row.nip_hash);
      if (!nip) continue;
      const restored = this.restorePayload(row.result_payload, providerName, nip);
      const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
      if (!restored || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) continue;
      result.set(nip, { result: restored, expiresAt });
    }
    return result;
  }

  async setMany(providerName: string, dataDay: string, entries: readonly RegistryCacheWrite[]): Promise<void> {
    validateProviderName(providerName);
    if (!DATA_DAY.test(dataDay)) throw new Error("REGISTRY_CACHE_DATA_DAY_INVALID");
    if (entries.length === 0) return;
    const now = new Date();
    const records = entries.map((entry) => {
      const nip = normalizeNip(entry.nip).normalized;
      if (!nip || nip !== entry.nip || !Number.isFinite(entry.expiresAt.getTime()) || entry.expiresAt <= now) {
        throw new Error("REGISTRY_CACHE_ENTRY_INVALID");
      }
      const safe = sanitizeResult(entry.result, providerName, nip);
      const payload = {
        providerName: safe.providerName,
        providerVersion: safe.providerVersion,
        dataVersion: safe.dataVersion,
        fetchedAt: safe.fetchedAt.toISOString(),
        candidates: safe.candidates.map(({ nip: _nip, ...candidate }) => candidate),
      };
      return { nip_hash: this.hashNip(nip), result_payload: payload, expires_at: entry.expiresAt.toISOString() };
    });
    const { sequelize } = await import("../../infrastructure/database/db");
    await sequelize.query(
      "DELETE FROM registry_result_cache WHERE expires_at <= now() AND created_at < now() - interval '1 day'",
    );
    await sequelize.query(
      `INSERT INTO registry_result_cache (provider_name, data_day, nip_hash, result_payload, expires_at, created_at, updated_at)
       SELECT $1, $2, entry.nip_hash, entry.result_payload, entry.expires_at, now(), now()
         FROM jsonb_to_recordset($3::jsonb) AS entry(nip_hash text, result_payload jsonb, expires_at timestamptz)
       ON CONFLICT (provider_name, data_day, nip_hash) DO UPDATE SET
         result_payload = EXCLUDED.result_payload, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
      { bind: [providerName, dataDay, JSON.stringify(records)] },
    );
  }

  private hashNip(nip: string): string {
    const normalized = normalizeNip(nip).normalized;
    if (!normalized || normalized !== nip) throw new Error("REGISTRY_CACHE_NIP_INVALID");
    return createHmac("sha256", this.key).update(normalized, "utf8").digest("hex");
  }

  private restorePayload(value: unknown, providerName: string, nip: string): RegistryProviderResult | null {
    try {
      const payload = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const result = payload as Record<string, unknown>;
      if (
        result.providerName !== providerName ||
        typeof result.providerVersion !== "string" ||
        !(result.dataVersion === null || typeof result.dataVersion === "string") ||
        typeof result.fetchedAt !== "string" ||
        !Array.isArray(result.candidates) ||
        result.candidates.length > MAX_CANDIDATES
      )
        return null;
      const candidates = result.candidates.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || Object.hasOwn(candidate, "nip"))
          throw new Error("CACHE_PAYLOAD_MUST_NOT_STORE_RAW_NIP");
        return safeCandidate({ ...(candidate as Record<string, unknown>), nip }, nip);
      });
      const fetchedAt = new Date(result.fetchedAt);
      if (!Number.isFinite(fetchedAt.getTime())) return null;
      return {
        providerName,
        providerVersion: result.providerVersion,
        dataVersion: result.dataVersion as string | null,
        fetchedAt,
        candidates,
      };
    } catch {
      return null;
    }
  }
}

/** Shared short-lived cache that sits outside the budgeted provider, so hits do not consume quota. */
export class PersistentRegistryCacheProvider implements RegistryProvider {
  readonly cacheNamespace: string;
  readonly maxBatchSize: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly provider: RegistryProvider,
    private readonly cache: RegistryResultCacheStore,
    options: RegistryPersistentCacheOptions = {},
  ) {
    const cacheNamespace = provider.cacheNamespace;
    if (!cacheNamespace) throw new Error("REGISTRY_CACHE_PROVIDER_NAMESPACE_REQUIRED");
    validateProviderName(cacheNamespace);
    this.cacheNamespace = cacheNamespace;
    this.maxBatchSize = provider.maxBatchSize ?? 30;
    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 30) {
      throw new Error("REGISTRY_CACHE_BATCH_SIZE_INVALID");
    }
    this.positiveTtlMs = positiveInteger(options.positiveTtlMs ?? 5 * 60_000, "REGISTRY_CACHE_POSITIVE_TTL_INVALID");
    this.negativeTtlMs = positiveInteger(options.negativeTtlMs ?? 60_000, "REGISTRY_CACHE_NEGATIVE_TTL_INVALID");
    this.now = options.now ?? (() => new Date());
  }

  async lookupByNip(nipNormalized: string, signal?: AbortSignal): Promise<RegistryProviderResult> {
    const outcomes = await this.lookupManyByNip([nipNormalized], signal);
    const outcome = outcomes.get(nipNormalized);
    if (!outcome) throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache omitted a requested NIP");
    if (outcome.kind === "error") throw outcome.error;
    return outcome.result;
  }

  async lookupManyByNip(nipsNormalized: readonly string[], signal?: AbortSignal): Promise<RegistryProviderBatchResult> {
    if (
      !Array.isArray(nipsNormalized) ||
      nipsNormalized.length < 1 ||
      nipsNormalized.length > 30 ||
      nipsNormalized.some((nip) => normalizeNip(nip).normalized !== nip)
    ) {
      throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache requires one to thirty normalized NIPs");
    }
    const uniqueNips = [...new Set(nipsNormalized)];
    const now = this.now();
    if (!Number.isFinite(now.getTime()))
      throw new RegistryProviderError("INVALID_RESPONSE", "Registry cache clock is invalid");
    const dataDay = dateStringInWarsaw(now);
    const cached = await this.cache.getMany(this.cacheNamespace, dataDay, uniqueNips, now);
    const outcomes = new Map<string, RegistryProviderBatchOutcome>();
    const validHits = new Map<string, RegistryProviderResult>();
    for (const nip of uniqueNips) {
      const entry = cached.get(nip);
      if (!entry || !(entry.expiresAt instanceof Date) || entry.expiresAt <= now) continue;
      try {
        validHits.set(nip, sanitizeResult(entry.result, this.cacheNamespace, nip));
      } catch {
        /* Corrupt cache rows are treated as misses and refreshed from the provider. */
      }
    }
    const missing = uniqueNips.filter((nip) => !validHits.has(nip));
    const fetched = await this.fetchMissing(missing, signal);
    const writes: RegistryCacheWrite[] = [];
    for (const nip of uniqueNips) {
      const cacheHit = validHits.get(nip);
      if (cacheHit) {
        outcomes.set(nip, { kind: "result", result: cacheHit });
        continue;
      }
      const outcome = fetched.get(nip);
      if (!outcome) {
        outcomes.set(nip, {
          kind: "error",
          error: new RegistryProviderError("INVALID_RESPONSE", "Registry provider omitted a requested NIP"),
        });
      } else if (outcome.kind === "error") {
        outcomes.set(nip, outcome);
      } else {
        try {
          const safe = sanitizeResult(outcome.result, this.cacheNamespace, nip);
          outcomes.set(nip, { kind: "result", result: safe });
          const hasRegon = safe.candidates.some(
            (candidate) => typeof candidate.regon === "string" && candidate.regon.length > 0,
          );
          const ttl = safe.candidates.length === 0 || !hasRegon ? this.negativeTtlMs : this.positiveTtlMs;
          writes.push({ nip, result: safe, expiresAt: new Date(now.getTime() + ttl) });
        } catch (error) {
          outcomes.set(nip, {
            kind: "error",
            error:
              error instanceof RegistryProviderError
                ? error
                : new RegistryProviderError("INVALID_RESPONSE", "Registry provider returned invalid cache data"),
          });
        }
      }
    }
    // Cache storage is an optimization; a successful provider response remains usable if persistence fails.
    if (writes.length > 0) await this.cache.setMany(this.cacheNamespace, dataDay, writes).catch(() => undefined);
    return outcomes;
  }

  private async fetchMissing(nips: readonly string[], signal?: AbortSignal): Promise<RegistryProviderBatchResult> {
    if (nips.length === 0) return new Map();
    if (this.provider.lookupManyByNip) return this.provider.lookupManyByNip(nips, signal);
    const outcomes = new Map<string, RegistryProviderBatchOutcome>();
    await Promise.all(
      nips.map(async (nip) => {
        try {
          outcomes.set(nip, { kind: "result", result: await this.provider.lookupByNip(nip, signal) });
        } catch (error) {
          outcomes.set(nip, {
            kind: "error",
            error:
              error instanceof RegistryProviderError
                ? error
                : new RegistryProviderError("UNAVAILABLE", "Registry provider request failed"),
          });
        }
      }),
    );
    return outcomes;
  }
}
