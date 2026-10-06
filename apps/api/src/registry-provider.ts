/**
 * Port to an external business registry. Implementations must not persist raw
 * provider responses; callers own validation, audit and retention decisions.
 */
export type RegistryRawCandidate = Readonly<Record<string, unknown>>;

export type RegistryProviderResult = Readonly<{
  providerName: string;
  providerVersion: string;
  dataVersion: string | null;
  fetchedAt: Date;
  candidates: readonly RegistryRawCandidate[];
}>;

export type RegistryProviderErrorCode = "RATE_LIMITED" | "UNAVAILABLE" | "TIMEOUT" | "INVALID_RESPONSE";

export class RegistryProviderError extends Error {
  readonly code: RegistryProviderErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: RegistryProviderErrorCode, message: string, retryAfterSeconds: number | null = null) {
    if (retryAfterSeconds !== null
      && (code !== "RATE_LIMITED" || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0)) {
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
  /** Implementations must honor `signal` so a timed-out request releases transport resources. */
  lookupByNip(nipNormalized: string, signal?: AbortSignal): Promise<RegistryProviderResult>;
}
