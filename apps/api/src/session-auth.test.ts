import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthController, readSessionClaims, verifyCsrfRequest } from "./session";
import { hashPassword } from "./password-hash";

test("login pobiera rolę z członkostwa i wydaje sesję z userId/tenantId bez claims roli", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.SESSION_SECRET = "synthetic-session-secret-for-auth-login-tests";
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  process.env.NODE_ENV = "production";

  const userId = "11111111-1111-4111-8111-111111111111";
  const tenantId = "99999999-9999-4999-8999-999999999999";
  const password = "Synthetic-only Login Password!";
  const fakeUser = {
    userId,
    username: "Synthetic.Operator",
    usernameNormalized: "synthetic.operator",
    passwordHash: await hashPassword(password),
    status: "active",
    lastLoginAt: null as Date | null,
    async save() { this.lastLoginAt = new Date(); },
  };

  let models: typeof import("./db") | undefined;
  let previousFindUser: unknown;
  let previousFindTenant: unknown;
  let previousFindMembership: unknown;
  let previousCreateSession: unknown;
  let previousCreateAudit: unknown;
  let previousTransaction: unknown;
  try {
    models = await import("./db");
    previousFindUser = models.User.findOne;
    previousFindTenant = models.Tenant.findOne;
    previousFindMembership = models.TenantMembership.findOne;
    previousCreateSession = models.UserSession.create;
    previousCreateAudit = models.AuditEvent.create;
    previousTransaction = models.sequelize.transaction;
    (models.User as unknown as { findOne: (...args: unknown[]) => Promise<unknown> }).findOne = async (options: unknown) => {
      assert.deepEqual(options, { where: { usernameNormalized: "synthetic.operator", status: "active" } });
      return fakeUser;
    };
    (models.Tenant as unknown as { findOne: (...args: unknown[]) => Promise<unknown> }).findOne = async (options: unknown) => {
      assert.deepEqual(options, { where: { slug: "goldis" } });
      return { tenantId };
    };
    (models.TenantMembership as unknown as { findOne: (...args: unknown[]) => Promise<unknown> }).findOne = async (options: unknown) => {
      assert.deepEqual(options, {
        where: { userId, tenantId, status: "active" }, attributes: ["role"],
      });
      return { role: "operator" };
    };
    (models.UserSession as unknown as { create: (...args: unknown[]) => Promise<unknown> }).create = async (values: unknown, options: unknown) => {
      assert.deepEqual(options, { transaction: syntheticTransaction });
      assert.equal((values as { userId: string }).userId, userId);
      assert.equal((values as { tenantId: string }).tenantId, tenantId);
      return values;
    };
    (models.AuditEvent as unknown as { create: (...args: unknown[]) => Promise<unknown> }).create = async (values: unknown) => values;
    const syntheticTransaction = { id: "synthetic-transaction" };
    (models.sequelize as unknown as { transaction: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).transaction =
      (callback) => callback(syntheticTransaction);

    const cookies: Record<string, { value: string; options: Record<string, unknown> }> = {};
    const response = {
      cookie(name: string, value: string, options: Record<string, unknown>) {
        cookies[name] = { value, options };
      },
      setHeader() {},
    };
    const limiter = {
      async consumeAttempt(username: string, ip: string) { assert.equal(username, "Synthetic.Operator"); assert.ok(ip); return { allowed: true, retryAfterSeconds: 0 }; },
      async clearPair(username: string, ip: string) { assert.equal(username, "Synthetic.Operator"); assert.ok(ip); },
    };
    const result = await new AuthController(limiter as never).login(
      { username: " Synthetic.Operator ", password }, { ip: "203.0.113.10", headers: {} } as never, response as never,
    );
    assert.equal(result.role, "operator");
    assert.equal(result.csrfToken.length >= 40, true);
    assert.equal(cookies.goldis_session.options.httpOnly, true);
    assert.equal(cookies.goldis_session.options.secure, true);
    assert.equal(cookies.goldis_csrf.options.httpOnly, false);

    const payloadText = Buffer.from(cookies.goldis_session.value.split(".")[0], "base64url").toString("utf8");
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["csrf", "exp", "sessionId", "tenantId", "userId", "v"]);
    assert.equal(payload.v, 2);
    assert.equal(typeof payload.sessionId, "string");
    assert.equal(payload.userId, userId);
    assert.equal(payload.tenantId, tenantId);
    assert.equal(Object.values(payload).includes(password), false);
    const request = {
      headers: {
        cookie: `goldis_session=${cookies.goldis_session.value}; goldis_csrf=${cookies.goldis_csrf.value}`,
        "x-csrf-token": result.csrfToken,
      },
    } as never;
    assert.equal(readSessionClaims(request)?.actorRef, userId);
    assert.equal(verifyCsrfRequest(request), true);
    assert.ok(fakeUser.lastLoginAt instanceof Date);
  } finally {
    if (models) {
      (models.User as unknown as { findOne: unknown }).findOne = previousFindUser;
      (models.Tenant as unknown as { findOne: unknown }).findOne = previousFindTenant;
      (models.TenantMembership as unknown as { findOne: unknown }).findOne = previousFindMembership;
      (models.UserSession as unknown as { create: unknown }).create = previousCreateSession;
      (models.AuditEvent as unknown as { create: unknown }).create = previousCreateAudit;
      (models.sequelize as unknown as { transaction: unknown }).transaction = previousTransaction;
      await models.sequelize.close();
    }
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("login zwraca 429 i Retry-After po przekroczeniu limitu bez sprawdzania hasła", async () => {
  const headers: Record<string, string> = {};
  const limiter = {
    async consumeAttempt() { return { allowed: false, retryAfterSeconds: 91 }; },
    async clearPair() { throw new Error("nie powinno być wywołane"); },
  };
  const response = { setHeader(name: string, value: string) { headers[name] = value; } };
  await assert.rejects(new AuthController(limiter as never).login(
    { username: "synthetic.operator", password: "synthetic bad password" },
    { ip: "203.0.113.21" } as never,
    response as never,
  ), (error: { getStatus?: () => number }) => error.getStatus?.() === 429);
  assert.equal(headers["Retry-After"], "91");
});
