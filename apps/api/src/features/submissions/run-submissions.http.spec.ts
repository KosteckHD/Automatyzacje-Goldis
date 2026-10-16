import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const secret = "run-submission-synthetic-session-secret";
const csrf = "synthetic-csrf-token-for-run-submission-http-tests-123456";
const tenantId = "99999999-9999-4999-8999-999999999999";
const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const submissionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const users = {
  admin: "11111111-1111-4111-8111-111111111111",
  manager: "66666666-6666-4666-8666-666666666666",
  operator: "22222222-2222-4222-8222-222222222222",
  otherOperator: "33333333-3333-4333-8333-333333333333",
  reviewer: "44444444-4444-4444-8444-444444444444",
  auditor: "55555555-5555-4555-8555-555555555555",
};

function cookie(role: keyof typeof users) {
  const data = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000, userId: users[role], tenantId, csrf })).toString(
    "base64url",
  );
  return `goldis_session=${data}.${createHmac("sha256", secret).update(data).digest("base64url")}; goldis_csrf=${csrf}`;
}

test("run submission API protects preview, creation, tenant scope, pagination, and cancellation", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  process.env.SESSION_SECRET = secret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  process.env.PUBLIC_APP_ORIGIN = "https://goldis-submission.synthetic";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const received: Array<{ method: string; args: unknown[] }> = [];
  let restoreToolModels: (() => void) | undefined;
  try {
    const { RunSubmissionController } = await import("./run-submissions.controller");
    const { RunSubmissionService } = await import("./run-submissions.service");
    const { Tool, ToolGrant } = await import("../../infrastructure/database/db");
    const originalToolFindByPk = Tool.findByPk;
    const originalGrantFindOne = ToolGrant.findOne;
    const grants = new Map<
      string,
      { canDiscover: boolean; canExecute: boolean; canViewResults: boolean; canDownloadResults: boolean }
    >([
      [users.manager, { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }],
      [users.operator, { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true }],
    ]);
    restoreToolModels = () => {
      Tool.findByPk = originalToolFindByPk;
      ToolGrant.findOne = originalGrantFindOne;
    };
    Tool.findByPk = (async (toolId: string) => ({ toolId, status: "available" })) as typeof Tool.findByPk;
    ToolGrant.findOne = (async (options: unknown) => {
      const where = (options as { where?: { userId?: string } }).where;
      return where?.userId ? (grants.get(where.userId) ?? null) : null;
    }) as typeof ToolGrant.findOne;
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("../auth");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("../authorization");
    const { APP_GUARD } = await import("@nestjs/core");
    const { RequestProtectionGuard } = await import("../../infrastructure/http");
    const service = {
      async preview(...args: unknown[]) {
        received.push({ method: "preview", args });
        return { counts: { selected: 2, ready: 2 } };
      },
      async create(...args: unknown[]) {
        received.push({ method: "create", args });
        return { submissionId, status: "queued" };
      },
      async get(...args: unknown[]) {
        received.push({ method: "get", args });
        return { submissionId, status: "running" };
      },
      async listItems(...args: unknown[]) {
        received.push({ method: "listItems", args });
        return { items: [], nextCursor: null };
      },
      async cancel(...args: unknown[]) {
        received.push({ method: "cancel", args });
        return { submissionId, status: "cancelled" };
      },
    };
    @Module({
      controllers: [RunSubmissionController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: APP_GUARD, useClass: RequestProtectionGuard },
        {
          provide: SESSION_ROLE_RESOLVER,
          useValue: async (userId: string, requestedTenant: string) =>
            requestedTenant === tenantId
              ? (Object.entries(users)
                  .find(([, id]) => id === userId)?.[0]
                  .replace("otherOperator", "operator") ?? null)
              : null,
        },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        {
          provide: PERMISSION_RESOURCE_RESOLVER,
          useValue: async (
            selector: string,
            request: { params?: { id?: string; batchId?: string } },
            principal: { userId: string },
          ) => {
            if (selector === "route-batch" && request.params?.batchId === batchId)
              return {
                resourceTenantId: tenantId,
                resourceOwnerId: users.operator,
                resourceToolId: "oc-policy-verification",
              };
            if (selector === "route-submission" && request.params?.id === submissionId)
              return {
                resourceTenantId: tenantId,
                resourceOwnerId: users.operator,
                resourceToolId: "oc-policy-verification",
              };
            if (selector === "route-submission" && request.params?.id === foreignId)
              return {
                resourceTenantId: "88888888-8888-4888-8888-888888888888",
                resourceOwnerId: users.admin,
                resourceToolId: "oc-policy-verification",
              };
            return null;
          },
        },
        { provide: RunSubmissionService, useValue: service },
      ],
    })
    class RunSubmissionHttpTestModule {}

    app = await NestFactory.create(RunSubmissionHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api`;
    const request = (
      path: string,
      role?: keyof typeof users,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          ...(role ? { cookie: cookie(role) } : {}),
          ...(method !== "GET"
            ? { origin: process.env.PUBLIC_APP_ORIGIN!, "content-type": "application/json", "x-csrf-token": csrf }
            : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const selection = { fromRow: 2, toRow: 3 };
    const create = {
      ...selection,
      selectionFingerprint: "a".repeat(64),
      idempotencyKey: "synthetic-submission-key-123456",
    };
    assert.equal(
      (
        await request(`/imports/${batchId}/run-submissions/preview`, undefined, "POST", selection, {
          cookie: `goldis_csrf=${csrf}`,
        })
      ).status,
      401,
    );
    assert.equal(
      (await request(`/imports/${batchId}/run-submissions/preview`, "reviewer", "POST", selection)).status,
      403,
    );
    assert.equal(
      (
        await request(`/imports/${batchId}/run-submissions/preview`, "operator", "POST", selection, {
          "x-csrf-token": "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`/imports/${batchId}/run-submissions/preview`, "operator", "POST", selection, {
          origin: "https://attacker.synthetic",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(`/imports/${batchId}/run-submissions/preview`, "operator", "POST", selection)).status,
      201,
    );
    assert.equal(
      (await request(`/imports/${batchId}/run-submissions/preview`, "manager", "POST", selection)).status,
      201,
    );
    assert.equal((await request(`/imports/${batchId}/run-submissions`, "operator", "POST", create)).status, 201);
    assert.equal((await request(`/run-submissions/${submissionId}`)).status, 401);
    assert.equal((await request(`/run-submissions/${submissionId}`, "reviewer")).status, 403);
    assert.equal((await request(`/run-submissions/${foreignId}`, "admin")).status, 404);
    assert.equal((await request(`/run-submissions/${submissionId}`, "otherOperator")).status, 404);
    assert.equal((await request(`/run-submissions/${submissionId}`, "operator")).status, 200);
    assert.equal((await request(`/run-submissions/${submissionId}`, "manager")).status, 200);
    assert.equal((await request(`/run-submissions/${submissionId}/items?cursor=opaque`, "operator")).status, 200);
    assert.equal(
      (await request(`/run-submissions/${submissionId}/cancel`, "reviewer", "POST", { expectedVersion: 1 })).status,
      403,
    );
    assert.equal(
      (await request(`/run-submissions/${submissionId}/cancel`, "manager", "POST", { expectedVersion: 1 })).status,
      201,
    );
    assert.equal(
      (await request(`/run-submissions/${submissionId}/cancel`, "operator", "POST", { expectedVersion: 1 })).status,
      201,
    );

    const managerCancellationCount = received.filter(
      (call) =>
        call.method === "cancel" &&
        call.args[2] &&
        (call.args[2] as { actorUserId?: string }).actorUserId === users.manager,
    ).length;
    grants.set(users.manager, { canDiscover: true, canExecute: false, canViewResults: true, canDownloadResults: true });
    assert.equal(
      (await request(`/imports/${batchId}/run-submissions/preview`, "manager", "POST", selection)).status,
      404,
      "cofnięcie execute blokuje kolejne podglądy wykonania na tej samej sesji",
    );
    assert.equal(
      (await request(`/run-submissions/${submissionId}/cancel`, "manager", "POST", { expectedVersion: 1 })).status,
      404,
      "cofnięcie execute blokuje anulowanie na tej samej sesji",
    );
    assert.equal(
      (await request(`/run-submissions/${submissionId}`, "manager")).status,
      200,
      "zachowany view_results nadal pozwala odczytać własny tenant",
    );
    assert.equal(
      received.filter(
        (call) =>
          call.method === "cancel" &&
          call.args[2] &&
          (call.args[2] as { actorUserId?: string }).actorUserId === users.manager,
      ).length,
      managerCancellationCount,
      "odrzucony request nie wywołuje usługi",
    );

    grants.set(users.manager, { canDiscover: true, canExecute: true, canViewResults: false, canDownloadResults: true });
    assert.equal(
      (await request(`/run-submissions/${submissionId}`, "manager")).status,
      200,
      "wspólny odczyt OC pozostaje dostępny niezależnie od indywidualnego view_results",
    );
    assert.equal(
      (await request(`/run-submissions/${submissionId}/cancel`, "manager", "POST", { expectedVersion: 1 })).status,
      201,
      "execute pozostaje niezależne od view_results",
    );

    const previewCall = received.find((call) => call.method === "preview")!;
    assert.deepEqual(previewCall.args[1], selection);
    assert.equal((previewCall.args[2] as { actorUserId: string }).actorUserId, users.operator);
    const createCall = received.find((call) => call.method === "create")!;
    assert.deepEqual(createCall.args[1], create);
    assert.equal((createCall.args[2] as { actorUserId: string }).actorUserId, users.operator);
    assert.equal(
      received.some((call) => call.method === "cancel" && call.args[0] === submissionId),
      true,
    );
    assert.equal(
      received.some(
        (call) => call.method === "preview" && (call.args[2] as { actorUserId: string }).actorUserId === users.manager,
      ),
      true,
      "Menedżer używa endpointu operacyjnego z aktorem z sesji",
    );
  } finally {
    if (app) await app.close();
    restoreToolModels?.();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = previousOrigin;
  }
});
