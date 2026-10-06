import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { RegistryLookupService } from "./registry-lookup";
import { RegistryProvider, RegistryProviderError, RegistryProviderResult } from "./registry-provider";

function syntheticNip(seed: number): string {
  for (let candidate = seed; ; candidate += 1) {
    const base = String(candidate).padStart(9, "0");
    const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(base[index]), 0) % 11;
    if (checksum !== 10) return `${base}${checksum}`;
  }
}

function syntheticNips(count: number): string[] {
  const nips: string[] = [];
  for (let candidate = 0; nips.length < count; candidate += 1) {
    const base = String(candidate).padStart(9, "0");
    const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(base[index]), 0) % 11;
    if (checksum !== 10) nips.push(`${base}${checksum}`);
  }
  return nips;
}

function resultFor(nip: string, name = "FIKCYJNY PODMIOT"): RegistryProviderResult {
  return {
    providerName: "synthetic-registry",
    providerVersion: "fixture-1",
    dataVersion: "fixture-data-1",
    fetchedAt: new Date("2026-01-15T12:00:00.000Z"),
    candidates: [{ nip, regon: "000000000", name }],
  };
}

class ScriptedProvider implements RegistryProvider {
  calls: string[] = [];
  constructor(private readonly handler: (nip: string, signal: AbortSignal | undefined, attempt: number) => Promise<RegistryProviderResult>) {}

  lookupByNip(nip: string, signal?: AbortSignal): Promise<RegistryProviderResult> {
    this.calls.push(nip);
    return this.handler(nip, signal, this.calls.length);
  }
}

test("RegistryLookupService łączy równoległe zapytania, izoluje wynik i cache wygasa zgodnie z TTL", async () => {
  let now = 1_000;
  const provider = new ScriptedProvider(async (nip) => resultFor(nip));
  const service = new RegistryLookupService(provider, { cacheTtlMs: 50, now: () => now });
  const nip = syntheticNip(0);

  const parallel = await Promise.all(Array.from({ length: 8 }, () => service.lookupByNip(nip)));
  assert.equal(provider.calls.length, 1);
  assert.ok(parallel.every((item) => item.candidates.length === 1));
  (parallel[0].candidates[0] as Record<string, unknown>).name = "ZMUTOWANY WYNIK TESTU";
  assert.equal((await service.lookupByNip(nip)).candidates[0].name, "FIKCYJNY PODMIOT");
  assert.equal(provider.calls.length, 1);

  now = 1_050;
  await service.lookupByNip(nip);
  assert.equal(provider.calls.length, 2, "cache powinien wygasnąć dokładnie na granicy TTL");
});

test("RegistryLookupService nie przekracza skonfigurowanej współbieżności", async () => {
  let active = 0;
  let maximumActive = 0;
  const provider = new ScriptedProvider(async (nip) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return resultFor(nip);
  });
  const service = new RegistryLookupService(provider, { maxConcurrency: 2, cacheTtlMs: 1_000 });

  const nips = syntheticNips(7);
  assert.equal(new Set(nips).size, 7, "fixture powinien podać siedem różnych NIP-ów");
  await Promise.all(nips.map((nip) => service.lookupByNip(nip)));
  assert.equal(provider.calls.length, 7);
  assert.equal(maximumActive, 2);
});

test("RegistryLookupService usuwa najstarszy cache po osiągnięciu limitu wpisów", async () => {
  const provider = new ScriptedProvider(async (nip) => resultFor(nip));
  const service = new RegistryLookupService(provider, { maxCacheEntries: 1, cacheTtlMs: 10_000 });
  const [first, second] = syntheticNips(2);

  await service.lookupByNip(first);
  await service.lookupByNip(second);
  await service.lookupByNip(first);
  assert.deepEqual(provider.calls, [first, second, first]);
});

test("RegistryLookupService ponawia RATE_LIMITED raz i ogranicza Retry-After", async () => {
  const provider = new ScriptedProvider(async (nip, _signal, attempt) => {
    if (attempt === 1) throw new RegistryProviderError("RATE_LIMITED", "Synthetic 429", 120);
    return resultFor(nip);
  });
  const delays: number[] = [];
  const service = new RegistryLookupService(provider, {
    maxRetries: 2,
    retryMaxDelayMs: 25,
    retryBaseDelayMs: 5,
    sleep: async (delay) => { delays.push(delay); },
  });

  await service.lookupByNip(syntheticNip(0));
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(delays, [25]);
});

test("RegistryLookupService ogranicza ponowienia błędu dostawcy 5xx do skonfigurowanej liczby", async () => {
  const provider = new ScriptedProvider(async () => {
    throw new RegistryProviderError("UNAVAILABLE", "Synthetic 503");
  });
  const delays: number[] = [];
  const service = new RegistryLookupService(provider, {
    maxRetries: 2,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
    sleep: async (delay) => { delays.push(delay); },
  });

  await assert.rejects(service.lookupByNip(syntheticNip(0)), (error: unknown) => {
    assert.ok(error instanceof RegistryProviderError);
    assert.equal(error.code, "UNAVAILABLE");
    return true;
  });
  assert.equal(provider.calls.length, 3, "2 retry oznaczają łącznie 3 próby");
  assert.deepEqual(delays, [5, 10]);
});

test("RegistryLookupService przerywa timeout przez AbortSignal i nie wznawia go", async () => {
  let observedAbort = false;
  const provider = new ScriptedProvider(async (_nip, signal) => new Promise((_, reject) => {
    signal?.addEventListener("abort", () => {
      observedAbort = true;
      reject(new RegistryProviderError("TIMEOUT", "Synthetic abort"));
    }, { once: true });
  }));
  const service = new RegistryLookupService(provider, { timeoutMs: 10, maxRetries: 2 });

  await assert.rejects(service.lookupByNip(syntheticNip(0)), (error: unknown) => {
    assert.ok(error instanceof RegistryProviderError);
    assert.equal(error.code, "TIMEOUT");
    return true;
  });
  assert.equal(observedAbort, true);
  assert.equal(provider.calls.length, 1);
});

test("RegistryLookupService nie cache'uje złej odpowiedzi i odrzuca niepoprawny NIP przed providerem", async () => {
  const provider = new ScriptedProvider(async (nip) => ({ ...resultFor(nip), candidates: "not-an-array" } as unknown as RegistryProviderResult));
  const service = new RegistryLookupService(provider, { maxRetries: 2, sleep: async () => undefined });

  await assert.rejects(service.lookupByNip("123"), BadRequestException);
  await assert.rejects(service.lookupByNip(syntheticNip(0)), (error: unknown) => {
    assert.ok(error instanceof RegistryProviderError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  await assert.rejects(service.lookupByNip(syntheticNip(0)), (error: unknown) => {
    assert.ok(error instanceof RegistryProviderError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(provider.calls.length, 2, "błędna odpowiedź nie może trafić do cache ani retry");
});
