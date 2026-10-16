import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { AutomationRun } from "../../infrastructure/database/db";
import type { RunControlRepository } from "./run-control.repository";
import { RunControlService } from "./run-control.service";
import type { RunDispatchService } from "./run-dispatch.service";

const runId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const actorUserId = "11111111-1111-4111-8111-111111111111";
const actor = { tenantId, actorUserId };

function createRun(overrides: Partial<AutomationRun> = {}) {
  return {
    id: runId,
    batchId: "33333333-3333-4333-8333-333333333333",
    rowNumber: 18001,
    toolId: "oc-verification",
    status: "queued",
    currentStep: "queued",
    referenceDate: "2026-10-16",
    errorCode: null,
    manualDataVersion: 0,
    controlState: "running",
    controlRevision: "0",
    controlAckRevision: "0",
    controlCheckpointStatus: null,
    controlRequestedBy: null,
    controlRequestedAt: null,
    controlAcknowledgedAt: null,
    executionId: null,
    workerSessionId: null,
    leaseExpiresAt: null,
    createdAt: new Date("2026-10-16T10:00:00.000Z"),
    updatedAt: new Date("2026-10-16T10:01:00.000Z"),
    ...overrides,
  } as unknown as AutomationRun;
}

function createService(run: AutomationRun) {
  const calls: Array<{ name: string; values?: Record<string, unknown> }> = [];
  let storedRequest: { action: string; expectedRevision: string; response: Record<string, unknown> } | null = null;
  const repository = {
    async transaction<T>(work: (transaction: object) => Promise<T>) {
      return work({});
    },
    async lockRun(id: string) {
      calls.push({ name: `lock:${id}` });
      return run;
    },
    async findTenantId() {
      return tenantId;
    },
    async findControlRequest() {
      return storedRequest;
    },
    async saveRun() {
      calls.push({ name: "save" });
    },
    async cancelPendingDispatches() {
      calls.push({ name: "cancel-dispatches" });
    },
    async createEvent(values: Record<string, unknown>) {
      calls.push({ name: "event", values });
    },
    async recordAudit(values: Record<string, unknown>) {
      calls.push({ name: "audit", values });
    },
    async storeControlRequest(
      _runId: string,
      _actor: unknown,
      action: string,
      request: { expectedRevision: string },
      _revision: string,
      response: Record<string, unknown>,
    ) {
      calls.push({ name: "store-control-request" });
      storedRequest = { action, expectedRevision: request.expectedRevision, response };
    },
  };
  const dispatch = {
    async ensureDispatch(id: string, intent: string) {
      calls.push({ name: `dispatch:${id}:${intent}` });
    },
    async publishOutbox() {
      calls.push({ name: "publish-outbox" });
    },
  };
  return {
    service: new RunControlService(
      repository as unknown as RunControlRepository,
      dispatch as unknown as RunDispatchService,
    ),
    calls,
  };
}

test("RunControlService validates the run ID before opening a transaction", async () => {
  const { service, calls } = createService(createRun());
  await assert.rejects(
    service.pause("invalid", actor, { expectedRevision: "0", idempotencyKey: "pause-request-0001" }),
    (error: unknown) => error instanceof BadRequestException,
  );
  assert.deepEqual(calls, []);
});

test("pause without an active worker commits an acknowledged pause and durable control record", async () => {
  const { service, calls } = createService(createRun());
  const response = await service.pause(runId, actor, {
    expectedRevision: "0",
    idempotencyKey: "pause-request-0001",
  });

  assert.equal(response.controlState, "paused");
  assert.equal(response.controlRevision, "1");
  assert.equal(response.controlAckRevision, "1");
  assert.deepEqual(
    calls.map(({ name }) => name),
    [`lock:${runId}`, "save", "cancel-dispatches", "event", "audit", "store-control-request"],
  );
  assert.equal(calls.find(({ name }) => name === "event")?.values?.step, "paused_without_active_lease");
  assert.equal(calls.find(({ name }) => name === "audit")?.values?.action, "run.pause_requested");
});

test("pause with a live worker requests a safe-boundary acknowledgement without cancelling its dispatch", async () => {
  const run = createRun({
    status: "compensa_form",
    currentStep: "compensa_form",
    controlRevision: "1",
    executionId: "44444444-4444-4444-8444-444444444444",
    workerSessionId: "55555555-5555-4555-8555-555555555555",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const { service, calls } = createService(run);
  const response = await service.pause(runId, actor, {
    expectedRevision: "1",
    idempotencyKey: "pause-request-0002",
  });

  assert.equal(response.controlState, "pause_requested");
  assert.equal(response.controlRevision, "2");
  assert.ok(!calls.some(({ name }) => name === "cancel-dispatches"));
  assert.equal(calls.find(({ name }) => name === "event")?.values?.step, "pause_requested");
});

test("resume advances revision, persists recovery intent, and publishes after transaction", async () => {
  const { service, calls } = createService(
    createRun({
      controlState: "paused",
      controlRevision: "1",
      controlAckRevision: "1",
    }),
  );
  const response = await service.resumePaused(runId, actor, {
    expectedRevision: "1",
    idempotencyKey: "resume-request-0001",
  });

  assert.equal(response.controlState, "running");
  assert.equal(response.controlRevision, "2");
  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      `lock:${runId}`,
      "save",
      `dispatch:${runId}:recovery`,
      "event",
      "audit",
      "store-control-request",
      "publish-outbox",
    ],
  );
  assert.equal(calls.find(({ name }) => name === "event")?.values?.step, "resumed_from_pause");
  assert.equal(calls.find(({ name }) => name === "audit")?.values?.action, "run.resumed_from_pause");
});
