import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { AutomationRun } from "../../infrastructure/database/db";
import type { WorkerCodeForwarder } from "../interventions/public";
import type { RunDispatchService } from "./run-dispatch.service";
import type { RunResumeRepository } from "./run-resume.repository";
import { RunResumeService } from "./run-resume.service";

const runId = "22222222-2222-4222-8222-222222222222";
const actor = { tenantId: "99999999-9999-4999-8999-999999999999", actorUserId: "11111111-1111-4111-8111-111111111111" };
const challengeId = "44444444-4444-4444-8444-444444444444";

function createRun(overrides: Partial<AutomationRun> = {}) {
  return {
    id: runId,
    batchId: "33333333-3333-4333-8333-333333333333",
    rowNumber: 18001,
    toolId: "oc-verification",
    status: "waiting_for_sms",
    currentStep: "waiting_for_sms",
    referenceDate: "2026-10-16",
    errorCode: "SMS_CODE_REJECTED",
    manualDataVersion: 0,
    controlState: "running",
    controlRevision: "0",
    controlAckRevision: "0",
    controlCheckpointStatus: null,
    startedByUserId: actor.actorUserId,
    currentAuthChallengeId: challengeId,
    authCycleId: "55555555-5555-4555-8555-555555555555",
    authCyclePortal: "pzu",
    authCycleStartedAt: new Date("2026-10-16T10:00:00.000Z"),
    authCycleExpiresAt: new Date("2026-10-16T10:05:00.000Z"),
    pzuSmsRetryCount: 0,
    compensaSmsRetryCount: 0,
    lastSafeStep: null,
    externalCaseRef: null,
    createdAt: new Date("2026-10-16T10:00:00.000Z"),
    updatedAt: new Date("2026-10-16T10:01:00.000Z"),
    ...overrides,
  } as unknown as AutomationRun;
}

function createService(
  run: AutomationRun,
  incident: Record<string, unknown>,
  activeChallenge: Record<string, unknown> | null = null,
) {
  const calls: string[] = [];
  const repository = {
    async transaction<T>(work: (transaction: object) => Promise<T>) {
      const result = await work({});
      calls.push("transaction-committed");
      return result;
    },
    async lockRun(id: string) {
      calls.push(`lock:${id}`);
      return run;
    },
    async findSmsIntervention() {
      return incident;
    },
    async findLatestOpenIntervention() {
      return incident;
    },
    async findActiveAuthChallenge() {
      return activeChallenge;
    },
    async findManualDataOverride() {
      return { version: 1, fields: { expectedPersonName: "Jan Kowalski" } };
    },
    async saveAuthChallenge() {
      calls.push("save-challenge");
    },
    async saveRun() {
      calls.push("save-run");
    },
    async saveIntervention() {
      calls.push("save-intervention");
    },
    async createActivity() {
      calls.push("activity");
    },
    async createEvent(values: Record<string, unknown>) {
      calls.push(`event:${values.step}`);
    },
    async recordAudit(values: Record<string, unknown>) {
      calls.push(`audit:${values.action}`);
    },
  };
  const dispatch = {
    async ensureDispatch(id: string, intent: string) {
      calls.push(`dispatch:${id}:${intent}`);
    },
    async publishOutbox() {
      calls.push("publish-outbox");
    },
  };
  const codeForwarder = {
    async invalidate(id: string) {
      calls.push(`invalidate:${id}`);
    },
  };
  return {
    service: new RunResumeService(
      repository as unknown as RunResumeRepository,
      dispatch as unknown as RunDispatchService,
      codeForwarder as unknown as WorkerCodeForwarder,
    ),
    calls,
  };
}

test("RunResumeService validates the run ID before opening a transaction", async () => {
  const incident = { portal: "pzu", reasonCode: "SMS_CODE_REJECTED" };
  const { service, calls } = createService(createRun(), incident);
  await assert.rejects(service.resumeAuth("invalid", actor), (error: unknown) => error instanceof BadRequestException);
  assert.deepEqual(calls, []);
});

test("resumeAuth retries the allowed SMS and invalidates its old challenge after commit", async () => {
  const incident = {
    interventionId: "66666666-6666-4666-8666-666666666666",
    challengeId,
    portal: "pzu",
    reasonCode: "SMS_CODE_REJECTED",
    status: "open",
    revision: 4,
    assigneeUserId: null,
    priority: "normal",
  };
  const activeChallenge = { challengeId, status: "active", updatedAt: new Date() };
  const { service, calls } = createService(createRun(), incident, activeChallenge);
  const response = await service.resumeAuth(runId, actor);

  assert.equal(response.status, "pzu_login");
  assert.equal(response.errorCode, "SMS_RETRY_QUEUED");
  assert.equal(response.controlState, "running");
  assert.equal(calls.indexOf("transaction-committed") < calls.indexOf(`invalidate:${challengeId}`), true);
  assert.equal(calls.indexOf(`invalidate:${challengeId}`) < calls.indexOf("publish-outbox"), true);
  assert.equal(calls.includes(`dispatch:${runId}:resume_auth`), true);
  assert.equal(calls.includes("event:auth_retry_queued"), true);
});

test("resumeReview requires the current manual correction and resumes at the identity step", async () => {
  const run = createRun({
    status: "identity_review",
    currentStep: "identity_review",
    errorCode: "IDENTITY_REVIEW",
    manualDataVersion: 1,
    currentAuthChallengeId: null,
  });
  const incident = {
    interventionId: "66666666-6666-4666-8666-666666666666",
    fieldCode: "EXPECTED_PERSON",
    portal: null,
    kind: "manual_data",
    reasonCode: "IDENTITY_REVIEW",
    status: "open",
    revision: 4,
    assigneeUserId: null,
    priority: "normal",
  };
  const { service, calls } = createService(run, incident);
  const response = await service.resumeReview(runId, actor);

  assert.equal(response.status, "everest_search");
  assert.equal(response.errorCode, "REVIEW_RETRY_QUEUED");
  assert.equal(calls.includes(`dispatch:${runId}:resume_review`), true);
  assert.equal(calls.includes("event:manual_review_resumed"), true);
  assert.equal(calls.includes("publish-outbox"), true);
});

test("PZU session review starts a fresh login without reusing the invalidated MFA cycle", async () => {
  const run = createRun({ status: "waiting_for_manual_data", errorCode: "SMS_DELIVERY_UNCERTAIN" });
  const incident = { interventionId: "66666666-6666-4666-8666-666666666666",
    kind: "sms", portal: "pzu", reasonCode: "SMS_DELIVERY_UNCERTAIN", fieldCode: null,
    status: "open", revision: 1, assigneeUserId: null, priority: "normal" };
  const { service, calls } = createService(run, incident);
  const result = await service.resumeReview(runId, actor);
  assert.equal(result.status, "pzu_login");
  assert.equal(run.currentAuthChallengeId, null);
  assert.equal(run.authCycleId, null);
  assert.equal(run.authCycleExpiresAt, null);
  assert.equal(run.pzuSmsRetryCount, 0, "session recheck does not request an additional SMS");
  assert.equal(calls.includes(`dispatch:${runId}:resume_review`), true);
  assert.equal(calls.some(call => call.startsWith("invalidate:")), false);
});

for (const status of ["active", "claimed", "submitted"] as const) {
  test(`PZU session review refuses to replace a ${status} code handoff`, async () => {
    const run = createRun({ status: "waiting_for_manual_data", errorCode: "SMS_DELIVERY_UNCERTAIN" });
    const incident = { kind: "sms", portal: "pzu", reasonCode: "SMS_DELIVERY_UNCERTAIN", fieldCode: null };
    const { service, calls } = createService(run, incident, { challengeId, status });
    await assert.rejects(service.resumeReview(runId, actor));
    assert.equal(calls.includes("save-run"), false);
    assert.equal(calls.includes("publish-outbox"), false);
  });
}

test("PZU session review cannot replace a worker execution or act for another run starter", async () => {
  const incident = { kind: "sms", portal: "pzu", reasonCode: "SMS_DELIVERY_UNCERTAIN", fieldCode: null };
  for (const patch of [
    { executionId: "77777777-7777-4777-8777-777777777777" },
    { leaseExpiresAt: new Date(Date.now() + 60_000) },
    { startedByUserId: "88888888-8888-4888-8888-888888888888" },
  ]) {
    const run = createRun({ status: "waiting_for_manual_data", errorCode: "SMS_DELIVERY_UNCERTAIN", ...patch });
    const { service, calls } = createService(run, incident);
    await assert.rejects(service.resumeReview(runId, actor));
    assert.equal(calls.includes("save-run"), false);
  }
});

test("a reviewed technical failure without a case restarts PZU rather than guessing a Compensa checkpoint", async () => {
  const run = createRun({ status: "waiting_for_manual_data", errorCode: "PORTAL_FAILURE" });
  const incident = { interventionId: "66666666-6666-4666-8666-666666666666",
    kind: "portal_error", portal: null, reasonCode: "PORTAL_FAILURE", fieldCode: null,
    status: "open", revision: 1, assigneeUserId: null, priority: "normal" };
  const { service, calls } = createService(run, incident);
  const result = await service.resumeReview(runId, actor);
  assert.equal(result.status, "pzu_login");
  assert.equal(run.currentAuthChallengeId, null);
  assert.equal(calls.includes(`dispatch:${runId}:resume_review`), true);
});

for (const reasonCode of ["PORTAL_FAILURE", "PORTAL_SESSION_EXPIRED", "PORTAL_SCHEMA_CHANGED"]) {
  test(`reviewed PZU ${reasonCode} can start a fresh entry after the previous worker has stopped`, async () => {
    const incident = { interventionId: "66666666-6666-4666-8666-666666666666", kind: "portal_error",
      portal: "pzu", reasonCode, fieldCode: null, status: "open", revision: 1, assigneeUserId: null, priority: "normal" };
    const run = createRun({ status: "waiting_for_manual_data", errorCode: reasonCode });
    const { service, calls } = createService(run, incident);
    const result = await service.resumeReview(runId, actor);
    assert.equal(result.status, "pzu_login");
    assert.equal(run.currentAuthChallengeId, null);
    assert.equal(run.authCycleId, null);
    assert.equal(calls.includes(`dispatch:${runId}:resume_review`), true);
    for (const activeChallenge of [{ challengeId, status: "active" }, { challengeId, status: "submitted" }]) {
      const blockedRun = createRun({ status: "waiting_for_manual_data", errorCode: reasonCode });
      const blocked = createService(blockedRun, { ...incident, status: "open" }, activeChallenge);
      await assert.rejects(blocked.service.resumeReview(runId, actor));
      assert.equal(blocked.calls.includes("save-run"), false);
    }
  });
}
