import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const sessionSecret = "review-synthetic-session-secret-only-for-tests";
const csrfToken = "synthetic-csrf-token-for-review-http-tests-0123456789";
const tenantId = "99999999-9999-4999-8999-999999999999";
const foreignTenantId = "88888888-8888-4888-8888-888888888888";
const users = {
  admin: "11111111-1111-4111-8111-111111111111",
  operator: "22222222-2222-4222-8222-222222222222",
  reviewer: "33333333-3333-4333-8333-333333333333",
  auditor: "44444444-4444-4444-8444-444444444444",
};
const correctionId = "55555555-5555-4555-8555-555555555555";
const conflictId = "66666666-6666-4666-8666-666666666666";
const foreignId = "77777777-7777-4777-8777-777777777777";

function sessionCookie(role: keyof typeof users) {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 60_000, userId: users[role], tenantId, csrf: csrfToken,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrfToken}`;
}

test("review API gates role, tenant, session and CSRF before forwarding decisions", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  process.env.PUBLIC_APP_ORIGIN = "https://goldis-review.synthetic";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const received: Array<{ method: string; args: unknown[] }> = [];
  try {
    const { ReviewController } = await import("./review");
    const { ReviewService } = await import("./review-service");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("./session");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("./authorization-guard");
    const { APP_GUARD } = await import("@nestjs/core");
    const { RequestProtectionGuard } = await import("./request-protection");
    const service = {
      async listCorrections(...args: unknown[]) { received.push({ method: "listCorrections", args }); return { items: [], hasMore: false }; },
      async listConflicts(...args: unknown[]) { received.push({ method: "listConflicts", args }); return { items: [], hasMore: false }; },
      async decideCorrection(...args: unknown[]) { received.push({ method: "decideCorrection", args }); return { decision: "approved" }; },
      async resolveConflict(...args: unknown[]) { received.push({ method: "resolveConflict", args }); return { decision: "recheck" }; },
    };
    @Module({
      controllers: [ReviewController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: APP_GUARD, useClass: RequestProtectionGuard },
        { provide: SESSION_ROLE_RESOLVER, useValue: async (userId: string, requestedTenantId: string) => requestedTenantId === tenantId
          ? userId === users.admin ? "admin" : userId === users.operator ? "operator" : userId === users.reviewer ? "reviewer" : userId === users.auditor ? "auditor" : null
          : null },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: async (selector: string, request: { params?: { id?: string } }, principal: { userId: string; tenantId: string }) => {
          if (selector === "collection") return { resourceTenantId: principal.tenantId, resourceOwnerId: principal.userId };
          const id = request.params?.id;
          if (id === correctionId || id === conflictId) return { resourceTenantId: tenantId, resourceOwnerId: users.admin };
          if (id === foreignId) return { resourceTenantId: foreignTenantId, resourceOwnerId: users.admin };
          return null;
        } },
        { provide: ReviewService, useValue: service },
      ],
    })
    class ReviewHttpTestModule {}

    app = await NestFactory.create(ReviewHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/review`;
    const get = (path: string, role?: keyof typeof users) => fetch(`${base}${path}`, {
      headers: role ? { cookie: sessionCookie(role) } : undefined,
    });
    const post = (path: string, role: keyof typeof users, body: unknown, withCsrf = true) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: sessionCookie(role), origin: process.env.PUBLIC_APP_ORIGIN!, ...(withCsrf ? { "x-csrf-token": csrfToken } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal((await get("/corrections")).status, 401);
    assert.equal((await get("/corrections", "auditor")).status, 403);
    assert.equal((await get("/corrections", "operator")).status, 403);
    assert.equal((await get("/my-corrections", "operator")).status, 200);
    assert.equal((await get("/conflicts", "reviewer")).status, 200);
    assert.equal((await get("/corrections", "reviewer")).status, 200);

    const decision = { decision: "approved", expectedRowVersion: 4, reasonCode: "REGISTRY_MATCH_VERIFIED" };
    assert.equal((await post(`/corrections/${correctionId}/decision`, "reviewer", decision, false)).status, 403);
    const badOrigin = await fetch(`${base}/corrections/${correctionId}/decision`, {
      method: "POST", headers: { cookie: sessionCookie("reviewer"), origin: "https://attacker.synthetic", "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await post(`/corrections/${foreignId}/decision`, "reviewer", decision)).status, 404);
    assert.equal((await post(`/corrections/${correctionId}/decision`, "operator", decision)).status, 403);
    assert.equal((await post(`/corrections/${correctionId}/decision`, "reviewer", decision)).status, 201);
    assert.equal((await post(`/conflicts/${conflictId}/resolution`, "reviewer", {
      action: "recheck", expectedRowVersion: 4, reasonCode: "SOURCE_DATA_UPDATED",
    })).status, 201);

    assert.equal(received.filter((call) => call.method === "decideCorrection").length, 1);
    const decisionArgs = received.find((call) => call.method === "decideCorrection")!.args;
    assert.equal(decisionArgs[0], correctionId);
    assert.equal((decisionArgs[1] as { userId: string }).userId, users.reviewer);
    assert.deepEqual(decisionArgs[2], decision);
    const reviewerListCall = received.find((call) => call.method === "listCorrections" && (call.args[0] as { role: string }).role === "reviewer");
    assert.ok(reviewerListCall);
    assert.equal(received.some((call) => call.method === "resolveConflict" && call.args[0] === conflictId), true);
    const { ReviewService: ReviewServiceClass } = await import("./review-service");
    const bodyValidator = new ReviewServiceClass({} as never);
    await assert.rejects(bodyValidator.decideCorrection(correctionId, {
      userId: users.reviewer, tenantId, role: "reviewer",
    } as never, { ...decision, unknown: "must-be-rejected" }), (error: { getStatus?: () => number }) => error.getStatus?.() === 400);
  } finally {
    if (app) await app.close();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = previousOrigin;
  }
});
