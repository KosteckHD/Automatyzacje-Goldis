import assert from "node:assert/strict";
import { test } from "node:test";
import { UnauthorizedException } from "@nestjs/common";
import type { LoginRateLimiter, SessionPrincipal } from "../auth";
import { issueSession } from "../auth";
import { DeletionStepUpController } from "./deletion-step-up.controller";
import type { DeletionStepUpService } from "./deletion-step-up.service";

const actor: SessionPrincipal = {
  exp: Date.now() + 60_000,
  csrf: "synthetic-csrf-token-for-deletion-step-up-http-test-1234567890",
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  actorRef: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  version: 2,
  role: "admin",
};

function requestFor(csrfToken: string, sessionToken: string) {
  return {
    headers: {
      cookie: `goldis_session=${sessionToken}; goldis_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    ip: "203.0.113.55",
    socket: { remoteAddress: "203.0.113.55" },
    goldisPrincipal: actor,
  };
}

test("deletion step-up keeps /auth route and clears the re-authentication budget after success", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "synthetic-session-secret-for-deletion-step-up-controller";
  const issued = issueSession(actor.userId, actor.tenantId, actor.sessionId as string);
  const limiterCalls: string[] = [];
  const limiter = {
    async consumeReauthAttempt(...args: unknown[]) {
      assert.deepEqual(args, [actor.userId, actor.sessionId, "203.0.113.55"]);
      limiterCalls.push("consume");
      return { allowed: true, retryAfterSeconds: 0, generation: "synthetic" };
    },
    async clearReauth(...args: unknown[]) {
      assert.equal(args[0], actor.userId);
      limiterCalls.push("clear");
    },
    async recordReauthFailure() {
      limiterCalls.push("failure");
    },
  };
  let call: Record<string, unknown> | undefined;
  const service = {
    async request(input: Record<string, unknown>) {
      call = input;
      return { stepUpToken: "synthetic-step-up-token", expiresAt: "2026-10-16T12:05:00.000Z" };
    },
  };
  try {
    const controller = new DeletionStepUpController(
      limiter as unknown as LoginRateLimiter,
      service as unknown as DeletionStepUpService,
    );
    const result = await controller.requestStepUp(
      { previewId: "33333333-3333-4333-8333-333333333333", currentPassword: "synthetic password" },
      requestFor(issued.csrfToken, issued.sessionToken) as never,
      { setHeader() {} } as never,
    );
    assert.equal(result.stepUpToken, "synthetic-step-up-token");
    assert.deepEqual(limiterCalls, ["consume", "clear"]);
    assert.equal(call?.actor, actor);
    assert.equal(call?.previewId, "33333333-3333-4333-8333-333333333333");
    assert.equal(call?.currentPassword, "synthetic password");
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("deletion step-up records only an incorrect-password re-authentication failure", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "synthetic-session-secret-for-deletion-step-up-controller";
  const issued = issueSession(actor.userId, actor.tenantId, actor.sessionId as string);
  const calls: string[] = [];
  const limiter = {
    async consumeReauthAttempt() {
      calls.push("consume");
      return { allowed: true, retryAfterSeconds: 0, generation: "synthetic" };
    },
    async clearReauth() {
      calls.push("clear");
    },
    async recordReauthFailure() {
      calls.push("failure");
    },
  };
  const service = {
    async request() {
      throw new UnauthorizedException("Nieprawidłowe obecne hasło");
    },
  };
  try {
    const controller = new DeletionStepUpController(
      limiter as unknown as LoginRateLimiter,
      service as unknown as DeletionStepUpService,
    );
    await assert.rejects(
      controller.requestStepUp(
        { previewId: "33333333-3333-4333-8333-333333333333", currentPassword: "wrong" },
        requestFor(issued.csrfToken, issued.sessionToken) as never,
        { setHeader() {} } as never,
      ),
      (error: unknown) => error instanceof UnauthorizedException,
    );
    assert.deepEqual(calls, ["consume", "failure"]);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});
