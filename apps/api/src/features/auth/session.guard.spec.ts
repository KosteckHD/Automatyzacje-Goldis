import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import { hasRecentUserActivitySignal, isIdleSessionExpired } from "../identity";
import { SessionGuard } from "./session.guard";
import { verifyCsrfRequest } from "./session-principal";

const testSecret = "session-guard-synthetic-secret-for-tests";
const csrf = "synthetic-csrf-token-for-session-tests-1234567890";
const tenantId = "99999999-9999-4999-8999-999999999999";
const identities = {
  admin: "11111111-1111-4111-8111-111111111111",
  operator: "22222222-2222-4222-8222-222222222222",
  auditor: "33333333-3333-4333-8333-333333333333",
  disabled: "44444444-4444-4444-8444-444444444444",
};

function signedCookie(userId: string, exp = Date.now() + 60_000, forgedRole?: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp,
      userId,
      tenantId,
      csrf,
      ...(forgedRole ? { role: forgedRole, actorRef: "forged-actor" } : {}),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", testSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}`;
}

function context(cookie?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ path: "/api/runs", headers: cookie ? { cookie } : {} }) }),
  } as unknown as ExecutionContext;
}

test("CSRF sprawdza podpis i double-submit; rola z ciasteczka nie zmienia wyniku", () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = testSecret;
  try {
    const validCookie = signedCookie(identities.admin, Date.now() + 60_000, "operator");
    const valid = { headers: { cookie: `${validCookie}; goldis_csrf=${csrf}`, "x-csrf-token": csrf } };
    assert.equal(verifyCsrfRequest(valid as never), true);
    assert.equal(
      verifyCsrfRequest({ headers: { cookie: `${validCookie}; goldis_csrf=other`, "x-csrf-token": csrf } } as never),
      false,
    );
    assert.equal(verifyCsrfRequest({ headers: { cookie: `${validCookie}; goldis_csrf=${csrf}` } } as never), false);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("idle timeout wygasa dokładnie po 30 minutach, a sygnał aktywności jest jawny", () => {
  const now = Date.now();
  assert.equal(isIdleSessionExpired(new Date(now - 30 * 60_000 + 1), now), false);
  assert.equal(isIdleSessionExpired(new Date(now - 30 * 60_000), now), true);
  assert.equal(hasRecentUserActivitySignal({ headers: { "x-goldis-user-activity": "1" } } as never), true);
  assert.equal(hasRecentUserActivitySignal({ headers: { "x-goldis-user-activity": "true" } } as never), false);
  assert.equal(hasRecentUserActivitySignal({ headers: {} } as never), false);
});

test("rola i aktor pochodzą z aktywnego członkostwa, a nie z claims ciasteczka", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = testSecret;
  const roles = new Map<string, "admin" | "manager" | "operator" | "auditor">([
    [identities.admin, "admin"],
    [identities.operator, "operator"],
    [identities.auditor, "auditor"],
    ["55555555-5555-4555-8555-555555555555", "manager"],
  ]);
  const guard = new SessionGuard(
    async (userId, requestedTenantId) => (requestedTenantId === tenantId ? (roles.get(userId) ?? null) : null),
    async () => false,
  );
  try {
    await assert.rejects(
      guard.canActivate(context()),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 401,
    );
    await assert.rejects(
      guard.canActivate(context(signedCookie(identities.disabled))),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 401,
    );
    const operatorRequest = { headers: { cookie: signedCookie(identities.operator, Date.now() + 60_000, "admin") } };
    const operatorContext = {
      switchToHttp: () => ({ getRequest: () => operatorRequest }),
    } as unknown as ExecutionContext;
    assert.equal(await guard.canActivate(operatorContext), true);
    assert.equal(
      (operatorRequest as { goldisPrincipal?: { role?: string; actorRef?: string } }).goldisPrincipal?.role,
      "operator",
    );
    assert.equal(
      (operatorRequest as { goldisPrincipal?: { actorRef?: string } }).goldisPrincipal?.actorRef,
      identities.operator,
    );
    const auditorRequest = { headers: { cookie: signedCookie(identities.auditor, Date.now() + 60_000, "admin") } };
    const auditorContext = {
      switchToHttp: () => ({ getRequest: () => auditorRequest }),
    } as unknown as ExecutionContext;
    assert.equal(await guard.canActivate(auditorContext), true);
    assert.equal((auditorRequest as { goldisPrincipal?: { role?: string } }).goldisPrincipal?.role, "auditor");
    const managerId = "55555555-5555-4555-8555-555555555555";
    const managerRequest = { headers: { cookie: signedCookie(managerId, Date.now() + 60_000, "admin") } };
    const managerContext = {
      switchToHttp: () => ({ getRequest: () => managerRequest }),
    } as unknown as ExecutionContext;
    assert.equal(await guard.canActivate(managerContext), true);
    assert.equal((managerRequest as { goldisPrincipal?: { role?: string } }).goldisPrincipal?.role, "manager");
    await assert.rejects(
      guard.canActivate(context(signedCookie(identities.admin, Date.now() - 1))),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 401,
    );
    await assert.rejects(
      guard.canActivate(context(`${signedCookie(identities.admin)}x`)),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 401,
    );

    const request = { headers: { cookie: signedCookie(identities.admin, Date.now() + 60_000, "auditor") } } as never;
    const adminContext = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    assert.equal(await guard.canActivate(adminContext), true);
    assert.deepEqual((request as { goldisPrincipal?: unknown }).goldisPrincipal, {
      exp: (request as { goldisPrincipal: { exp: number } }).goldisPrincipal.exp,
      csrf,
      userId: identities.admin,
      tenantId,
      actorRef: identities.admin,
      role: "admin",
    });
    const passwordChangeGuard = new SessionGuard(
      async () => "operator",
      async () => true,
    );
    const protectedRequest = { path: "/api/runs", headers: { cookie: signedCookie(identities.operator) } };
    await assert.rejects(
      passwordChangeGuard.canActivate({
        switchToHttp: () => ({ getRequest: () => protectedRequest }),
      } as unknown as ExecutionContext),
      (error: { getStatus?: () => number; message?: string }) =>
        error.getStatus?.() === 403 && error.message === "PASSWORD_CHANGE_REQUIRED",
    );
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("SessionGuard przekazuje sygnał aktywności tylko gdy nagłówek ma oczekiwaną wartość", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = testSecret;
  let observedActivity: boolean | undefined;
  const guard = new SessionGuard(
    async (_userId, _tenantId, _sessionId, activity) => {
      observedActivity = activity;
      return "operator";
    },
    async () => false,
  );
  try {
    const request = {
      path: "/api/runs",
      headers: { cookie: signedCookie(identities.operator), "x-goldis-user-activity": "1" },
    };
    assert.equal(
      await guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext),
      true,
    );
    assert.equal(observedActivity, true);
    request.headers["x-goldis-user-activity"] = "true";
    assert.equal(
      await guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext),
      true,
    );
    assert.equal(observedActivity, false);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});
