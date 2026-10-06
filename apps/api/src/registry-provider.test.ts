import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNip } from "@goldis/core";
import {
  RegistryProvider,
  RegistryProviderError,
  RegistryProviderErrorCode,
  RegistryProviderResult,
} from "./registry-provider";

const syntheticNip = normalizeNip("0000000000").normalized;
if (!syntheticNip) throw new Error("Synthetic NIP fixture must be checksum-valid");

const fixtureCandidates = {
  one: [{ nip: syntheticNip, regon: "000000000", name: "FIKCYJNY PODMIOT A", unitType: "MAIN" }],
  many: [
    { nip: syntheticNip, regon: "000000000", name: "FIKCYJNY PODMIOT A", unitType: "MAIN" },
    { nip: syntheticNip, regon: "000000001", name: "FIKCYJNY PODMIOT A — JEDNOSTKA", unitType: "LOCAL" },
  ],
} satisfies Record<string, readonly Readonly<Record<string, unknown>>[]>;

type FixtureScenario = "no-match" | "one-match" | "multiple-matches" | "provider-error" | "rate-limited";

/** Test double only. It has no HTTP client and is never registered in AppModule. */
class FixtureRegistryProvider implements RegistryProvider {
  readonly calls: string[] = [];

  constructor(private readonly scenario: FixtureScenario) {}

  async lookupByNip(nipNormalized: string, _signal?: AbortSignal): Promise<RegistryProviderResult> {
    this.calls.push(nipNormalized);
    if (nipNormalized !== syntheticNip) throw new Error("FIXTURE_NIP_MISMATCH");
    if (this.scenario === "provider-error") {
      throw new RegistryProviderError("UNAVAILABLE", "Synthetic provider failure");
    }
    if (this.scenario === "rate-limited") {
      throw new RegistryProviderError("RATE_LIMITED", "Synthetic provider limit", 30);
    }

    const candidates = this.scenario === "no-match" ? []
      : this.scenario === "one-match" ? fixtureCandidates.one
        : fixtureCandidates.many;
    return {
      providerName: "synthetic-registry",
      providerVersion: "fixture-1",
      dataVersion: "fixture-data-2026-01",
      fetchedAt: new Date("2026-01-15T12:00:00.000Z"),
      candidates,
    };
  }
}

test("RegistryProvider obsługuje 0, 1 i wiele surowych wyników bez sieci", async () => {
  const cases = [
    { scenario: "no-match" as const, expectedCount: 0 },
    { scenario: "one-match" as const, expectedCount: 1 },
    { scenario: "multiple-matches" as const, expectedCount: 2 },
  ];

  for (const { scenario, expectedCount } of cases) {
    const provider = new FixtureRegistryProvider(scenario);
    const result = await provider.lookupByNip(syntheticNip);
    assert.equal(result.candidates.length, expectedCount);
    assert.equal(result.providerName, "synthetic-registry");
    assert.equal(result.providerVersion, "fixture-1");
    assert.equal(result.dataVersion, "fixture-data-2026-01");
    assert.equal(result.fetchedAt.toISOString(), "2026-01-15T12:00:00.000Z");
    assert.deepEqual(provider.calls, [syntheticNip]);
  }
});

test("RegistryProvider zachowuje typowany błąd dostawcy", async () => {
  const provider = new FixtureRegistryProvider("provider-error");
  await assert.rejects(provider.lookupByNip(syntheticNip), (error: unknown) => {
    assert.ok(error instanceof RegistryProviderError);
    assert.equal(error.code, "UNAVAILABLE");
    assert.equal(error.retryAfterSeconds, null);
    return true;
  });
  assert.deepEqual(provider.calls, [syntheticNip]);
});

test("RegistryProvider zachowuje limit i czas wskazany przez dostawcę", async () => {
  const provider = new FixtureRegistryProvider("rate-limited");
  await assert.rejects(provider.lookupByNip(syntheticNip), (error: unknown) => {
    assert.ok(error instanceof RegistryProviderError);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.retryAfterSeconds, 30);
    return true;
  });
  assert.deepEqual(provider.calls, [syntheticNip]);
});

test("kody błędów kontraktu są jawnie ograniczone", () => {
  const allowed: readonly RegistryProviderErrorCode[] = ["RATE_LIMITED", "UNAVAILABLE", "TIMEOUT", "INVALID_RESPONSE"];
  for (const code of allowed) {
    assert.equal(new RegistryProviderError(code, "Synthetic contract test").code, code);
  }
  assert.throws(() => new RegistryProviderError("UNAVAILABLE", "Synthetic contract test", 1), /REGISTRY_PROVIDER_RETRY_AFTER_INVALID/);
  assert.throws(() => new RegistryProviderError("RATE_LIMITED", "Synthetic contract test", -1), /REGISTRY_PROVIDER_RETRY_AFTER_INVALID/);
});
