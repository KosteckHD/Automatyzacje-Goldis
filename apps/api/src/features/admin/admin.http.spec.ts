import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { sequelize, TenantMembership, Tool } from "../../infrastructure/database/db";
import {
  createHttpApplication,
  PublicExceptionFilter,
  PublicOutputInterceptor,
  RequestProtectionGuard,
} from "../../infrastructure/http/index";
import { PasswordRecoveryService } from "../account-recovery/index";
import { AuditService } from "../audit/index";
import { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } from "../auth/index";
import { AdminOnlyGuard } from "./admin.support";
import { AdminMutationsService } from "./admin-mutations.service";
import { AdminOverviewController } from "./admin-overview.controller";
import { AdminOverviewRepository } from "./admin-overview.repository";
import { AdminOverviewService } from "./admin-overview.service";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";

const adminUserId = "11111111-1111-4111-8111-111111111111";
const managerUserId = "22222222-2222-4222-8222-222222222222";
const tenantId = "99999999-9999-4999-8999-999999999999";
const adminUserServiceCalls: { grant?: unknown[] } = {};

function signedSessionCookie(userId: string): string {
  const csrf = "synthetic-admin-http-csrf-token-0123456789abcdef";
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      sessionId:
        userId === adminUserId ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      exp: Date.now() + 60_000,
      userId,
      tenantId,
      csrf,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
}

@Module({
  controllers: [AdminOverviewController, AdminUsersController],
  providers: [
    AdminOnlyGuard,
    SessionGuard,
    { provide: PasswordRecoveryService, useValue: {} },
    { provide: AuditService, useValue: { record: async () => undefined } },
    { provide: AdminMutationsService, useValue: {} },
    AdminOverviewRepository,
    AdminOverviewService,
    {
      provide: AdminUsersService,
      useValue: {
        list: async () => ({ items: [], nextCursor: null }),
        setToolGrant: async (...args: unknown[]) => {
          adminUserServiceCalls.grant = args;
          const [, userId, toolId, grant] = args as [unknown, string, string, Record<string, unknown>];
          return {
            userId,
            toolId,
            canDiscover: grant.canDiscover,
            canExecute: grant.canExecute,
            canViewResults: grant.canViewResults,
            canDownloadResults: grant.canDownloadResults,
            version: 1,
            unassignedInterventions: 0,
          };
        },
      },
    },
    {
      provide: SESSION_ROLE_RESOLVER,
      useValue: async (userId: string) => (userId === adminUserId ? "admin" : "manager"),
    },
    { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
    { provide: APP_GUARD, useClass: RequestProtectionGuard },
    { provide: APP_INTERCEPTOR, useClass: PublicOutputInterceptor },
    { provide: APP_FILTER, useClass: PublicExceptionFilter },
  ],
})
class AdminHttpSpecModule {}

test("AdminUsersController applies real guards and delegates a validated grant mutation", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = "synthetic-admin-http-session-secret-at-least-32-bytes";
  process.env.PUBLIC_APP_ORIGIN = "https://goldis.example";
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgres://synthetic:unused@127.0.0.1:5432/goldis_admin_http_test";

  let app: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  try {
    app = await createHttpApplication(AdminHttpSpecModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/admin/users?limit=101`;

    const anonymous = await fetch(endpoint);
    assert.equal(anonymous.status, 401);

    const manager = await fetch(endpoint, { headers: { cookie: signedSessionCookie(managerUserId) } });
    assert.equal(manager.status, 403);

    const admin = await fetch(endpoint, { headers: { cookie: signedSessionCookie(adminUserId) } });
    assert.equal(
      admin.status,
      400,
      "admin reaches the real controller's query validation without opening a DB connection",
    );
    assert.equal(((await admin.json()) as { message: string }).message, "Nieprawidłowy limit strony");

    const db = sequelize as unknown as { query: (sql: string, options?: unknown) => Promise<unknown> };
    const originalQuery = db.query;
    db.query = async (sql) => {
      if (sql.includes('SELECT name FROM "SequelizeMeta"'))
        return [{ name: "062-enrichment-worker-row-lock-capability.js" }];
      if (sql.includes('SELECT count(*)::int AS count FROM "SequelizeMeta"')) return [{ count: 62 }];
      if (sql.includes("FROM enrichment_worker_runtime_status")) return [];
      if (sql.includes("FROM enrichment_jobs WHERE tenant_id")) return [{ pendingCount: 0, oldestPendingAt: null }];
      if (sql.includes("FROM registry_provider_daily_budgets")) return [];
      throw new Error("UNEXPECTED_ADMIN_RUNTIME_QUERY");
    };
    try {
      const runtime = await fetch(`http://127.0.0.1:${address.port}/api/admin/runtime`, {
        headers: { cookie: signedSessionCookie(adminUserId) },
      });
      assert.equal(runtime.status, 200);
      const runtimeBody = (await runtime.json()) as {
        schema: { latestMigration: string; version: string; migrationCount: number };
        enrichment: { worker: { worker: string }; jobs: { pendingCount: number } };
      };
      assert.deepEqual(runtimeBody.schema, {
        latestMigration: "062-enrichment-worker-row-lock-capability.js",
        version: "062",
        migrationCount: 62,
      });
      assert.equal(runtimeBody.enrichment.worker.worker, "offline");
      assert.equal(runtimeBody.enrichment.jobs.pendingCount, 0);
    } finally {
      db.query = originalQuery;
    }

    const previousMembershipCount = TenantMembership.count;
    const previousToolCount = Tool.count;
    const originalOverviewQuery = db.query;
    const overviewQueries: Array<{ sql: string; options: unknown }> = [];
    (TenantMembership as unknown as { count: (...args: unknown[]) => Promise<number> }).count = async (options) => {
      assert.deepEqual(options, { where: { tenantId, status: "active" } });
      return 12;
    };
    (Tool as unknown as { count: (...args: unknown[]) => Promise<number> }).count = async () => 9;
    db.query = async (sql, options) => {
      overviewQueries.push({ sql, options });
      assert.equal((options as { replacements: { tenantId: string } }).replacements.tenantId, tenantId);
      return [{ count: sql.includes("mi.status = 'open'") ? 4 : 3 }];
    };
    try {
      const overview = await fetch(`http://127.0.0.1:${address.port}/api/admin/overview`, {
        headers: { cookie: signedSessionCookie(adminUserId) },
      });
      assert.equal(overview.status, 200);
      assert.deepEqual(await overview.json(), {
        userCount: 12,
        toolCount: 9,
        openInterventionCount: 4,
        activeRunCount: 3,
      });
      assert.equal(overviewQueries.length, 2);
      assert.ok(overviewQueries.some(({ sql }) => sql.includes("mi.status = 'open'")));
      assert.ok(overviewQueries.some(({ sql }) => sql.includes("r.status IN (:activeStatuses)")));
    } finally {
      db.query = originalOverviewQuery;
      (TenantMembership as unknown as { count: unknown }).count = previousMembershipCount;
      (Tool as unknown as { count: unknown }).count = previousToolCount;
    }

    const mutation = await fetch(`http://127.0.0.1:${address.port}/api/admin/users`, {
      method: "POST",
      headers: {
        origin: "https://goldis.example",
        cookie: signedSessionCookie(adminUserId),
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "synthetic", password: "unused" }),
    });
    assert.equal(mutation.status, 403, "cookie-authenticated admin mutation requires a valid CSRF token");

    const csrfToken = "synthetic-admin-http-csrf-token-0123456789abcdef";
    const grantResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/users/${managerUserId}/grants/oc`, {
      method: "PUT",
      headers: {
        origin: "https://goldis.example",
        cookie: signedSessionCookie(adminUserId),
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        canDiscover: false,
        canExecute: true,
        canViewResults: true,
        canDownloadResults: false,
        expectedVersion: 0,
        confirmationToken: "synthetic-confirmation",
        idempotencyKey: "synthetic-request-id",
      }),
    });
    assert.equal(grantResponse.status, 200);
    const grantBody = (await grantResponse.json()) as Record<string, unknown>;
    assert.deepEqual(
      {
        canDiscover: grantBody.canDiscover,
        canExecute: grantBody.canExecute,
        canViewResults: grantBody.canViewResults,
        canDownloadResults: grantBody.canDownloadResults,
        version: grantBody.version,
      },
      { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: false, version: 1 },
    );
    assert.equal("confirmationToken" in grantBody, false);
    assert.equal("idempotencyKey" in grantBody, false);
    assert.equal((adminUserServiceCalls.grant?.[0] as { userId?: string } | undefined)?.userId, adminUserId);
    assert.equal(adminUserServiceCalls.grant?.[1], managerUserId);
    assert.equal(adminUserServiceCalls.grant?.[2], "oc");
    assert.deepEqual(adminUserServiceCalls.grant?.[3], {
      canDiscover: true,
      canExecute: true,
      canViewResults: true,
      canDownloadResults: false,
      expectedVersion: 0,
      confirmationToken: "synthetic-confirmation",
      idempotencyKey: "synthetic-request-id",
    });
  } finally {
    await app?.close();
    await sequelize.close();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = previousOrigin;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
