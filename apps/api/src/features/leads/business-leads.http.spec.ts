import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ForbiddenException, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const sessionSecret = "business-leads-synthetic-session-secret";
const csrfToken = "business-leads-synthetic-csrf-token-123456789";
const tenantId = "99999999-9999-4999-8999-999999999999";
const resultSetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const identities = {
  admin: "11111111-1111-4111-8111-111111111111",
  manager: "22222222-2222-4222-8222-222222222222",
  operator: "33333333-3333-4333-8333-333333333333",
  reviewer: "44444444-4444-4444-8444-444444444444",
  auditor: "55555555-5555-4555-8555-555555555555",
};
const sessions = {
  admin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  manager: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  operator: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  reviewer: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  auditor: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

function cookie(role: keyof typeof identities) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      sessionId: sessions[role],
      exp: Date.now() + 60_000,
      userId: identities[role],
      tenantId,
      csrf: csrfToken,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrfToken}`;
}

test("lead allocation summary is authenticated and limited to manager roles", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const received: Array<{ userId: string; tenantId: string; role: string; resultSetId?: string }> = [];
  try {
    const { BusinessLeadController } = await import("./business-leads.controller");
    const { BusinessLeadService } = await import("./business-leads.service");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("../auth");
    const service = {
      async allocationSummary(actor: { userId: string; tenantId: string; role: string }, scope?: string) {
        if (actor.role !== "manager" && actor.role !== "admin") throw new ForbiddenException();
        received.push({ ...actor, resultSetId: scope });
        return { availableCount: 42, resultSetId: scope ?? null, checkedAt: "2026-10-12T08:00:00.000Z" };
      },
    };
    @Module({
      controllers: [BusinessLeadController],
      providers: [
        SessionGuard,
        {
          provide: SESSION_ROLE_RESOLVER,
          useValue: async (userId: string, requestedTenantId: string) =>
            requestedTenantId === tenantId
              ? (Object.entries(identities).find(([, id]) => id === userId)?.[0] ?? null)
              : null,
        },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        { provide: BusinessLeadService, useValue: service },
      ],
    })
    class BusinessLeadHttpTestModule {}

    app = await NestFactory.create(BusinessLeadHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/leads/allocation-summary`;
    const get = (role?: keyof typeof identities, scope?: string) => {
      const url = new URL(base);
      if (scope) url.searchParams.set("resultSetId", scope);
      return fetch(url, { headers: role ? { cookie: cookie(role) } : undefined });
    };

    assert.equal((await get()).status, 401);
    for (const role of ["operator", "reviewer", "auditor"] as const)
      assert.equal((await get(role, resultSetId)).status, 403);
    const scoped = await get("manager", resultSetId);
    assert.equal(scoped.status, 200);
    assert.deepEqual(await scoped.json(), { availableCount: 42, resultSetId, checkedAt: "2026-10-12T08:00:00.000Z" });
    const unscoped = await get("admin");
    assert.equal(unscoped.status, 200);
    assert.deepEqual(received, [
      { userId: identities.manager, tenantId, role: "manager", resultSetId },
      { userId: identities.admin, tenantId, role: "admin", resultSetId: undefined },
    ]);
  } finally {
    if (app) {
      app.getHttpServer().closeAllConnections?.();
      await app.close();
    }
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
