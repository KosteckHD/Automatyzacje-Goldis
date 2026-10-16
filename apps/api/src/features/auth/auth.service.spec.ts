import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthService } from "./auth.service";
import { hashPassword } from "./password-hash";

test("AuthService case-folds the account name and persists a bounded login session", async () => {
  const password = "Synthetic-only AuthService Password!";
  const passwordHash = await hashPassword(password);
  const persistenceCalls: Array<Record<string, unknown>> = [];
  const repository = {
    async findLoginUser(usernameNormalized: string) {
      assert.equal(usernameNormalized, "synthetic.operator");
      return {
        userId: "11111111-1111-4111-8111-111111111111",
        username: "Synthetic.Operator",
        passwordHash,
        status: "active",
        credentialRevision: 7,
      };
    },
    async findGoldisTenant() {
      return { tenantId: "99999999-9999-4999-8999-999999999999" };
    },
    async persistLoginSession(input: Record<string, unknown>) {
      persistenceCalls.push(input);
      return { role: "operator", mustChangePassword: true };
    },
  };

  const result = await new AuthService(repository as never).login(
    "Synthetic.Operator",
    password,
    "Mozilla/5.0 (Windows NT 10.0) Chrome/124.0",
  );

  assert.deepEqual(
    {
      userId: result.userId,
      tenantId: result.tenantId,
      role: result.role,
      mustChangePassword: result.mustChangePassword,
    },
    {
      userId: "11111111-1111-4111-8111-111111111111",
      tenantId: "99999999-9999-4999-8999-999999999999",
      role: "operator",
      mustChangePassword: true,
    },
  );
  assert.match(result.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(persistenceCalls.length, 1);
  const saved = persistenceCalls[0];
  assert.equal(saved.expectedPasswordHash, passwordHash);
  assert.equal(saved.expectedCredentialRevision, 7);
  assert.equal(saved.upgradedPasswordHash, null);
  assert.equal((saved.expiresAt as Date).getTime() - (saved.now as Date).getTime(), 8 * 60 * 60 * 1000);
  assert.equal(saved.browserLabel, "Chrome · Windows");
});

test("AuthService rejects invalid credentials before loading a tenant or creating a session", async () => {
  const passwordHash = await hashPassword("Synthetic-only AuthService Password!");
  let tenantLookups = 0;
  let sessionWrites = 0;
  const repository = {
    async findLoginUser() {
      return {
        userId: "11111111-1111-4111-8111-111111111111",
        passwordHash,
        status: "active",
        credentialRevision: 1,
      };
    },
    async findGoldisTenant() {
      tenantLookups += 1;
      return { tenantId: "99999999-9999-4999-8999-999999999999" };
    },
    async persistLoginSession() {
      sessionWrites += 1;
      throw new Error("session persistence must not run");
    },
  };

  await assert.rejects(
    new AuthService(repository as never).login("synthetic.operator", "Wrong synthetic password"),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 401,
  );
  assert.equal(tenantLookups, 0);
  assert.equal(sessionWrites, 0);
});

test("AuthService prepares a new session and persists password rotation for the same principal", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "synthetic-auth-service-session-secret-32-bytes";
  const currentPassword = "Synthetic-only Current Password!";
  const newPassword = "Synthetic-only New Password!";
  const expectedHash = await hashPassword(currentPassword);
  let persisted: Record<string, unknown> | null = null;
  const repository = {
    async findPasswordUser(userId: string) {
      assert.equal(userId, "11111111-1111-4111-8111-111111111111");
      return {
        userId,
        passwordHash: expectedHash,
        status: "active",
        credentialRevision: 12,
      };
    },
    async persistPasswordChange(input: Record<string, unknown>) {
      persisted = input;
    },
  };
  try {
    const result = await new AuthService(repository as never).changePassword(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        tenantId: "99999999-9999-4999-8999-999999999999",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
      currentPassword,
      newPassword,
      "Mozilla/5.0 (Windows NT 10.0) Chrome/124.0",
    );
    assert.ok(persisted);
    const input = persisted as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(result.sessionToken.split(".")[0], "base64url").toString("utf8")) as {
      sessionId: string;
      userId: string;
      tenantId: string;
      csrf: string;
    };
    assert.equal(payload.sessionId, input.nextSessionId);
    assert.equal(payload.userId, input.userId);
    assert.equal(payload.tenantId, input.tenantId);
    assert.equal(payload.csrf, result.csrfToken);
    assert.equal(input.currentSessionId, "22222222-2222-4222-8222-222222222222");
    assert.equal(input.expectedPasswordHash, expectedHash);
    assert.equal(input.expectedCredentialRevision, 12);
    assert.equal((input.expiresAt as Date).getTime() - (input.now as Date).getTime(), 8 * 60 * 60 * 1000);
    assert.equal(input.browserLabel, "Chrome · Windows");
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});
