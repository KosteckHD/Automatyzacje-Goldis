import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const sessionSecret = "auth-challenge-http-synthetic-session-secret";
const csrfToken = "synthetic-csrf-token-for-auth-challenge-http-tests-123456";
const challengeId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const userIds = {
  admin: "33333333-3333-4333-8333-333333333333",
  operator: "44444444-4444-4444-8444-444444444444",
};

function signedCookie(role: string, exp = Date.now() + 60_000): string {
  const payload = Buffer.from(JSON.stringify({
    exp, userId: userIds[role as keyof typeof userIds], tenantId, csrf: csrfToken,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrfToken}`;
}

test("POST /api/auth-challenges/:id/code egzekwuje sesję, rolę, CSRF i kształt body", async () => {
  const oldSecret = process.env.SESSION_SECRET;
  const oldDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const submitted: Array<{ id: string; body: { runId?: string; code?: string } }> = [];
  try {
    const { AuthChallengeController, AuthChallengeService } = await import("./auth-challenges");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("./session");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("./authorization-guard");
    const service = {
      async getForRun(requestedRunId: string) {
        return requestedRunId === runId
          ? { challengeId, runId, portal: "pzu", status: "active", expiresAt: "2026-10-01T12:00:00.000Z", attemptCount: 0, attemptLimit: 5 }
          : null;
      },
      async submitCode(id: string, submittedRunId: string, code: string) {
        submitted.push({ id, body: { runId: submittedRunId, code } });
        return { accepted: true, challengeId: id, attemptCount: 1 };
      },
    };
    @Module({
      controllers: [AuthChallengeController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: SESSION_ROLE_RESOLVER, useValue: async (userId: string, requestedTenantId: string) =>
          requestedTenantId === tenantId
            ? userId === userIds.admin ? "admin" : userId === userIds.operator ? "operator" : null
            : null },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: async (selector: string, request: { query?: { runId?: string }; body?: { runId?: string } }) =>
          [request.query?.runId, request.body?.runId].includes(runId)
            && (selector === "query-run" || selector === "body-run")
            ? { resourceTenantId: tenantId, resourceOwnerId: userIds.admin }
            : null },
        { provide: AuthChallengeService, useValue: service },
      ],
    })
    class AuthChallengeHttpTestModule {}

    app = await NestFactory.create(AuthChallengeHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/auth-challenges/${challengeId}/code`;

    const unauthenticated = await fetch(url, { method: "POST", body: JSON.stringify({ runId, code: "407219" }) });
    assert.equal(unauthenticated.status, 401);

    const expiredSession = await fetch(url, {
      method: "POST", headers: { cookie: signedCookie("admin", Date.now() - 1), "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ runId, code: "407219" }),
    });
    assert.equal(expiredSession.status, 401);
    assert.deepEqual(submitted, []);

    const forbidden = await fetch(url, {
      method: "POST", headers: { cookie: signedCookie("operator"), "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ runId, code: "407219" }),
    });
    assert.equal(forbidden.status, 404);

    const csrfRejected = await fetch(url, {
      method: "POST", headers: { cookie: signedCookie("admin"), "content-type": "application/json", "x-csrf-token": "wrong" },
      body: JSON.stringify({ runId, code: "407219" }),
    });
    assert.equal(csrfRejected.status, 403);

    const bodyRejected = await fetch(url, {
      method: "POST", headers: { cookie: signedCookie("admin"), "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ runId, code: "407219", extra: "must be rejected" }),
    });
    assert.equal(bodyRejected.status, 400);
    assert.deepEqual(submitted, []);

    const accepted = await fetch(url, {
      method: "POST", headers: { cookie: signedCookie("admin"), "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ runId, code: "407219" }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true, challengeId, attemptCount: 1 });
    assert.deepEqual(submitted, [{ id: challengeId, body: { runId, code: "407219" } }]);

    const active = await fetch(`http://127.0.0.1:${address.port}/api/auth-challenges?runId=${runId}`, {
      headers: { cookie: signedCookie("admin") },
    });
    assert.equal(active.status, 200);
    assert.equal(active.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await active.json(), {
      challengeId, runId, portal: "pzu", status: "active", expiresAt: "2026-10-01T12:00:00.000Z", attemptCount: 0, attemptLimit: 5,
    });
  } finally {
    if (app) await app.close();
    if (oldSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = oldSecret;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  }
});
