import { QueryTypes } from "sequelize";
import { dateStringInWarsaw, secondsUntilNextWarsawDay } from "../../shared/warsaw-time";
import {
  type RegistryProvider,
  type RegistryProviderBatchOutcome,
  type RegistryProviderBatchResult,
  RegistryProviderError,
  type RegistryProviderResult,
} from "./registry-provider";

export { secondsUntilNextWarsawDay } from "../../shared/warsaw-time";

const PROVIDER_NAME = /^[a-z0-9-]{1,60}$/;

export type RegistryBudgetOptions = Readonly<{
  dailyLimit?: number;
  now?: () => Date;
  reserve?: (providerName: string, date: string, dailyLimit: number, now: Date) => Promise<boolean>;
}>;

async function reservePersistent(
  providerName: string,
  usageDate: string,
  dailyLimit: number,
  now: Date,
): Promise<boolean> {
  const { sequelize } = await import("../../infrastructure/database/db");
  const reserved = await sequelize.query<{ reserved_requests: number }>(
    `INSERT INTO registry_provider_daily_budgets
       (provider_name, usage_date, daily_limit, reserved_requests, created_at, updated_at)
     VALUES ($1, $2, $3, 1, $4, $4)
     ON CONFLICT (provider_name, usage_date) DO UPDATE SET
       reserved_requests = registry_provider_daily_budgets.reserved_requests + 1,
       updated_at = EXCLUDED.updated_at
     WHERE registry_provider_daily_budgets.reserved_requests
       < LEAST(registry_provider_daily_budgets.daily_limit, EXCLUDED.daily_limit)
     RETURNING reserved_requests`,
    { bind: [providerName, usageDate, dailyLimit, now], type: QueryTypes.SELECT },
  );
  return reserved.length === 1;
}

/** Reserves one daily IP quota before forwarding each external MF request. */
export class BudgetedRegistryProvider implements RegistryProvider {
  readonly cacheNamespace: string;
  readonly maxBatchSize: number;
  private readonly dailyLimit: number;
  private readonly now: () => Date;
  private readonly reserve: NonNullable<RegistryBudgetOptions["reserve"]>;

  constructor(
    private readonly provider: RegistryProvider,
    private readonly providerName: string,
    options: RegistryBudgetOptions = {},
  ) {
    if (!PROVIDER_NAME.test(providerName)) throw new Error("REGISTRY_BUDGET_PROVIDER_INVALID");
    this.cacheNamespace = providerName;
    this.maxBatchSize = provider.lookupManyByNip ? (provider.maxBatchSize ?? 30) : 1;
    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 30) {
      throw new Error("REGISTRY_BUDGET_BATCH_SIZE_INVALID");
    }
    this.dailyLimit = options.dailyLimit ?? 100;
    if (!Number.isSafeInteger(this.dailyLimit) || this.dailyLimit < 1 || this.dailyLimit > 10_000) {
      throw new Error("REGISTRY_BUDGET_LIMIT_INVALID");
    }
    this.now = options.now ?? (() => new Date());
    this.reserve = options.reserve ?? reservePersistent;
  }

  async lookupByNip(nipNormalized: string, signal?: AbortSignal): Promise<RegistryProviderResult> {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("REGISTRY_BUDGET_DATE_INVALID");
    const reserved = await this.reserve(this.providerName, dateStringInWarsaw(now), this.dailyLimit, now);
    if (!reserved) {
      throw new RegistryProviderError(
        "RATE_LIMITED",
        "Daily registry search budget exhausted",
        secondsUntilNextWarsawDay(now),
      );
    }
    return this.provider.lookupByNip(nipNormalized, signal);
  }

  async lookupManyByNip(nipsNormalized: readonly string[], signal?: AbortSignal): Promise<RegistryProviderBatchResult> {
    if (
      !Array.isArray(nipsNormalized) ||
      nipsNormalized.length < 1 ||
      nipsNormalized.length > 30 ||
      new Set(nipsNormalized).size !== nipsNormalized.length ||
      nipsNormalized.some((nip) => !/^\d{10}$/.test(nip))
    ) {
      throw new RegistryProviderError(
        "INVALID_RESPONSE",
        "Registry batch requires one to thirty unique normalized NIPs",
      );
    }
    if (this.provider.lookupManyByNip) {
      const outcomes = new Map<string, RegistryProviderBatchOutcome>();
      for (let offset = 0; offset < nipsNormalized.length; offset += this.maxBatchSize) {
        const chunk = nipsNormalized.slice(offset, offset + this.maxBatchSize);
        const now = this.now();
        if (!Number.isFinite(now.getTime())) throw new Error("REGISTRY_BUDGET_DATE_INVALID");
        const reserved = await this.reserve(this.providerName, dateStringInWarsaw(now), this.dailyLimit, now);
        if (!reserved) {
          const error = new RegistryProviderError(
            "RATE_LIMITED",
            "Daily registry search budget exhausted",
            secondsUntilNextWarsawDay(now),
          );
          for (const nip of chunk) outcomes.set(nip, { kind: "error", error });
          continue;
        }
        try {
          const chunkResults = await this.provider.lookupManyByNip(chunk, signal);
          for (const nip of chunk) {
            const outcome = chunkResults.get(nip);
            outcomes.set(
              nip,
              outcome ?? {
                kind: "error",
                error: new RegistryProviderError("INVALID_RESPONSE", "Registry batch omitted a requested NIP"),
              },
            );
          }
        } catch (error) {
          const providerError =
            error instanceof RegistryProviderError
              ? error
              : new RegistryProviderError("UNAVAILABLE", "Registry batch request failed");
          for (const nip of chunk) outcomes.set(nip, { kind: "error", error: providerError });
        }
      }
      return outcomes;
    }
    const outcomes = new Map<string, RegistryProviderBatchOutcome>();
    await Promise.all(
      nipsNormalized.map(async (nip) => {
        try {
          outcomes.set(nip, { kind: "result", result: await this.lookupByNip(nip, signal) });
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
