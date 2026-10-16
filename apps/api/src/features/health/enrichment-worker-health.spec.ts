import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichmentWorkerHealth } from "./enrichment-worker-health";

const now = Date.parse("2026-10-07T12:00:00.000Z");

test("enrichment health distinguishes offline, disabled, configured and degraded worker states", () => {
  assert.deepEqual(enrichmentWorkerHealth({ worker: null, now }), {
    status: "not_ready",
    available: false,
    worker: "offline",
    provider: "unknown",
    providerName: null,
    message: "Worker wzbogacania nie odpowiada.",
  });
  assert.deepEqual(
    enrichmentWorkerHealth({
      worker: { status: "disabled", providerName: null, observedAt: new Date(now) },
      now,
    }),
    {
      status: "ready",
      available: true,
      worker: "disabled",
      provider: "disabled",
      providerName: null,
      message: "Worker działa; dostawca rejestru jest wyłączony.",
    },
  );
  assert.deepEqual(
    enrichmentWorkerHealth({
      worker: { status: "ready", providerName: "mf-vat", observedAt: new Date(now) },
      now,
    }),
    {
      status: "ready",
      available: true,
      worker: "ready",
      provider: "configured",
      providerName: "mf-vat",
      message: "Worker wzbogacania odpowiada.",
    },
  );
  assert.equal(
    enrichmentWorkerHealth({
      worker: { status: "degraded", providerName: "mf-vat", observedAt: new Date(now) },
      now,
    }).available,
    false,
  );
  assert.equal(
    enrichmentWorkerHealth({
      worker: { status: "ready", providerName: "gus-bir", observedAt: new Date(now) },
      now,
    }).providerName,
    "gus-bir",
  );
  assert.equal(
    enrichmentWorkerHealth({
      worker: { status: "ready", providerName: "mf-vat", observedAt: new Date(now - 31_000) },
      now,
    }).worker,
    "offline",
  );
  assert.equal(
    enrichmentWorkerHealth({
      worker: { status: "ready", providerName: "gus-bir", observedAt: new Date(now - 31_000) },
      now,
    }).providerName,
    null,
  );
});
