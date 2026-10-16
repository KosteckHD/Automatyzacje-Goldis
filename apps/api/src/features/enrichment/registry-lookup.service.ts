import { normalizeNip } from "@goldis/core";
import { BadRequestException } from "@nestjs/common";
import {
  type RegistryProvider,
  type RegistryProviderBatchOutcome,
  type RegistryProviderBatchResult,
  RegistryProviderError,
  type RegistryProviderResult,
} from "./registry-provider";

export type RegistryLookupOptions = Readonly<{
  maxConcurrency?: number;
  maxCacheEntries?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

type CacheEntry = Readonly<{ expiresAt: number; result: RegistryProviderResult }>;

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function positiveInteger(value: number, setting: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`REGISTRY_LOOKUP_CONFIG_${setting.toUpperCase()}_INVALID`);
  }
  return value;
}

function cloneAndValidateResult(value: RegistryProviderResult): RegistryProviderResult {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.providerName !== "string" ||
    !value.providerName.trim() ||
    typeof value.providerVersion !== "string" ||
    !value.providerVersion.trim() ||
    !(value.dataVersion === null || typeof value.dataVersion === "string") ||
    !(value.fetchedAt instanceof Date) ||
    !Number.isFinite(value.fetchedAt.getTime()) ||
    !Array.isArray(value.candidates) ||
    value.candidates.some(
      (candidate) => candidate === null || typeof candidate !== "object" || Array.isArray(candidate),
    )
  ) {
    throw new RegistryProviderError("INVALID_RESPONSE", "Registry provider returned an invalid response");
  }
  try {
    return structuredClone(value);
  } catch {
    throw new RegistryProviderError("INVALID_RESPONSE", "Registry provider response could not be copied safely");
  }
}

/**
 * Bounded, process-local lookup coordinator. Successful answers, including an
 * empty result, are cached briefly; provider errors are never cached.
 */
export class RegistryLookupService {
  private readonly maxConcurrency: number;
  private readonly maxCacheEntries: number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<RegistryProviderResult>>();
  private readonly waitingForPermit: Array<() => void> = [];
  private activeRequests = 0;

  constructor(
    private readonly provider: RegistryProvider,
    options: RegistryLookupOptions = {},
  ) {
    this.maxConcurrency = positiveInteger(options.maxConcurrency ?? 3, "maxConcurrency");
    this.maxCacheEntries = positiveInteger(options.maxCacheEntries ?? 1_000, "maxCacheEntries");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "timeoutMs");
    this.cacheTtlMs = positiveInteger(options.cacheTtlMs ?? 5 * 60_000, "cacheTtlMs");
    this.maxRetries = positiveInteger(options.maxRetries ?? 2, "maxRetries", true);
    this.retryBaseDelayMs = positiveInteger(options.retryBaseDelayMs ?? 250, "retryBaseDelayMs", true);
    this.retryMaxDelayMs = positiveInteger(options.retryMaxDelayMs ?? 2_000, "retryMaxDelayMs", true);
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) throw new Error("REGISTRY_LOOKUP_CONFIG_RETRY_MAX_DELAY_INVALID");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get supportsBatch(): boolean {
    return typeof this.provider.lookupManyByNip === "function";
  }

  async lookupByNip(nipInput: string): Promise<RegistryProviderResult> {
    const nipNormalized = normalizeNip(nipInput).normalized;
    if (!nipNormalized) throw new BadRequestException("Nieprawidłowy NIP do wyszukania w rejestrze");
    if (this.provider.lookupManyByNip) {
      const outcome = (await this.lookupManyByNip([nipNormalized])).get(nipNormalized);
      if (!outcome) throw new RegistryProviderError("INVALID_RESPONSE", "Registry batch omitted a requested NIP");
      if (outcome.kind === "error") throw outcome.error;
      return outcome.result;
    }

    this.removeExpiredCacheEntries();
    const cached = this.cache.get(nipNormalized);
    if (cached && cached.expiresAt > this.now()) return cloneAndValidateResult(cached.result);

    const existing = this.inFlight.get(nipNormalized);
    if (existing) return cloneAndValidateResult(await existing);

    const request = this.withPermit(() => this.lookupWithRetry(nipNormalized))
      .then((result) => {
        if (!this.cache.has(nipNormalized) && this.cache.size >= this.maxCacheEntries) {
          const oldestKey = this.cache.keys().next().value as string | undefined;
          if (oldestKey !== undefined) this.cache.delete(oldestKey);
        }
        this.cache.set(nipNormalized, { expiresAt: this.now() + this.cacheTtlMs, result });
        return result;
      })
      .finally(() => {
        if (this.inFlight.get(nipNormalized) === request) this.inFlight.delete(nipNormalized);
      });
    this.inFlight.set(nipNormalized, request);
    return cloneAndValidateResult(await request);
  }

  async lookupManyByNip(nipsInput: readonly string[]): Promise<RegistryProviderBatchResult> {
    if (!Array.isArray(nipsInput) || nipsInput.length < 1 || nipsInput.length > 30) {
      throw new BadRequestException("Wyszukiwanie zbiorcze obsługuje od 1 do 30 numerów NIP");
    }
    const nips = [...new Set(nipsInput.map((input) => normalizeNip(input).normalized))];
    if (nips.some((nip) => nip === null)) throw new BadRequestException("Nieprawidłowy NIP do wyszukania w rejestrze");
    const normalizedNips = nips as string[];
    if (!this.provider.lookupManyByNip) {
      const outcomes = new Map<string, RegistryProviderBatchOutcome>();
      await Promise.all(
        normalizedNips.map(async (nip) => {
          try {
            outcomes.set(nip, { kind: "result", result: await this.lookupByNip(nip) });
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

    this.removeExpiredCacheEntries();
    const missing: string[] = [];
    for (const nip of normalizedNips) {
      const cached = this.cache.get(nip);
      if (cached && cached.expiresAt > this.now()) continue;
      if (!this.inFlight.has(nip)) missing.push(nip);
    }

    if (missing.length > 0) {
      const batchRequest = this.withPermit(() => this.lookupBatchWithRetry(missing));
      for (const nip of missing) {
        const request = batchRequest
          .then((outcomes) => {
            const outcome = outcomes.get(nip);
            if (!outcome) throw new RegistryProviderError("INVALID_RESPONSE", "Registry batch omitted a requested NIP");
            if (outcome.kind === "error") throw outcome.error;
            const result = cloneAndValidateResult(outcome.result);
            this.storeCacheResult(nip, result);
            return result;
          })
          .finally(() => {
            if (this.inFlight.get(nip) === request) this.inFlight.delete(nip);
          });
        this.inFlight.set(nip, request);
      }
    }

    const results = new Map<string, RegistryProviderBatchOutcome>();
    await Promise.all(
      normalizedNips.map(async (nip) => {
        const cached = this.cache.get(nip);
        if (cached && cached.expiresAt > this.now()) {
          results.set(nip, { kind: "result", result: cloneAndValidateResult(cached.result) });
          return;
        }
        const request = this.inFlight.get(nip);
        if (!request) {
          results.set(nip, {
            kind: "error",
            error: new RegistryProviderError("INVALID_RESPONSE", "Registry batch result is unavailable"),
          });
          return;
        }
        try {
          results.set(nip, { kind: "result", result: cloneAndValidateResult(await request) });
        } catch (error) {
          results.set(nip, {
            kind: "error",
            error:
              error instanceof RegistryProviderError
                ? error
                : new RegistryProviderError("UNAVAILABLE", "Registry provider request failed"),
          });
        }
      }),
    );
    return results;
  }

  private storeCacheResult(nipNormalized: string, result: RegistryProviderResult): void {
    if (!this.cache.has(nipNormalized) && this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(nipNormalized, { expiresAt: this.now() + this.cacheTtlMs, result });
  }

  private removeExpiredCacheEntries(): void {
    const now = this.now();
    for (const [nip, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(nip);
    }
  }

  private async withPermit<T>(work: () => Promise<T>): Promise<T> {
    await this.acquirePermit();
    try {
      return await work();
    } finally {
      this.releasePermit();
    }
  }

  private async acquirePermit(): Promise<void> {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waitingForPermit.push(resolve));
  }

  private releasePermit(): void {
    const next = this.waitingForPermit.shift();
    if (next) next();
    else this.activeRequests -= 1;
  }

  private async lookupWithRetry(nipNormalized: string): Promise<RegistryProviderResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.lookupOnce(nipNormalized);
      } catch (error) {
        const providerError =
          error instanceof RegistryProviderError
            ? error
            : new RegistryProviderError("UNAVAILABLE", "Registry provider request failed");
        const canRetry = providerError.code === "RATE_LIMITED" || providerError.code === "UNAVAILABLE";
        if (!canRetry || attempt >= this.maxRetries) throw providerError;
        const exponentialDelay = Math.min(this.retryBaseDelayMs * 2 ** attempt, this.retryMaxDelayMs);
        const providerDelay =
          providerError.retryAfterSeconds === null
            ? exponentialDelay
            : Math.min(providerError.retryAfterSeconds * 1000, this.retryMaxDelayMs);
        await this.sleep(Math.max(0, providerDelay));
      }
    }
  }

  private async lookupBatchWithRetry(nipsNormalized: readonly string[]): Promise<RegistryProviderBatchResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.lookupBatchOnce(nipsNormalized);
      } catch (error) {
        const providerError =
          error instanceof RegistryProviderError
            ? error
            : new RegistryProviderError("UNAVAILABLE", "Registry provider batch failed");
        const canRetry = providerError.code === "RATE_LIMITED" || providerError.code === "UNAVAILABLE";
        if (!canRetry || attempt >= this.maxRetries) throw providerError;
        const exponentialDelay = Math.min(this.retryBaseDelayMs * 2 ** attempt, this.retryMaxDelayMs);
        const providerDelay =
          providerError.retryAfterSeconds === null
            ? exponentialDelay
            : Math.min(providerError.retryAfterSeconds * 1000, this.retryMaxDelayMs);
        await this.sleep(Math.max(0, providerDelay));
      }
    }
  }

  private async lookupBatchOnce(nipsNormalized: readonly string[]): Promise<RegistryProviderBatchResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new RegistryProviderError("TIMEOUT", "Registry provider batch timed out"));
      }, this.timeoutMs);
    });
    try {
      const lookupMany = this.provider.lookupManyByNip;
      if (!lookupMany)
        throw new RegistryProviderError("INVALID_RESPONSE", "Registry provider does not support batch lookup");
      const request = lookupMany.call(this.provider, nipsNormalized, controller.signal).then((outcomes) => {
        if (
          !(outcomes instanceof Map) ||
          outcomes.size !== nipsNormalized.length ||
          nipsNormalized.some((nip) => !outcomes.has(nip))
        ) {
          throw new RegistryProviderError("INVALID_RESPONSE", "Registry provider returned an incomplete batch");
        }
        const validated = new Map<string, RegistryProviderBatchOutcome>();
        for (const nip of nipsNormalized) {
          const outcome = outcomes.get(nip);
          if (!outcome || typeof outcome !== "object" || !["result", "error"].includes(outcome.kind)) {
            throw new RegistryProviderError("INVALID_RESPONSE", "Registry provider returned an invalid batch item");
          }
          if (outcome.kind === "error") {
            if (!(outcome.error instanceof RegistryProviderError)) {
              throw new RegistryProviderError("INVALID_RESPONSE", "Registry provider returned an invalid batch error");
            }
            validated.set(nip, outcome);
          } else {
            validated.set(nip, { kind: "result", result: cloneAndValidateResult(outcome.result) });
          }
        }
        return validated;
      });
      return await Promise.race([request, timeoutResult]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async lookupOnce(nipNormalized: string): Promise<RegistryProviderResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new RegistryProviderError("TIMEOUT", "Registry provider request timed out"));
      }, this.timeoutMs);
    });
    try {
      const request = this.provider
        .lookupByNip(nipNormalized, controller.signal)
        .then((result) => cloneAndValidateResult(result));
      return await Promise.race([request, timeoutResult]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
