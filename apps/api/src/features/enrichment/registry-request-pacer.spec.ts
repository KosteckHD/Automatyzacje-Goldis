import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryProviderError } from "./registry-provider";
import { RegistryRequestPacer } from "./registry-request-pacer";

test("independent provider clients serialize actual HTTP starts through shared slot reservations", async () => {
  let nextAvailableAt = 0;
  const reserveSlot = async (_provider: string, intervalMs: number, now: Date) => {
    const slotAt = Math.max(nextAvailableAt, now.getTime());
    nextAvailableAt = slotAt + intervalMs;
    return new Date(slotAt);
  };
  const starts: number[] = [];
  const fakeFetch: typeof fetch = async () => {
    starts.push(Date.now());
    return new Response(null, { status: 200 });
  };
  const dependencies = { reserveSlot, saveCooldown: async () => undefined };
  const firstWorker = new RegistryRequestPacer("gus-bir", 40, dependencies).wrap(fakeFetch);
  const secondWorker = new RegistryRequestPacer("gus-bir", 40, dependencies).wrap(fakeFetch);

  await Promise.all([firstWorker("https://fixture.invalid"), secondWorker("https://fixture.invalid")]);
  assert.equal(starts.length, 2);
  assert.ok(Math.abs(starts[1] - starts[0]) >= 25, "provider clients must not start requests together");
});

test("HTTP 429 stores both numeric and HTTP-date Retry-After as shared cooldowns", async () => {
  const now = new Date("2026-10-09T10:00:00.000Z");
  const cooldowns: Date[] = [];
  const pacer = new RegistryRequestPacer("mf-vat", 1, {
    now: () => now,
    reserveSlot: async () => now,
    saveCooldown: async (_provider, _interval, until) => {
      cooldowns.push(until);
    },
  });
  const numeric = pacer.wrap(async () => new Response(null, { status: 429, headers: { "retry-after": "2" } }));
  await numeric("https://fixture.invalid");
  const dateRetry = new Date(now.getTime() + 3_000).toUTCString();
  const date = pacer.wrap(async () => new Response(null, { status: 429, headers: { "retry-after": dateRetry } }));
  await date("https://fixture.invalid");

  assert.deepEqual(
    cooldowns.map((value) => value.getTime()),
    [now.getTime() + 2_000, now.getTime() + 3_000],
  );
});

test("cancellation while queued releases the request without calling the provider", async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  const now = new Date();
  const pacer = new RegistryRequestPacer("gus-bir", 1000, {
    now: () => now,
    reserveSlot: async () => new Date(now.getTime() + 10_000),
    saveCooldown: async () => undefined,
  });
  const fetch = pacer.wrap(async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  });
  setTimeout(() => controller.abort(), 10).unref();

  await assert.rejects(
    fetch("https://fixture.invalid", { signal: controller.signal }),
    (error: unknown) => error instanceof RegistryProviderError && error.code === "TIMEOUT",
  );
  assert.equal(fetchCalls, 0);
});

test("provider pacing configuration is bounded and explicit", () => {
  assert.throws(() => new RegistryRequestPacer("bad/provider", 1000), /REGISTRY_REQUEST_PACER_PROVIDER_INVALID/);
  assert.throws(() => new RegistryRequestPacer("gus-bir", 0), /REGISTRY_REQUEST_PACER_INTERVAL_INVALID/);
  assert.throws(() => new RegistryRequestPacer("gus-bir", 60_001), /REGISTRY_REQUEST_PACER_INTERVAL_INVALID/);
});
