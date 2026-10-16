import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasRecentUserActivitySignal,
  isIdleSessionExpired,
  isSupportedGoldisRole,
  SessionService,
} from "./session.service";

test("session expiry uses the exact idle boundary and trusts only the explicit activity signal", () => {
  const now = Date.now();
  assert.equal(isIdleSessionExpired(new Date(now - 30 * 60_000 + 1), now), false);
  assert.equal(isIdleSessionExpired(new Date(now - 30 * 60_000), now), true);
  assert.equal(hasRecentUserActivitySignal({ headers: { "x-goldis-user-activity": "1" } }), true);
  assert.equal(hasRecentUserActivitySignal({ headers: { "x-goldis-user-activity": "true" } }), false);
  assert.equal(hasRecentUserActivitySignal({ headers: {} }), false);
});

test("session service accepts only the known membership roles", () => {
  for (const role of ["admin", "manager", "operator", "reviewer", "auditor"]) {
    assert.equal(isSupportedGoldisRole(role), true);
  }
  for (const role of ["owner", "superuser", null, undefined, 1]) {
    assert.equal(isSupportedGoldisRole(role), false);
  }
});

test("session service delegates persistent session resolution to IdentityRepository", async () => {
  const calls: unknown[][] = [];
  const identity = {
    resolveCurrentSessionRole: async (...args: unknown[]) => {
      calls.push(args);
      return "reviewer";
    },
    findActiveMembershipRole: async () => "operator",
    findPasswordChangeRequired: async () => true,
  };
  const service = new SessionService(identity as never);
  assert.equal(await service.resolveCurrentSessionRole("user", "tenant", "session", true), "reviewer");
  assert.deepEqual(calls, [["user", "tenant", "session", true]]);
  assert.equal(await service.resolveActiveSessionRole("user", "tenant"), "operator");
  assert.equal(await service.resolveMustChangePassword("user"), true);
});

test("session service owns session listing, logout and owned-session revocation use cases", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const identity = {
    async logoutSession(input: unknown) {
      calls.push({ method: "logoutSession", input });
      return true;
    },
    async listUserSessions(userId: string, tenantId: string) {
      calls.push({ method: "listUserSessions", input: { userId, tenantId } });
      return [
        {
          sessionId: "session-current",
          createdAt: new Date("2026-10-01T00:00:00.000Z"),
          lastSeenAt: new Date("2026-10-01T00:01:00.000Z"),
          expiresAt: new Date("2026-10-01T08:00:00.000Z"),
          revokedAt: null,
          browserLabel: "Chrome · Windows",
        },
      ];
    },
    async revokeOwnedSession(input: unknown) {
      calls.push({ method: "revokeOwnedSession", input });
      return true;
    },
  };
  const service = new SessionService(identity as never);
  await service.logout({ userId: "user-a", tenantId: "tenant-a", sessionId: "session-a" });
  const listed = await service.listSessions("user-a", "tenant-a", "session-current");
  const revoked = await service.revokeSession({ userId: "user-a", tenantId: "tenant-a", sessionId: "session-b" });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["logoutSession", "listUserSessions", "revokeOwnedSession"],
  );
  assert.deepEqual(calls[0].input, {
    userId: "user-a",
    tenantId: "tenant-a",
    sessionId: "session-a",
    now: (calls[0].input as { now: Date }).now,
  });
  assert.ok((calls[0].input as { now: Date }).now instanceof Date);
  assert.deepEqual(
    listed.items.map((item) => item.isCurrent),
    [true],
  );
  assert.equal(revoked, true);
  assert.equal((calls[2].input as { sessionId: string }).sessionId, "session-b");
  assert.ok((calls[2].input as { now: Date }).now instanceof Date);
});
