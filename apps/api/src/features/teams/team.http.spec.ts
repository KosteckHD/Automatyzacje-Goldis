import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { createHttpApplication, RequestProtectionGuard } from "../../infrastructure/http";
import { PasswordRecoveryService } from "../account-recovery";
import { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard, type SessionPrincipal } from "../auth";
import { TeamController, TeamService } from "./";

const managerA = "11111111-1111-4111-8111-111111111111";
const managerB = "22222222-2222-4222-8222-222222222222";
const operator = "33333333-3333-4333-8333-333333333333";
const admin = "44444444-4444-4444-8444-444444444444";
const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const csrfToken = "synthetic-team-http-csrf-token-0123456789abcdef";
const calls: Array<{ operation: string; userId: string; tenantId: string; role: string; args: unknown[] }> = [];

function signedSessionCookie(userId: string, tenantId: string, csrf = csrfToken): string {
  const secret = process.env.SESSION_SECRET;
  assert.ok(secret);
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      sessionId,
      exp: Date.now() + 60_000,
      userId,
      tenantId,
      csrf,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
}

function record(operation: string, result: (principal: SessionPrincipal, args: unknown[]) => unknown) {
  return async (principal: SessionPrincipal, ...args: unknown[]) => {
    calls.push({ operation, userId: principal.userId, tenantId: principal.tenantId, role: principal.role, args });
    return result(principal, args);
  };
}

const teamService = {
  list: record("list", (principal, args) => ({ items: [{ tenantId: principal.tenantId, query: args[0] }] })),
  create: record("create", () => ({
    userId: targetUserId,
    role: "operator",
    status: "active",
    mustChangePassword: true,
  })),
  setStatus: record("setStatus", (_principal, args) => ({ userId: args[0], status: "disabled", revokedSessions: 2 })),
  resetPassword: record("resetPassword", (_principal, args) => ({
    userId: args[0],
    mustChangePassword: true,
    revokedSessions: 1,
  })),
  access: record("access", (_principal, args) => ({
    userId: args[0],
    toolId: "oc-policy-verification",
    canExecute: true,
    version: 3,
  })),
  setAccess: record("setAccess", (_principal, args) => ({
    userId: args[0],
    toolId: "oc-policy-verification",
    canExecute: true,
    version: 4,
  })),
};

const recoveryService = {
  enqueuePrivilegedResetLink: record("passwordResetLink", (_principal, args) => ({
    userId: args[0],
    status: "queued",
  })),
  setTargetRecoveryEmail: record("recoveryEmail", (_principal, args) => ({
    userId: args[0],
    status: "pending_verification",
  })),
};

@Module({
  controllers: [TeamController],
  providers: [
    { provide: TeamService, useValue: teamService },
    { provide: PasswordRecoveryService, useValue: recoveryService },
    SessionGuard,
    {
      provide: SESSION_ROLE_RESOLVER,
      useValue: async (userId: string, tenantId: string) => {
        if (userId === managerA && tenantId === tenantA) return "manager";
        if (userId === managerB && tenantId === tenantB) return "manager";
        if (userId === operator && tenantId === tenantA) return "operator";
        if (userId === admin && tenantId === tenantA) return "admin";
        return null;
      },
    },
    { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
    { provide: APP_GUARD, useClass: RequestProtectionGuard },
  ],
})
class TeamHttpSpecModule {}

test("TeamController preserves role, tenant, CSRF, route status and DTO contracts", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = "synthetic-team-http-session-secret-at-least-32-bytes";
  process.env.PUBLIC_APP_ORIGIN = "https://goldis.example";
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgres://synthetic:unused@127.0.0.1:1/goldis_team_http_test";
  calls.length = 0;

  const app = await createHttpApplication(TeamHttpSpecModule, { logger: false }, undefined, {
    trustProxyIps: undefined,
  });
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const root = `http://127.0.0.1:${address.port}/api/team/users`;
    const managerAHeaders = { cookie: signedSessionCookie(managerA, tenantA) };
    const managerAMutationHeaders = {
      ...managerAHeaders,
      origin: "https://goldis.example",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    };

    assert.equal((await fetch(root)).status, 401);
    assert.equal((await fetch(root, { headers: { cookie: signedSessionCookie(operator, tenantA) } })).status, 403);

    const listA = await fetch(`${root}?q=Alpha`, { headers: managerAHeaders });
    assert.equal(listA.status, 200);
    assert.deepEqual(await listA.json(), { items: [{ tenantId: tenantA, query: "Alpha" }] });
    const listB = await fetch(root, { headers: { cookie: signedSessionCookie(managerB, tenantB) } });
    assert.equal(listB.status, 200);
    assert.deepEqual(await listB.json(), { items: [{ tenantId: tenantB }] });

    const createBody = {
      username: "synthetic.operator",
      temporaryPassword: "unused",
      confirmationToken: "confirm",
      idempotencyKey: "create-1",
    };
    assert.equal(
      (
        await fetch(root, {
          method: "POST",
          headers: { ...managerAHeaders, origin: "https://goldis.example", "content-type": "application/json" },
          body: JSON.stringify(createBody),
        })
      ).status,
      403,
      "cookie-authenticated mutations require CSRF",
    );
    assert.equal(
      calls.some((call) => call.operation === "create"),
      false,
    );

    const created = await fetch(root, {
      method: "POST",
      headers: managerAMutationHeaders,
      body: JSON.stringify(createBody),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      userId: targetUserId,
      role: "operator",
      status: "active",
      mustChangePassword: true,
    });

    const status = await fetch(`${root}/${targetUserId}/status`, {
      method: "PATCH",
      headers: managerAMutationHeaders,
      body: JSON.stringify({ status: "disabled", confirmationToken: "confirm", idempotencyKey: "status-1" }),
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { userId: targetUserId, status: "disabled", revokedSessions: 2 });

    const password = await fetch(`${root}/${targetUserId}/password`, {
      method: "POST",
      headers: managerAMutationHeaders,
      body: JSON.stringify({ temporaryPassword: "unused", confirmationToken: "confirm", idempotencyKey: "password-1" }),
    });
    assert.equal(password.status, 201);
    assert.deepEqual(await password.json(), { userId: targetUserId, mustChangePassword: true, revokedSessions: 1 });

    const resetLink = await fetch(`${root}/${targetUserId}/password-reset-link`, {
      method: "POST",
      headers: managerAMutationHeaders,
      body: JSON.stringify({ confirmationToken: "confirm", idempotencyKey: "reset-link-1" }),
    });
    assert.equal(resetLink.status, 202);
    assert.deepEqual(await resetLink.json(), { userId: targetUserId, status: "queued" });

    const recoveryEmail = await fetch(`${root}/${targetUserId}/recovery-email`, {
      method: "POST",
      headers: managerAMutationHeaders,
      body: JSON.stringify({ email: "operator@example.test", confirmationToken: "confirm", idempotencyKey: "email-1" }),
    });
    assert.equal(recoveryEmail.status, 202);
    assert.deepEqual(await recoveryEmail.json(), { userId: targetUserId, status: "pending_verification" });

    const access = await fetch(`${root}/${targetUserId}/access`, { headers: managerAHeaders });
    assert.equal(access.status, 200);
    assert.deepEqual(await access.json(), {
      userId: targetUserId,
      toolId: "oc-policy-verification",
      canExecute: true,
      version: 3,
    });
    const accessUpdate = await fetch(`${root}/${targetUserId}/access`, {
      method: "PUT",
      headers: managerAMutationHeaders,
      body: JSON.stringify({
        canExecute: true,
        expectedVersion: 3,
        confirmationToken: "confirm",
        idempotencyKey: "access-1",
      }),
    });
    assert.equal(accessUpdate.status, 200);
    assert.deepEqual(await accessUpdate.json(), {
      userId: targetUserId,
      toolId: "oc-policy-verification",
      canExecute: true,
      version: 4,
    });

    assert.deepEqual(
      calls.map((call) => call.operation),
      [
        "list",
        "list",
        "create",
        "setStatus",
        "resetPassword",
        "passwordResetLink",
        "recoveryEmail",
        "access",
        "setAccess",
      ],
    );
    assert.deepEqual(
      calls.filter((call) => call.operation !== "list").map((call) => [call.userId, call.tenantId, call.role]),
      Array.from({ length: 7 }, () => [managerA, tenantA, "manager"]),
    );
    assert.deepEqual(
      calls.slice(0, 2).map((call) => [call.userId, call.tenantId, call.role]),
      [
        [managerA, tenantA, "manager"],
        [managerB, tenantB, "manager"],
      ],
    );
    assert.deepEqual(calls[2].args[0], createBody);
    const grantCall = calls.at(-1);
    assert.ok(grantCall);
    assert.equal((grantCall.args[1] as { expectedVersion: number }).expectedVersion, 3);
  } finally {
    await app.close();
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
