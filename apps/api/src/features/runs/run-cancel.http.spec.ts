import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const sessionSecret = "run-cancel-http-synthetic-session-secret";
const csrfToken = "synthetic-csrf-token-for-run-cancel-tests-123456";
const runId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const tenantId = "99999999-9999-4999-8999-999999999999";
const batchId = "33333333-3333-4333-8333-333333333333";

function signedCookie(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000, userId, tenantId, csrf: csrfToken })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrfToken}`;
}

test("POST /api/runs/:id/cancel wymaga CSRF i przekazuje anulowanie", async () => {
  const oldSecret = process.env.SESSION_SECRET;
  const oldDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const cancelled: string[] = [];
  const resumed: unknown[][] = [];
  const reviewed: unknown[][] = [];
  const created: unknown[][] = [];
  const pauseCalls: unknown[][] = [];
  const runResumeCalls: unknown[][] = [];
  try {
    const { RunController } = await import("./runs.controller");
    const { RunService } = await import("./runs.service");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("../auth");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("../authorization");
    const service = {
      async create(...args: unknown[]) {
        created.push(args);
        return { id: runId, batchId, rowNumber: 18001, status: "queued", currentStep: "queued" };
      },
      async cancel(id: string) {
        cancelled.push(id);
        return { id, status: "cancelled", currentStep: "cancelled" };
      },
      async resumeAuth(...args: unknown[]) {
        resumed.push(args);
        return { id: runId, status: "pzu_login", errorCode: "SMS_RETRY_QUEUED" };
      },
      async resumeReview(...args: unknown[]) {
        reviewed.push(args);
        return { id: runId, status: "everest_search", errorCode: "REVIEW_RETRY_QUEUED" };
      },
      async pause(...args: unknown[]) {
        pauseCalls.push(args);
        return { id: runId, status: "compensa_form", controlState: "pause_requested", controlRevision: "1" };
      },
      async resumePaused(...args: unknown[]) {
        runResumeCalls.push(args);
        return { id: runId, status: "compensa_form", controlState: "running", controlRevision: "2" };
      },
    };
    @Module({
      controllers: [RunController],
      providers: [
        SessionGuard,
        PermissionGuard,
        {
          provide: SESSION_ROLE_RESOLVER,
          useValue: async (requestedUserId: string, requestedTenantId: string) =>
            requestedUserId === userId && requestedTenantId === tenantId ? "admin" : null,
        },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        {
          provide: PERMISSION_RESOURCE_RESOLVER,
          useValue: async (selector: string, request: { params?: { id?: string }; body?: { batchId?: string } }) =>
            (selector === "route-run" && request.params?.id === runId) ||
            (selector === "body-batch" && request.body?.batchId === batchId)
              ? { resourceTenantId: tenantId, resourceOwnerId: userId }
              : null,
        },
        { provide: RunService, useValue: service },
      ],
    })
    class RunCancelHttpTestModule {}

    app = await NestFactory.create(RunCancelHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/runs/${runId}/cancel`;

    const missingStartCsrf = await fetch(`http://127.0.0.1:${address.port}/api/runs`, {
      method: "POST",
      headers: { cookie: signedCookie(), "content-type": "application/json" },
      body: JSON.stringify({ batchId, rowNumber: 18001 }),
    });
    assert.equal(missingStartCsrf.status, 403);
    assert.deepEqual(created, []);
    const startAccepted = await fetch(`http://127.0.0.1:${address.port}/api/runs`, {
      method: "POST",
      headers: { cookie: signedCookie(), "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ batchId, rowNumber: 18001 }),
    });
    assert.equal(startAccepted.status, 201);
    assert.deepEqual(created, [[batchId, 18001, { tenantId, actorUserId: userId, sessionId: undefined }]]);

    const missingCsrf = await fetch(url, { method: "POST", headers: { cookie: signedCookie() } });
    assert.equal(missingCsrf.status, 403);
    assert.deepEqual(cancelled, []);

    const accepted = await fetch(url, {
      method: "POST",
      headers: { cookie: signedCookie(), "x-csrf-token": csrfToken },
    });
    assert.equal(accepted.status, 201);
    assert.deepEqual(await accepted.json(), { id: runId, status: "cancelled", currentStep: "cancelled" });
    assert.deepEqual(cancelled, [runId]);

    const resumeUrl = `http://127.0.0.1:${address.port}/api/runs/${runId}/resume-auth`;
    assert.equal((await fetch(resumeUrl, { method: "POST", headers: { cookie: signedCookie() } })).status, 403);
    assert.deepEqual(resumed, []);
    const resumedResponse = await fetch(resumeUrl, {
      method: "POST",
      headers: { cookie: signedCookie(), "x-csrf-token": csrfToken },
    });
    assert.equal(resumedResponse.status, 201);
    assert.deepEqual(await resumedResponse.json(), { id: runId, status: "pzu_login", errorCode: "SMS_RETRY_QUEUED" });
    assert.deepEqual(resumed, [[runId, { tenantId, actorUserId: userId }]]);
    const reviewUrl = `http://127.0.0.1:${address.port}/api/runs/${runId}/resume-review`;
    assert.equal((await fetch(reviewUrl, { method: "POST", headers: { cookie: signedCookie() } })).status, 403);
    assert.deepEqual(reviewed, []);
    const reviewResponse = await fetch(reviewUrl, {
      method: "POST",
      headers: { cookie: signedCookie(), "x-csrf-token": csrfToken },
    });
    assert.equal(reviewResponse.status, 201);
    assert.deepEqual(await reviewResponse.json(), {
      id: runId,
      status: "everest_search",
      errorCode: "REVIEW_RETRY_QUEUED",
    });
    assert.deepEqual(reviewed, [[runId, { tenantId, actorUserId: userId }]]);

    const pauseUrl = `http://127.0.0.1:${address.port}/api/runs/${runId}/pause`;
    assert.equal((await fetch(pauseUrl, { method: "POST", headers: { cookie: signedCookie() } })).status, 403);
    assert.deepEqual(pauseCalls, []);
    const missingControl = await fetch(pauseUrl, {
      method: "POST",
      headers: { cookie: signedCookie(), "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingControl.status, 400);
    assert.deepEqual(pauseCalls, []);
    const pauseRequest = { expectedRevision: "0", idempotencyKey: "synthetic-pause-request-0001" };
    const pauseResponse = await fetch(pauseUrl, {
      method: "POST",
      headers: { cookie: signedCookie(), "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify(pauseRequest),
    });
    assert.equal(pauseResponse.status, 201);
    assert.deepEqual(await pauseResponse.json(), {
      id: runId,
      status: "compensa_form",
      controlState: "pause_requested",
      controlRevision: "1",
    });
    assert.deepEqual(pauseCalls, [[runId, { tenantId, actorUserId: userId }, pauseRequest]]);

    const runResumeUrl = `http://127.0.0.1:${address.port}/api/runs/${runId}/resume`;
    assert.equal((await fetch(runResumeUrl, { method: "POST", headers: { cookie: signedCookie() } })).status, 403);
    assert.deepEqual(runResumeCalls, []);
    const resumeRequest = { expectedRevision: "1", idempotencyKey: "synthetic-resume-request-0001" };
    const runResumeResponse = await fetch(runResumeUrl, {
      method: "POST",
      headers: { cookie: signedCookie(), "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify(resumeRequest),
    });
    assert.equal(runResumeResponse.status, 201);
    assert.deepEqual(await runResumeResponse.json(), {
      id: runId,
      status: "compensa_form",
      controlState: "running",
      controlRevision: "2",
    });
    assert.deepEqual(runResumeCalls, [[runId, { tenantId, actorUserId: userId }, resumeRequest]]);
  } finally {
    if (app) await app.close();
    if (oldSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = oldSecret;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  }
});
