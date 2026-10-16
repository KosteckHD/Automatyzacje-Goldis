import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { AutomationRun } from "../../infrastructure/database/db";
import type { WorkerCodeForwarder } from "../interventions/public";
import type { RunCancellationRepository } from "./run-cancellation.repository";
import { RunCancellationService } from "./run-cancellation.service";

const runId = "22222222-2222-4222-8222-222222222222";
const actor = { tenantId: "99999999-9999-4999-8999-999999999999", actorUserId: "11111111-1111-4111-8111-111111111111" };
const run = {
  id: runId,
  batchId: "33333333-3333-4333-8333-333333333333",
  rowNumber: 18001,
  toolId: "oc-verification",
  status: "cancelled",
  currentStep: "cancelled",
  referenceDate: "2026-10-16",
  errorCode: null,
  manualDataVersion: 0,
  controlState: "running",
  controlRevision: "1",
  controlAckRevision: "0",
  controlCheckpointStatus: null,
  createdAt: new Date("2026-10-16T10:00:00.000Z"),
  updatedAt: new Date("2026-10-16T10:01:00.000Z"),
} as unknown as AutomationRun;

test("RunCancellationService validates the identifier and delegates the durable transition", async () => {
  const calls: string[] = [];
  const repository = {
    async cancel(id: string, requestedActor: typeof actor) {
      calls.push(`cancel:${id}:${requestedActor.actorUserId}`);
      return { run, invalidatedChallengeId: null };
    },
  };
  const forwarder = {
    async invalidate(id: string) {
      calls.push(`invalidate:${id}`);
    },
  };
  const service = new RunCancellationService(
    repository as unknown as RunCancellationRepository,
    forwarder as unknown as WorkerCodeForwarder,
  );

  await assert.rejects(service.cancel("invalid", actor), (error: unknown) => error instanceof BadRequestException);
  assert.deepEqual(calls, []);

  const result = await service.cancel(runId, actor);
  assert.equal(result.id, runId);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, [`cancel:${runId}:${actor.actorUserId}`]);
});

test("RunCancellationService invalidates the worker code only after the repository transaction succeeds", async () => {
  const calls: string[] = [];
  const repository = {
    async cancel() {
      calls.push("transaction-committed");
      return { run, invalidatedChallengeId: "44444444-4444-4444-8444-444444444444" };
    },
  };
  const forwarder = {
    async invalidate(id: string) {
      calls.push(`invalidate:${id}`);
    },
  };
  const service = new RunCancellationService(
    repository as unknown as RunCancellationRepository,
    forwarder as unknown as WorkerCodeForwarder,
  );

  await service.cancel(runId, actor);
  assert.deepEqual(calls, ["transaction-committed", "invalidate:44444444-4444-4444-8444-444444444444"]);
});
