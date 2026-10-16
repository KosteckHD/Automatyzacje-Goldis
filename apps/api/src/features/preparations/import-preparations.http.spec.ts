import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const secret = "preparation-synthetic-session-secret";
const csrf = "preparation-csrf-token-12345678901234567890";
const tenantId = "99999999-9999-4999-8999-999999999999";
const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const preparationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const users = {
  admin: "11111111-1111-4111-8111-111111111111",
  manager: "66666666-6666-4666-8666-666666666666",
  operator: "22222222-2222-4222-8222-222222222222",
  reviewer: "44444444-4444-4444-8444-444444444444",
  auditor: "55555555-5555-4555-8555-555555555555",
};

function cookie(role: keyof typeof users) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + 60_000, userId: users[role], tenantId, csrf }),
  ).toString("base64url");
  return `goldis_session=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}; goldis_csrf=${csrf}`;
}

test("import preparation APIs enforce session, CSRF, role scope, and forward workflow controls", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = secret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  try {
    const { ImportPreparationController, ImportPreparationService } = await import("./");
    const { AuditService } = await import("../audit/public");
    const { ImportPreparationWorkflowController, ImportPreparationWorkflowService } = await import("./");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("../auth");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("../authorization");
    const service = {
      async start(...args: unknown[]) {
        calls.push({ method: "start", args });
        return { preparationId, status: "queued" };
      },
      async listForBatch(...args: unknown[]) {
        calls.push({ method: "list", args });
        return { preparations: [] };
      },
      async get(...args: unknown[]) {
        calls.push({ method: "get", args });
        return { preparationId, status: "completed" };
      },
      async rows(...args: unknown[]) {
        calls.push({ method: "rows", args });
        return { rows: [], total: 0 };
      },
      async cancel(...args: unknown[]) {
        calls.push({ method: "cancel", args });
        return { preparationId, status: "cancelled" };
      },
    };
    const workflowService = {
      async start(...args: unknown[]) {
        calls.push({ method: "workflowStart", args });
        return { workflowId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "queued" };
      },
      async listForBatch(...args: unknown[]) {
        calls.push({ method: "workflowList", args });
        return { workflows: [] };
      },
      async cancel(...args: unknown[]) {
        calls.push({ method: "workflowCancel", args });
        return { status: "cancelled" };
      },
    };
    @Module({
      controllers: [ImportPreparationController, ImportPreparationWorkflowController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: AuditService, useValue: { record: async () => undefined } },
        {
          provide: SESSION_ROLE_RESOLVER,
          useValue: async (userId: string, requestedTenant: string) =>
            requestedTenant === tenantId ? (Object.entries(users).find(([, id]) => id === userId)?.[0] ?? null) : null,
        },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        {
          provide: PERMISSION_RESOURCE_RESOLVER,
          useValue: async (
            selector: string,
            request: { params?: { batchId?: string } },
            principal: { userId: string },
          ) =>
            selector === "route-batch" && request.params?.batchId === batchId
              ? { resourceTenantId: tenantId, resourceOwnerId: users.operator }
              : null,
        },
        { provide: ImportPreparationService, useValue: service },
        { provide: ImportPreparationWorkflowService, useValue: workflowService },
      ],
    })
    class ImportPreparationHttpTestModule {}
    app = await NestFactory.create(ImportPreparationHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api`;
    const request = (path: string, role?: keyof typeof users, method = "GET", body?: unknown, validCsrf = true) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          ...(role ? { cookie: cookie(role) } : {}),
          ...(method !== "GET"
            ? {
                "content-type": "application/json",
                "x-csrf-token": validCsrf ? csrf : "invalid-csrf-token",
              }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const path = `/imports/${batchId}/preparations`;
    const startBody = { idempotencyKey: "synthetic-preparation-key-123456" };
    assert.equal((await request(path, undefined, "POST", startBody)).status, 401);
    assert.equal((await request(path, "manager", "POST", startBody, false)).status, 403);
    assert.equal((await request(path, "reviewer", "POST", startBody)).status, 403);
    assert.equal((await request(path, "admin", "POST", startBody)).status, 201);
    assert.equal((await request(path, "manager", "POST", startBody)).status, 201);
    assert.equal((await request(path, "operator", "POST", startBody)).status, 201);
    assert.equal((await request(path, "auditor")).status, 403);
    assert.equal((await request(`${path}/${preparationId}`, "reviewer")).status, 200);
    assert.equal((await request(`${path}/${preparationId}/rows?page=2&state=review`, "manager")).status, 200);
    const exportPath = `${path}/${preparationId}/export`;
    assert.equal((await request(exportPath)).status, 401);
    assert.equal((await request(exportPath, "reviewer")).status, 403);
    assert.equal((await request(exportPath, "auditor")).status, 403);
    assert.equal(
      (await request(`${path}/${preparationId}/cancel`, "reviewer", "POST", { expectedVersion: 1 })).status,
      403,
    );
    assert.equal(
      (await request(`${path}/${preparationId}/cancel`, "manager", "POST", { expectedVersion: 1 })).status,
      201,
    );
    const workflowPath = `/imports/${batchId}/preparations/${preparationId}/workflow`;
    const workflowBody = { idempotencyKey: "synthetic-workflow-key-123456" };
    assert.equal((await request(workflowPath, "manager", "POST", workflowBody, false)).status, 403);
    assert.equal((await request(workflowPath, "reviewer", "POST", workflowBody)).status, 403);
    assert.equal((await request(workflowPath, "manager", "POST", workflowBody)).status, 201);
    assert.equal((await request(`/imports/${batchId}/preparation-workflows`, "manager")).status, 200);
    assert.equal(
      (
        await request(
          `/imports/${batchId}/preparation-workflows/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cancel`,
          "manager",
          "POST",
          { expectedVersion: 1 },
        )
      ).status,
      201,
    );
    const startCall = calls.find((call) => call.method === "start")!;
    assert.deepEqual(startCall.args.slice(0, 2), [batchId, startBody]);
    const startActor = startCall.args[2] as { tenantId: string; userId: string; role: string };
    assert.deepEqual(
      { tenantId: startActor.tenantId, userId: startActor.userId, role: startActor.role },
      { tenantId, userId: users.admin, role: "admin" },
    );
    const rowsCall = calls.find((call) => call.method === "rows")!;
    assert.deepEqual(rowsCall.args.slice(0, 4), [batchId, preparationId, 2, "review"]);
    assert.equal((rowsCall.args[4] as { role: string }).role, "manager");
    const workflowStartCall = calls.find((call) => call.method === "workflowStart")!;
    assert.deepEqual(workflowStartCall.args.slice(0, 3), [batchId, preparationId, workflowBody]);
    assert.equal((workflowStartCall.args[3] as { role: string }).role, "manager");
    const workflowCancelCall = calls.find((call) => call.method === "workflowCancel")!;
    assert.deepEqual(workflowCancelCall.args.slice(0, 3), [
      batchId,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      { expectedVersion: 1 },
    ]);
  } finally {
    if (app) await app.close();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
