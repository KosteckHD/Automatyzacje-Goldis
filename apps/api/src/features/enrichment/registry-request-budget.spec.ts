import assert from "node:assert/strict";
import { test } from "node:test";
import { type RegistryProvider, RegistryProviderError, type RegistryProviderResult } from "./registry-provider";
import { BudgetedRegistryProvider, secondsUntilNextWarsawDay } from "./registry-request-budget";

const result: RegistryProviderResult = {
  providerName: "synthetic",
  providerVersion: "fixture",
  dataVersion: null,
  fetchedAt: new Date("2026-10-07T12:00:00Z"),
  candidates: [],
};

test("budget wrapper reserves by Warsaw day before each external lookup", async () => {
  const reservations: Array<{ provider: string; date: string; limit: number }> = [];
  let calls = 0;
  const provider: RegistryProvider = {
    async lookupByNip() {
      calls += 1;
      return result;
    },
  };
  const budget = new BudgetedRegistryProvider(provider, "mf-vat", {
    dailyLimit: 2,
    now: () => new Date("2026-10-06T22:30:00.000Z"),
    reserve: async (name, date, limit) => {
      reservations.push({ provider: name, date, limit });
      return reservations.length <= 2;
    },
  });
  await budget.lookupByNip("0000000000");
  await budget.lookupByNip("0000000000");
  await assert.rejects(budget.lookupByNip("0000000000"), (error: unknown) => {
    assert.ok(error instanceof RegistryProviderError);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.retryAfterSeconds, 84_600);
    return true;
  });
  assert.deepEqual(reservations, [
    { provider: "mf-vat", date: "2026-10-07", limit: 2 },
    { provider: "mf-vat", date: "2026-10-07", limit: 2 },
    { provider: "mf-vat", date: "2026-10-07", limit: 2 },
  ]);
  assert.equal(calls, 2);
});

test("budget wrapper reserves one search slot for one real batch request", async () => {
  let reservations = 0;
  let batchCalls = 0;
  const provider: RegistryProvider = {
    async lookupByNip() {
      throw new Error("SINGLE_LOOKUP_SHOULD_NOT_RUN");
    },
    async lookupManyByNip(nips) {
      batchCalls += 1;
      return new Map(
        nips.map((nip) => [nip, { kind: "result", result: { ...result, candidates: [{ nip, name: "SYNTHETIC" }] } }]),
      );
    },
  };
  const budget = new BudgetedRegistryProvider(provider, "mf-vat", {
    dailyLimit: 1,
    now: () => new Date("2026-10-07T12:00:00Z"),
    reserve: async () => {
      reservations += 1;
      return reservations === 1;
    },
  });
  const nips = ["0000000000", "1111111111"];
  const resultMap = await budget.lookupManyByNip(nips);
  assert.equal(resultMap.size, 2);
  assert.equal(reservations, 1);
  assert.equal(batchCalls, 1);
  const limited = await budget.lookupManyByNip(nips);
  assert.equal(limited.size, 2);
  for (const outcome of limited.values()) {
    assert.equal(outcome.kind, "error");
    if (outcome.kind === "error") assert.equal(outcome.error.code, "RATE_LIMITED");
  }
  assert.equal(batchCalls, 1, "no request is sent when the daily batch budget is exhausted");
});

test("budget wrapper chunks a provider request to its advertised upstream maximum", async () => {
  const reservations: number[] = [];
  const chunks: string[][] = [];
  const provider: RegistryProvider = {
    maxBatchSize: 2,
    async lookupByNip() {
      throw new Error("SINGLE_LOOKUP_SHOULD_NOT_RUN");
    },
    async lookupManyByNip(nips) {
      chunks.push([...nips]);
      return new Map(
        nips.map((nip) => [nip, { kind: "result", result: { ...result, candidates: [{ nip, name: "SYNTHETIC" }] } }]),
      );
    },
  };
  const budget = new BudgetedRegistryProvider(provider, "gus-bir", {
    dailyLimit: 3,
    now: () => new Date("2026-10-07T12:00:00Z"),
    reserve: async () => {
      reservations.push(reservations.length + 1);
      return true;
    },
  });
  const nips = ["0000000000", "1111111111", "2222222222", "3333333333", "4444444444"];
  const outcomes = await budget.lookupManyByNip(nips);
  assert.equal(outcomes.size, 5);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [2, 2, 1],
  );
  assert.equal(reservations.length, 3);
  assert.equal(budget.maxBatchSize, 2);
});

test("next Warsaw quota day respects the DST transition", () => {
  assert.equal(secondsUntilNextWarsawDay(new Date("2026-03-29T00:30:00Z")), 77_400);
  assert.equal(secondsUntilNextWarsawDay(new Date("2026-10-25T00:30:00Z")), 81_000);
});

test("invalid provider names and quota configuration are rejected", () => {
  const provider: RegistryProvider = {
    async lookupByNip() {
      return result;
    },
  };
  assert.throws(() => new BudgetedRegistryProvider(provider, "MF VAT"), /REGISTRY_BUDGET_PROVIDER_INVALID/);
  assert.throws(
    () => new BudgetedRegistryProvider(provider, "mf-vat", { dailyLimit: 0 }),
    /REGISTRY_BUDGET_LIMIT_INVALID/,
  );
});
