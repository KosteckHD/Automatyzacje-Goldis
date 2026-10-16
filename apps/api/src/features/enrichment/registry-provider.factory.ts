import { GusBirRegistryProvider } from "./gus-bir-provider";
import { MfVatRegistryProvider } from "./mf-vat-provider";
import { PersistentRegistryCacheProvider, PostgresRegistryResultCache } from "./registry-cache";
import type { RegistryProvider } from "./registry-provider";
import { BudgetedRegistryProvider } from "./registry-request-budget";
import { RegistryRequestPacer } from "./registry-request-pacer";

export type RegistryProviderEnvironment = Readonly<Record<string, string | undefined>>;

function cacheKeyFromEnvironment(environment: RegistryProviderEnvironment): string {
  const cacheKey = environment.REGISTRY_CACHE_HMAC_KEY ?? "";
  if (!/^[a-fA-F0-9]{64,128}$/.test(cacheKey) || cacheKey.length % 2 !== 0) {
    throw new Error("REGISTRY_CACHE_HMAC_KEY_MUST_BE_32_TO_64_BYTES_OF_HEX");
  }
  return cacheKey;
}

function requestIntervalFromEnvironment(environment: RegistryProviderEnvironment, key: string): number {
  const configured = environment[key];
  if (configured === undefined || configured.trim() === "") return 1_000;
  const normalized = configured.trim();
  const interval = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) {
    throw new Error(`${key}_INVALID`);
  }
  return interval;
}

/** Registry lookups stay disabled unless the operator opts in explicitly. */
export function createRegistryProviderFromEnvironment(
  environment: RegistryProviderEnvironment,
): RegistryProvider | null {
  const selection = (environment.GOLDIS_ENRICHMENT_PROVIDER ?? "disabled").trim().toLowerCase();
  if (selection === "disabled") return null;
  if (selection === "mf-vat") {
    const mfEnvironment = (environment.MF_VAT_ENVIRONMENT ?? "production").trim().toLowerCase();
    if (mfEnvironment !== "production" && mfEnvironment !== "test") {
      throw new Error("MF_VAT_ENVIRONMENT_INVALID");
    }
    const cacheKey = cacheKeyFromEnvironment(environment);
    const fetchImpl = new RegistryRequestPacer(
      "mf-vat",
      requestIntervalFromEnvironment(environment, "MF_VAT_MIN_REQUEST_INTERVAL_MS"),
    ).wrap();
    const budgeted = new BudgetedRegistryProvider(
      new MfVatRegistryProvider({
        environment: mfEnvironment,
        ...(environment.MF_VAT_TEST_BASE_URL ? { testBaseUrl: environment.MF_VAT_TEST_BASE_URL } : {}),
        fetchImpl,
      }),
      "mf-vat",
      { dailyLimit: 100 },
    );
    return new PersistentRegistryCacheProvider(budgeted, new PostgresRegistryResultCache(cacheKey));
  }
  if (selection === "gus-bir") {
    if ((environment.APP_ENV ?? "development").trim().toLowerCase() === "production") {
      throw new Error("GOLDIS_ENRICHMENT_PROVIDER_INVALID");
    }
    const birEnvironment = (environment.GUS_BIR_ENVIRONMENT ?? "production").trim().toLowerCase();
    if (birEnvironment !== "production" && birEnvironment !== "test") {
      throw new Error("GUS_BIR_ENVIRONMENT_INVALID");
    }
    const userKey = environment.GUS_BIR_USER_KEY ?? "";
    if (!userKey.trim()) throw new Error("GUS_BIR_USER_KEY_REQUIRED");
    const cacheKey = cacheKeyFromEnvironment(environment);
    const fetchImpl = new RegistryRequestPacer(
      "gus-bir",
      requestIntervalFromEnvironment(environment, "GUS_BIR_MIN_REQUEST_INTERVAL_MS"),
    ).wrap();
    const budgeted = new BudgetedRegistryProvider(
      new GusBirRegistryProvider({ environment: birEnvironment, userKey, fetchImpl }),
      "gus-bir",
      { dailyLimit: 6_000 },
    );
    return new PersistentRegistryCacheProvider(budgeted, new PostgresRegistryResultCache(cacheKey));
  }
  throw new Error("GOLDIS_ENRICHMENT_PROVIDER_INVALID");
}
