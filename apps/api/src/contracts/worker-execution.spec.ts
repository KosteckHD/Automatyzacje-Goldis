import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWorkerExecution, parseWorkerExecution } from "./worker-execution";

const execution = { executionId: "11111111-1111-4111-8111-111111111111", workerSessionId: "22222222-2222-4222-8222-222222222222" };
const now = Date.now();
const active = { ...execution, status: "reading_oc" as const, leaseExpiresAt: new Date(now + 60_000) };

test("result fence rejects stale, expired, cancelled and foreign worker executions", () => {
  assert.doesNotThrow(() => assertWorkerExecution(active, execution, ["reading_oc"], now));
  for (const changed of [
    { executionId: "33333333-3333-4333-8333-333333333333" },
    { workerSessionId: null }, { leaseExpiresAt: null },
    { leaseExpiresAt: new Date(now) }, { leaseExpiresAt: new Date(NaN) },
    { status: "cancelled" as const }, { status: "waiting_for_sms" as const },
  ]) assert.throws(() => assertWorkerExecution({ ...active, ...changed }, execution, ["reading_oc"], now), /WORKER_EXECUTION_CONFLICT/);
});

test("result execution contract rejects missing IDs, arrays and extra fields", () => {
  assert.deepEqual(parseWorkerExecution(execution), execution);
  for (const malformed of [null, [], {}, { ...execution, executionId: "bad" }, { ...execution, runId: "extra" }]) {
    assert.throws(() => parseWorkerExecution(malformed), /WORKER_EXECUTION_CONFLICT/);
  }
});
