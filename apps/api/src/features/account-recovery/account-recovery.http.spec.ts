import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { createHttpApplication } from "../../infrastructure/http";
import { RequestProtectionGuard } from "../../infrastructure/http/request-protection";
import { AuditService } from "../audit/public";
import {
  AuthController,
  AuthenticationRepository,
  AuthService,
  hashPassword,
  LoginRateLimiter,
  readSessionClaims,
  SessionGuard,
  SessionService,
} from "../auth";
import { PasswordRecoveryController, PasswordRecoveryService } from "./";

const calls: Array<{ operation: string; args: unknown[] }> = [];
const loginCalls: Array<{ operation: string; args: unknown[] }> = [];
const sessionCalls: Array<{ operation: string; args: unknown[] }> = [];
const auditedActions: string[] = [];
const loginRateLimiter = {
  async consumeAttempt(...args: unknown[]) {
    loginCalls.push({ operation: "consumeAttempt", args });
    return {
      allowed: true,
      retryAfterSeconds: 0,
      pairGeneration: "synthetic-pair",
      accountGeneration: "synthetic-account",
    };
  },
  async clearPair(...args: unknown[]) {
    loginCalls.push({ operation: "clearPair", args });
  },
  async recordFailure(...args: unknown[]) {
    loginCalls.push({ operation: "recordFailure", args });
  },
  async shouldSampleLoginFailure() {
    return false;
  },
};
const recoveryService = {
  requestPasswordReset: async (...args: unknown[]) => {
    calls.push({ operation: "requestPasswordReset", args });
    return { message: "Jeśli istnieje aktywne konto z tym adresem, wyślemy link do ustawienia nowego hasła." };
  },
  resetPassword: async (...args: unknown[]) => {
    calls.push({ operation: "resetPassword", args });
  },
  verifyRecoveryEmail: async (...args: unknown[]) => {
    calls.push({ operation: "verifyRecoveryEmail", args });
  },
};
const sessionService = {
  async logout(...args: unknown[]) {
    sessionCalls.push({ operation: "logout", args });
  },
};

@Module({
  controllers: [AuthController, PasswordRecoveryController],
  providers: [
    { provide: PasswordRecoveryService, useValue: recoveryService },
    { provide: LoginRateLimiter, useValue: loginRateLimiter },
    {
      provide: AuditService,
      useValue: {
        async record(input: { action: string }) {
          auditedActions.push(input.action);
        },
      },
    },
    AuthenticationRepository,
    AuthService,
    { provide: SessionService, useValue: sessionService },
    SessionGuard,
    { provide: APP_GUARD, useClass: RequestProtectionGuard },
  ],
})
class AuthRecoveryHttpSpecModule {}

test("login and logout HTTP issue and revoke only the active membership session", async () => {
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousRecoveryEnabled = process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED;
  const previousProvider = process.env.GOLDIS_EMAIL_PROVIDER;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.PUBLIC_APP_ORIGIN = "https://goldis.example";
  process.env.SESSION_SECRET = "synthetic-successful-http-login-session-secret";
  process.env.DATABASE_URL = "postgres://synthetic:unused@127.0.0.1:1/goldis_login_http_test";
  process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED = "0";
  process.env.GOLDIS_EMAIL_PROVIDER = "disabled";
  process.env.NODE_ENV = "production";

  const models = await import("../../infrastructure/database/db");
  const previousFindUser = models.User.findOne;
  const previousFindUserById = models.User.findByPk;
  const previousFindTenant = models.Tenant.findOne;
  const previousFindMembership = models.TenantMembership.findOne;
  const previousCreateSession = models.UserSession.create;
  const previousTransaction = models.sequelize.transaction;
  const previousQuery = models.sequelize.query;
  const userId = "11111111-1111-4111-8111-111111111111";
  const tenantId = "99999999-9999-4999-8999-999999999999";
  const password = "Synthetic-only HTTP Login Password!";
  const fakeUser = {
    userId,
    username: "Synthetic.Operator",
    usernameNormalized: "synthetic.operator",
    passwordHash: await hashPassword(password),
    status: "active",
    credentialRevision: 1,
    mustChangePassword: false,
    lastLoginAt: null as Date | null,
    async save() {
      this.lastLoginAt = new Date();
    },
  };
  const syntheticTransaction = {
    id: "synthetic-http-login-transaction",
    LOCK: { UPDATE: "UPDATE" },
    sequelize: models.sequelize,
  };
  const createdSessions: Array<Record<string, unknown>> = [];
  auditedActions.length = 0;
  sessionCalls.length = 0;
  loginCalls.length = 0;
  try {
    (models.User as unknown as { findOne: (...args: unknown[]) => Promise<unknown> }).findOne = async (
      options: unknown,
    ) => {
      assert.deepEqual(options, { where: { usernameNormalized: "synthetic.operator" } });
      return fakeUser;
    };
    (models.User as unknown as { findByPk: (...args: unknown[]) => Promise<unknown> }).findByPk = async (
      id: unknown,
    ) => {
      assert.equal(id, userId);
      return fakeUser;
    };
    (models.Tenant as unknown as { findOne: (...args: unknown[]) => Promise<unknown> }).findOne = async (
      options: unknown,
    ) => {
      assert.deepEqual(options, { where: { slug: "goldis" } });
      return { tenantId };
    };
    (models.TenantMembership as unknown as { findOne: (...args: unknown[]) => Promise<unknown> }).findOne = async (
      options: unknown,
    ) => {
      assert.deepEqual(options, {
        where: { userId, tenantId, status: "active" },
        attributes: ["role"],
        transaction: syntheticTransaction,
        lock: syntheticTransaction.LOCK.UPDATE,
      });
      return { role: "operator" };
    };
    (models.UserSession as unknown as { create: (...args: unknown[]) => Promise<unknown> }).create = async (
      values: unknown,
      options: unknown,
    ) => {
      assert.deepEqual(options, { transaction: syntheticTransaction });
      createdSessions.push(values as Record<string, unknown>);
      return values;
    };
    (models.sequelize as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
      sql: unknown,
    ) => {
      assert.match(String(sql), /pg_advisory_xact_lock/);
      return [];
    };
    (
      models.sequelize as unknown as {
        transaction: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
      }
    ).transaction = (callback) => callback(syntheticTransaction);

    const app = await createHttpApplication(AuthRecoveryHttpSpecModule, { logger: false });
    try {
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
        method: "POST",
        headers: { origin: "https://goldis.example", "content-type": "application/json" },
        body: JSON.stringify({ username: " Synthetic.Operator ", password }),
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as { role: string; csrfToken: string; mustChangePassword: boolean };
      assert.equal(body.role, "operator");
      assert.equal(body.mustChangePassword, false);
      assert.match(body.csrfToken, /^[A-Za-z0-9_-]{40,}$/);
      const setCookie = response.headers.get("set-cookie") ?? "";
      const sessionToken = setCookie.match(/goldis_session=([^;,\s]+)/)?.[1];
      const csrfCookie = setCookie.match(/goldis_csrf=([^;,\s]+)/)?.[1];
      assert.ok(sessionToken);
      assert.equal(csrfCookie, body.csrfToken);
      assert.match(setCookie, /goldis_session=[^;]+;[^\r\n]*HttpOnly; Secure; SameSite=Strict/);
      assert.equal(createdSessions.length, 1);
      assert.equal(createdSessions[0].userId, userId);
      assert.equal(createdSessions[0].tenantId, tenantId);
      assert.equal(createdSessions[0].credentialRevision, 1);
      assert.deepEqual(
        loginCalls.map((call) => call.operation),
        ["consumeAttempt", "clearPair"],
      );
      assert.equal(loginCalls[0].args[0], "Synthetic.Operator");
      assert.deepEqual(loginCalls[1].args.slice(0, 2), ["Synthetic.Operator", "127.0.0.1"]);
      assert.deepEqual(readSessionClaims({ headers: { cookie: `goldis_session=${sessionToken}` } } as never), {
        userId,
        tenantId,
        actorRef: userId,
        sessionId: createdSessions[0].sessionId,
        version: 2,
        csrf: body.csrfToken,
        exp: (JSON.parse(Buffer.from(sessionToken.split(".")[0], "base64url").toString("utf8")) as { exp: number }).exp,
      });

      const logout = await fetch(`http://127.0.0.1:${address.port}/api/auth/logout`, {
        method: "POST",
        headers: {
          origin: "https://goldis.example",
          cookie: `goldis_session=${sessionToken}; goldis_csrf=${csrfCookie}`,
        },
      });
      assert.equal(logout.status, 201);
      assert.deepEqual(await logout.json(), { ok: true });
      assert.equal(sessionCalls.length, 1);
      assert.equal(sessionCalls[0].operation, "logout");
      assert.deepEqual(sessionCalls[0].args[0], {
        userId,
        tenantId,
        actorRef: userId,
        sessionId: createdSessions[0].sessionId,
        version: 2,
        csrf: body.csrfToken,
        exp: (JSON.parse(Buffer.from(sessionToken.split(".")[0], "base64url").toString("utf8")) as { exp: number }).exp,
      });
      assert.deepEqual(auditedActions, ["login.succeeded"]);
      const clearedCookies = logout.headers.get("set-cookie") ?? "";
      assert.match(clearedCookies, /goldis_session=;/);
      assert.match(clearedCookies, /goldis_csrf=;/);
    } finally {
      await app.close();
    }
  } finally {
    (models.User as unknown as { findOne: unknown }).findOne = previousFindUser;
    (models.User as unknown as { findByPk: unknown }).findByPk = previousFindUserById;
    (models.Tenant as unknown as { findOne: unknown }).findOne = previousFindTenant;
    (models.TenantMembership as unknown as { findOne: unknown }).findOne = previousFindMembership;
    (models.UserSession as unknown as { create: unknown }).create = previousCreateSession;
    (models.sequelize as unknown as { transaction: unknown }).transaction = previousTransaction;
    (models.sequelize as unknown as { query: unknown }).query = previousQuery;
    await models.sequelize.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = previousOrigin;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousRecoveryEnabled === undefined) delete process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED;
    else process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED = previousRecoveryEnabled;
    if (previousProvider === undefined) delete process.env.GOLDIS_EMAIL_PROVIDER;
    else process.env.GOLDIS_EMAIL_PROVIDER = previousProvider;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("account recovery HTTP routes preserve origin protection, status, response and cookie contracts", async () => {
  const previousOrigin = process.env.PUBLIC_APP_ORIGIN;
  const previousRecoveryEnabled = process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED;
  const previousProvider = process.env.GOLDIS_EMAIL_PROVIDER;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.PUBLIC_APP_ORIGIN = "https://goldis.example";
  process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED = "0";
  process.env.GOLDIS_EMAIL_PROVIDER = "disabled";
  process.env.NODE_ENV = "test";
  calls.length = 0;
  const app = await createHttpApplication(AuthRecoveryHttpSpecModule, { logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const root = `http://127.0.0.1:${address.port}/api/auth`;
    const originHeaders = { origin: "https://goldis.example" };

    assert.equal(
      (await fetch(`${root}/forgot-password`, { method: "POST", body: JSON.stringify({ email: "a@example.test" }) }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(`${root}/forgot-password`, {
          method: "POST",
          headers: { origin: "https://attacker.example", "content-type": "application/json" },
          body: JSON.stringify({ email: "a@example.test" }),
        })
      ).status,
      403,
    );
    const forgot = await fetch(`${root}/forgot-password`, {
      method: "POST",
      headers: { ...originHeaders, "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.test" }),
    });
    assert.equal(forgot.status, 202);
    assert.deepEqual(await forgot.json(), {
      message: "Jeśli istnieje aktywne konto z tym adresem, wyślemy link do ustawienia nowego hasła.",
    });
    assert.equal(calls.at(-1)?.operation, "requestPasswordReset");
    assert.equal(
      (
        await fetch(`${root}/forgot-password`, {
          method: "POST",
          headers: { ...originHeaders, "content-type": "application/json" },
          body: JSON.stringify({ email: "a@example.test", unexpected: true }),
        })
      ).status,
      400,
    );

    const status = await fetch(`${root}/recovery-status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: false });

    const reset = await fetch(`${root}/reset-password`, {
      method: "POST",
      headers: { ...originHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: "synthetic-reset-token", newPassword: "Synthetic-only Password!123" }),
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true });
    const clearedCookies = reset.headers.get("set-cookie") ?? "";
    assert.match(clearedCookies, /goldis_session=/);
    assert.match(clearedCookies, /goldis_csrf=/);

    const verify = await fetch(`${root}/verify-recovery-email`, {
      method: "POST",
      headers: { ...originHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: "synthetic-verification-token" }),
    });
    assert.equal(verify.status, 200);
    assert.deepEqual(await verify.json(), { ok: true });
    assert.deepEqual(
      calls.filter((call) => call.operation !== "requestPasswordReset").map((call) => call.operation),
      ["resetPassword", "verifyRecoveryEmail"],
    );

    assert.equal(
      (
        await fetch(`${root}/login`, {
          method: "POST",
          headers: { ...originHeaders, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${root}/me`)).status, 401);
    assert.equal(
      (
        await fetch(`${root}/change-password`, {
          method: "POST",
          headers: { ...originHeaders, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${root}/change-password`, { method: "POST" })).status, 403);

    const logout = await fetch(`${root}/logout`, { method: "POST", headers: originHeaders });
    assert.equal(logout.status, 201);
    const logoutCookies = logout.headers.get("set-cookie") ?? "";
    assert.match(logoutCookies, /goldis_session=/);
    assert.match(logoutCookies, /goldis_csrf=/);
  } finally {
    await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = previousOrigin;
    if (previousRecoveryEnabled === undefined) delete process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED;
    else process.env.GOLDIS_PASSWORD_RECOVERY_ENABLED = previousRecoveryEnabled;
    if (previousProvider === undefined) delete process.env.GOLDIS_EMAIL_PROVIDER;
    else process.env.GOLDIS_EMAIL_PROVIDER = previousProvider;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
