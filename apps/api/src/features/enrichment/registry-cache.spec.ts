import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PersistentRegistryCacheProvider,
  type RegistryCachedValue,
  type RegistryCacheWrite,
  type RegistryResultCacheStore,
} from "./registry-cache";
import type { RegistryProvider, RegistryProviderResult } from "./registry-provider";

function syntheticNip(seed: number): string {
  for (let candidate = seed; ; candidate += 1) {
    const prefix = String(candidate).padStart(9, "0");
    const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11;
    if (checksum !== 10) return `${prefix}${checksum}`;
  }
}

function syntheticNips(count: number): string[] {
  const result = new Set<string>();
  for (let seed = 0; result.size < count; seed += 1) result.add(syntheticNip(seed));
  return [...result];
}

function syntheticResult(
  nip: string,
  candidates: RegistryProviderResult["candidates"] = [{ nip, name: "FIKCYJNY PODMIOT", regon: "000000000" }],
): RegistryProviderResult {
  return {
    providerName: "synthetic-registry",
    providerVersion: "fixture-1",
    dataVersion: null,
    fetchedAt: new Date("2026-10-07T12:00:00.000Z"),
    candidates,
  };
}

class MemoryRegistryCache implements RegistryResultCacheStore {
  readonly values = new Map<string, RegistryCachedValue>();
  async getMany(
    providerName: string,
    dataDay: string,
    nips: readonly string[],
    now: Date,
  ): Promise<ReadonlyMap<string, RegistryCachedValue>> {
    return new Map(
      nips.flatMap((nip) => {
        const value = this.values.get(`${providerName}|${dataDay}|${nip}`);
        return value && value.expiresAt > now ? [[nip, value] as const] : [];
      }),
    );
  }
  async setMany(providerName: string, dataDay: string, entries: readonly RegistryCacheWrite[]): Promise<void> {
    for (const entry of entries)
      this.values.set(`${providerName}|${dataDay}|${entry.nip}`, {
        result: structuredClone(entry.result),
        expiresAt: entry.expiresAt,
      });
  }
}

function providerFor(
  onLookup: () => void,
  candidatesFor: (nip: string) => RegistryProviderResult["candidates"] = (nip) => [
    { nip, name: "FIKCYJNY PODMIOT", regon: "000000000" },
  ],
): RegistryProvider {
  return {
    cacheNamespace: "synthetic-registry",
    async lookupByNip(nip) {
      onLookup();
      return syntheticResult(nip, candidatesFor(nip));
    },
    async lookupManyByNip(requested) {
      onLookup();
      return new Map(
        [...requested]
          .reverse()
          .map((nip) => [nip, { kind: "result", result: syntheticResult(nip, candidatesFor(nip)) }]),
      );
    },
  };
}

test("persistent cache deduplicates lookups, survives provider reconstruction, and separates provider/date keys", async () => {
  const [first, second] = syntheticNips(2);
  const cache = new MemoryRegistryCache();
  let now = new Date("2026-10-07T21:59:59.000Z");
  let calls = 0;
  const one = new PersistentRegistryCacheProvider(
    providerFor(() => {
      calls += 1;
    }),
    cache,
    { now: () => new Date(now) },
  );
  const firstResult = await one.lookupManyByNip([first, second, first]);
  assert.equal(firstResult.size, 2);
  assert.equal(calls, 1, "one real batch request handles unique misses");

  const restarted = new PersistentRegistryCacheProvider(
    providerFor(() => {
      calls += 1;
    }),
    cache,
    { now: () => new Date(now) },
  );
  const afterRestart = await restarted.lookupManyByNip([second, first]);
  assert.equal(calls, 1, "a new provider process reuses the shared result cache");
  assert.equal(afterRestart.get(first)?.kind, "result");

  now = new Date("2026-10-07T22:00:01.000Z");
  await restarted.lookupManyByNip([first]);
  assert.equal(calls, 2, "Warsaw midnight uses a different cache data day");
});

test("cache stores no-result and no-REGON outcomes only for the short negative TTL", async () => {
  const nip = syntheticNip(200);
  const cache = new MemoryRegistryCache();
  let now = new Date("2026-10-07T12:00:00.000Z");
  let calls = 0;
  const provider = new PersistentRegistryCacheProvider(
    providerFor(
      () => {
        calls += 1;
      },
      () => [],
    ),
    cache,
    { now: () => new Date(now), positiveTtlMs: 300_000, negativeTtlMs: 1_000 },
  );
  await provider.lookupByNip(nip);
  now = new Date(now.getTime() + 999);
  await provider.lookupByNip(nip);
  assert.equal(calls, 1);
  now = new Date(now.getTime() + 1);
  await provider.lookupByNip(nip);
  assert.equal(calls, 2, "negative cache entry expires at its exact TTL");

  const noRegonNip = syntheticNip(202);
  const noRegonProvider = new PersistentRegistryCacheProvider(
    providerFor(
      () => {
        calls += 1;
      },
      (requested) => [{ nip: requested, name: "FIKCYJNY PODMIOT" }],
    ),
    cache,
    { now: () => new Date(now), positiveTtlMs: 300_000, negativeTtlMs: 1_000 },
  );
  await noRegonProvider.lookupByNip(noRegonNip);
  now = new Date(now.getTime() + 999);
  await noRegonProvider.lookupByNip(noRegonNip);
  assert.equal(calls, 3, "a no-REGON result is still in the short negative cache TTL");
  now = new Date(now.getTime() + 1);
  await noRegonProvider.lookupByNip(noRegonNip);
  assert.equal(calls, 4);
});

test("cache refuses foreign NIP results and returns only the minimal validated identity", async () => {
  const nip = syntheticNip(300);
  const foreignNip = syntheticNip(400);
  const cache = new MemoryRegistryCache();
  let calls = 0;
  const foreignProvider = providerFor(
    () => {
      calls += 1;
    },
    () => [{ nip: foreignNip, name: "OBCA FIRMA", regon: "000000000" }],
  );
  const wrapper = new PersistentRegistryCacheProvider(foreignProvider, cache);
  const bad = await wrapper.lookupManyByNip([nip]);
  assert.equal(bad.get(nip)?.kind, "error");
  assert.equal(cache.values.size, 0, "untrusted provider responses never enter the cache");

  const validProvider = providerFor(
    () => {
      calls += 1;
    },
    () => [
      {
        nip,
        name: " FIKCYJNY PODMIOT ",
        regon: "000000000",
        unnecessarySensitiveField: "MUST_NOT_ESCAPE",
      },
    ],
  );
  const valid = new PersistentRegistryCacheProvider(validProvider, cache);
  const result = await valid.lookupByNip(nip);
  assert.equal(result.candidates[0].name, "FIKCYJNY PODMIOT");
  assert.equal(Object.hasOwn(result.candidates[0], "unnecessarySensitiveField"), false);
  assert.equal(calls, 2);
});
