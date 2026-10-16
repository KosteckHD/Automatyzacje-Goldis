import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationRun } from "../../infrastructure/database/db";
import type { RunDispatchService } from "./run-dispatch.service";
import type { RunRecoveryRepository } from "./run-recovery.repository";
import { RunRecoveryService } from "./run-recovery.service";

const runId = "22222222-2222-4222-8222-222222222222";

function createRun(overrides: Partial<AutomationRun> = {}) {
  return {
    id: runId,
    status: "queued",
    technicalAttemptCount: 0,
    ...overrides,
  } as unknown as AutomationRun;
}

function createService(run: AutomationRun, resultRuns: AutomationRun[] = []) {
  const calls: Array<{ name: string; values?: unknown[] }> = [];
  const transaction = {};
  const repository = {
    async transaction<T>(work: (transaction: object) => Promise<T>) {
      return work(transaction);
    },
    async findResultRuns() {
      calls.push({ name: "find-result-runs" });
      return resultRuns;
    },
    async findOrphanCandidates() {
      calls.push({ name: "find-orphans" });
      return [run];
    },
    async withRecoverableRun(id: string, work: (run: AutomationRun, transaction: object) => Promise<void>) {
      calls.push({ name: `lock:${id}` });
      return work(run, transaction);
    },
    async requireManualReview(...values: unknown[]) {
      calls.push({ name: "manual-review", values });
    },
    async scheduleRecovery(...values: unknown[]) {
      calls.push({ name: "schedule", values });
    },
  };
  const dispatch = {
    async ensureDispatch(...values: unknown[]) {
      calls.push({ name: "ensure-dispatch", values });
    },
    async recoverPublishedOutbox() {
      calls.push({ name: "recover-published" });
    },
    async publishOutbox() {
      calls.push({ name: "publish-outbox" });
    },
  };
  return {
    service: new RunRecoveryService(
      repository as unknown as RunRecoveryRepository,
      dispatch as unknown as RunDispatchService,
    ),
    calls,
  };
}

test("RunRecoveryService requeues the first orphan attempt with the existing delay and intent", async () => {
  const { service, calls } = createService(createRun());
  await service.reconcile();

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["find-result-runs", "recover-published", "find-orphans", `lock:${runId}`, "schedule", "publish-outbox"],
  );
  assert.deepEqual(calls.find(({ name }) => name === "schedule")?.values?.slice(1, 4), [1, "recovery", 5_000]);
});

test("RunRecoveryService routes exhausted orphan retries to operator review", async () => {
  const run = createRun({ status: "reading_oc", technicalAttemptCount: 2 });
  const { service, calls } = createService(run);
  await service.reconcile();

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["find-result-runs", "recover-published", "find-orphans", `lock:${runId}`, "manual-review", "publish-outbox"],
  );
  assert.equal(calls.find(({ name }) => name === "manual-review")?.values?.[1], 2);
});

test("RunRecoveryService gives result checkpoints the result-only recovery intent", async () => {
  const run = createRun({ status: "reading_oc", technicalAttemptCount: 0 });
  const { service, calls } = createService(run);
  await service.reconcile();

  assert.equal(calls.find(({ name }) => name === "schedule")?.values?.[2], "result_delivery");
});

test("RunRecoveryService restores result-only dispatches through the dispatch feature", async () => {
  const resultRun = createRun({ id: "33333333-3333-4333-8333-333333333333", status: "export_ready" });
  const { service, calls } = createService(createRun(), [resultRun]);
  await service.ensureResultDispatches();

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["find-result-runs", "ensure-dispatch"],
  );
  assert.equal(calls.find(({ name }) => name === "ensure-dispatch")?.values?.[0], resultRun.id);
  assert.equal(calls.find(({ name }) => name === "ensure-dispatch")?.values?.[1], "result_delivery");
});
