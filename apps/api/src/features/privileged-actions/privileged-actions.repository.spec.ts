import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sequelize, Transaction } from "sequelize";
import { PrivilegedActionRepository } from "./privileged-actions.repository";

const actor = {
  exp: Date.now() + 60_000,
  csrf: "synthetic-csrf-token-for-privileged-action-test-1234567890",
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  actorRef: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  version: 2 as const,
  role: "admin" as const,
};

test("PrivilegedActionRepository scopes reauthentication context to actor, tenant and session", async () => {
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  const database = {
    async query(sql: string, options: { replacements: Record<string, unknown> }) {
      calls.push({ sql, replacements: options.replacements });
      if (sql.includes("FROM users")) return [{ passwordHash: "hash", credentialRevision: 4, status: "active" }];
      if (sql.includes("FROM tenant_memberships")) return [{ role: "admin", status: "active" }];
      if (sql.includes("FROM user_sessions"))
        return [{ credentialRevision: 4, expiresAt: new Date(Date.now() + 60_000), revokedAt: null }];
      throw new Error("UNEXPECTED_PRIVILEGED_ACTION_QUERY");
    },
  } as unknown as Sequelize;
  const repository = new PrivilegedActionRepository(database);

  const result = await repository.loadReauthenticationContext(actor);

  assert.equal(result.user?.passwordHash, "hash");
  assert.equal(result.membership?.role, "admin");
  assert.equal(result.session?.credentialRevision, 4);
  assert.deepEqual(
    calls.map((call) => Object.keys(call.replacements).sort()),
    [["userId"], ["tenantId", "userId"], ["sessionId", "tenantId", "userId"]],
  );
});

test("PrivilegedActionRepository preserves advisory, user, membership and session lock order", async () => {
  const calls: string[] = [];
  const database = {
    async query(sql: string) {
      calls.push(
        sql.includes("FROM users") ? "user" : sql.includes("FROM tenant_memberships") ? "membership" : "session",
      );
      if (sql.includes("FROM users")) return [{ passwordHash: "hash", credentialRevision: 4, status: "active" }];
      if (sql.includes("FROM tenant_memberships")) return [{ role: "admin", status: "active" }];
      return [{ credentialRevision: 4, expiresAt: new Date(Date.now() + 60_000), revokedAt: null }];
    },
  } as unknown as Sequelize;
  const transaction = {
    sequelize: {
      async query(sql: string) {
        assert.match(sql, /pg_advisory_xact_lock/);
        calls.push("advisory");
      },
    },
  } as unknown as Transaction;
  const repository = new PrivilegedActionRepository(database);

  const result = await repository.lockActorForConfirmation(actor, transaction);

  assert.deepEqual(calls, ["advisory", "user", "membership", "session"]);
  assert.equal(result.user?.credentialRevision, 4);
  assert.equal(result.session?.revokedAt, null);
});

test("PrivilegedActionRepository inserts a confirmation and prunes old rows in the caller transaction", async () => {
  const calls: Array<{ sql: string; options: { replacements: Record<string, unknown>; transaction?: unknown } }> = [];
  const database = {
    async query(sql: string, options: { replacements: Record<string, unknown>; transaction?: unknown }) {
      calls.push({ sql, options });
      return [];
    },
  } as unknown as Sequelize;
  const repository = new PrivilegedActionRepository(database);
  const transaction = {} as Transaction;
  const now = new Date("2026-10-16T12:00:00.000Z");

  await repository.insertConfirmation(
    {
      actor,
      confirmationId: "55555555-5555-4555-8555-555555555555",
      action: "admin.user.password",
      targetId: "33333333-3333-4333-8333-333333333333",
      payloadFingerprint: "a".repeat(64),
      tokenHash: "b".repeat(64),
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      credentialRevision: 4,
      now,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    },
    transaction,
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /^\s*DELETE FROM privileged_action_confirmations/);
  assert.match(calls[1].sql, /INSERT INTO privileged_action_confirmations/);
  assert.ok(calls.every((call) => call.options.transaction === transaction));
  assert.equal((calls[0].options.replacements.retentionCutoff as Date).toISOString(), "2026-10-15T12:00:00.000Z");
  assert.equal(calls[1].options.replacements.credentialRevision, 4);
});
