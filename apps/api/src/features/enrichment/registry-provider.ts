/**
 * Port to an external business registry. Implementations must not persist raw
 * provider responses; callers own validation, audit and retention decisions.
 */
import type { RegistryProviderResult } from "../../contracts/registry-provider";

export type { RegistryProviderResult, RegistryRawCandidate } from "../../contracts/registry-provider";

export type RegistryProviderBatchOutcome = Readonly<
  { kind: "result"; result: RegistryProviderResult } | { kind: "error"; error: RegistryProviderError }
>;
export type RegistryProviderBatchResult = ReadonlyMap<string, RegistryProviderBatchOutcome>;

export type RegistryProviderErrorCode = "RATE_LIMITED" | "UNAVAILABLE" | "TIMEOUT" | "INVALID_RESPONSE";

export class RegistryProviderError extends Error {
  readonly code: RegistryProviderErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: RegistryProviderErrorCode, message: string, retryAfterSeconds: number | null = null) {
    if (
      retryAfterSeconds !== null &&
      (code !== "RATE_LIMITED" || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0)
    ) {
      throw new Error("REGISTRY_PROVIDER_RETRY_AFTER_INVALID");
    }
    super(message);
    this.name = "RegistryProviderError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** `nipNormalized` must be a checksum-valid ten-digit NIP from the core validator. */
export interface RegistryProvider {
  /** Stable cache/quota namespace; it must not contain tenant or NIP data. */
  readonly cacheNamespace?: string;
  /** Maximum NIPs in one actual upstream request, when batch lookup is supported. */
  readonly maxBatchSize?: number;
  /** Implementations must honor `signal` so a timed-out request releases transport resources. */
  lookupByNip(nipNormalized: string, signal?: AbortSignal): Promise<RegistryProviderResult>;
  /** Optional real provider batch request; keys in the result are normalized NIPs. */
  lookupManyByNip?(nipsNormalized: readonly string[], signal?: AbortSignal): Promise<RegistryProviderBatchResult>;
}
