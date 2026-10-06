import assert from "node:assert/strict";
import { test } from "node:test";
import { automationReadiness } from "./health-readiness";

const now = Date.parse("2026-10-02T10:00:00.000Z");

test("automation is ready only with available services and fresh live worker config", () => {
  const ready = automationReadiness({
    servicesReady: true, now,
    worker: { mode: "live", portalConfigValid: true, observedAt: new Date(now - 10_000) },
  });
  assert.equal(ready.automationReady, true);
  assert.equal(ready.worker, "online");
  assert.equal(ready.portalConfig, "valid");
});

test("off, stale, future, invalid-config, or unavailable services report specific safe readiness", () => {
  const worker = { mode: "off" as const, portalConfigValid: false, observedAt: new Date(now) };
  assert.equal(automationReadiness({ servicesReady: true, worker, now }).message, "Portale wyłączone.");
  assert.equal(automationReadiness({ servicesReady: true, worker: { ...worker, mode: "live", portalConfigValid: false }, now }).message,
    "Konfiguracja portali nie jest gotowa.");
  assert.equal(automationReadiness({ servicesReady: true, worker, now: now + 30_001 }).worker, "offline");
  assert.equal(automationReadiness({ servicesReady: true, worker, now: now - 1 }).worker, "offline");
  assert.equal(automationReadiness({ servicesReady: false, worker, now }).message, "Sprawdź dostępność API, bazy i kolejki.");
});
