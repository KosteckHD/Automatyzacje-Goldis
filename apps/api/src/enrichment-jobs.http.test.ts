import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const secret = "enrichment-job-synthetic-session-secret";
const csrf = "synthetic-csrf-token-for-enrichment-job-tests-012345";
const tenantId = "99999999-9999-4999-8999-999999999999";
const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherJobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const users = {
  admin: "11111111-1111-4111-8111-111111111111",
  operator: "22222222-2222-4222-8222-222222222222",
  reviewer: "33333333-3333-4333-8333-333333333333",
  auditor: "44444444-4444-4444-8444-444444444444",
};

function sessionCookie(role: keyof typeof users) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000, userId: users[role], tenantId, csrf })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
}

test("persistent enrichment routes enforce role, tenant, Origin, CSRF, and job ownership gates", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  process.env.SESSION_SECRET = secret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  process.env.PUBLIC_APP_ORIGIN = "https://goldis-enrichment.synthetic";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const received: Array<{ method: string; args: unknown[] }> = [];
  try {
    const { EnrichmentJobController, EnrichmentJobService } = await import("./enrichment-jobs");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("./session");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("./authorization-guard");
    const { APP_GUARD } = await import("@nestjs/core");
    const { RequestProtectionGuard } = await import("./request-protection");
    const service = {
      async start(...args: unknown[]) { received.push({ method: "start", args }); return { id: jobId, status: "queued" }; },
      async listForBatch(...args: unknown[]) { received.push({ method: "listForBatch", args }); return { items: [] }; },
      async get(...args: unknown[]) { received.push({ method: "get", args }); return { id: jobId, status: "processing" }; },
      async listItems(...args: unknown[]) { received.push({ method: "listItems", args }); return { items: [], nextCursor: null }; },
      async cancel(...args: unknown[]) { received.push({ method: "cancel", args }); return { id: jobId, status: "cancelled" }; },
    };
    @Module({
      controllers: [EnrichmentJobController],
      providers: [
        SessionGuard, PermissionGuard,
        { provide: APP_GUARD, useClass: RequestProtectionGuard },
        { provide: SESSION_ROLE_RESOLVER, useValue: async (userId: string, requestedTenantId: string) => requestedTenantId === tenantId
          ? Object.entries(users).find(([, id]) => id === userId)?.[0] ?? null : null },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: async (selector: string, request: { params?: { id?: string; batchId?: string } }, principal: { userId: string; tenantId: string }) => {
          if (selector === "route-batch" && request.params?.batchId === batchId) return { resourceTenantId: tenantId, resourceOwnerId: users.operator };
          if (selector === "route-enrichment-job" && request.params?.id === jobId) return { resourceTenantId: tenantId, resourceOwnerId: users.operator };
          if (selector === "route-enrichment-job" && request.params?.id === otherJobId) return { resourceTenantId: "88888888-8888-4888-8888-888888888888", resourceOwnerId: users.admin };
          return null;
        } },
        { provide: EnrichmentJobService, useValue: service },
      ],
    })
    class EnrichmentJobsHttpTestModule {}

    app = await NestFactory.create(EnrichmentJobsHttpTestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api`;
    const request = (path: string, role?: keyof typeof users, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
      method,
      headers: { ...(role ? { cookie: sessionCookie(role) } : {}), ...(method === "POST" ? { origin: process.env.PUBLIC_APP_ORIGIN!, "content-type": "application/json", "x-csrf-token": csrf } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const body = { idempotencyKey: "synthetic-enrichment-key-012345", fromRow: 18001, toRow: 18002 };
    assert.equal((await request(`/imports/${batchId}/enrichment-jobs`, undefined, "POST", body)).status, 401);
    assert.equal((await request(`/imports/${batchId}/enrichment-jobs`, "reviewer", "POST", body)).status, 403);
    assert.equal((await request(`/imports/${batchId}/enrichment-jobs`, "operator", "POST", body, { "x-csrf-token": "wrong" })).status, 403);
    assert.equal((await request(`/imports/${batchId}/enrichment-jobs`, "operator", "POST", body, { origin: "https://attacker.synthetic" })).status, 403);
    assert.equal((await request(`/imports/${batchId}/enrichment-jobs`, "operator", "POST", body)).status, 201);
    assert.equal((await request(`/imports/${batchId}/enrichment-jobs`, "operator")).status, 200);
    assert.equal((await request(`/enrichment-jobs/${jobId}`, "reviewer")).status, 200);
    assert.equal((await request(`/enrichment-jobs/${jobId}/items?cursor=18001`, "operator")).status, 200);
    assert.equal((await request(`/enrichment-jobs/${jobId}`, "auditor")).status, 403);
    assert.equal((await request(`/enrichment-jobs/${otherJobId}`, "reviewer")).status, 404);
    assert.equal((await request(`/enrichment-jobs/${jobId}/cancel`, "reviewer", "POST", { expectedVersion: 1 })).status, 403);
    assert.equal((await request(`/enrichment-jobs/${jobId}/cancel`, "operator", "POST", { expectedVersion: 2 })).status, 201);

    const start = received.find((item) => item.method === "start")!;
    assert.deepEqual(start.args[1], body);
    assert.equal((start.args[2] as { userId: string }).userId, users.operator);
    assert.equal(received.some((item) => item.method === "cancel" && item.args[0] === jobId), true);

    const { EnrichmentJobService: Service } = await import("./enrichment-jobs");
    const validator = new Service();
    await assert.rejects(
      validator.start(batchId, { ...body, injected: true } as never, { tenantId, userId: users.operator, role: "operator" }),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 400,
    );
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
