import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryTypes } from "sequelize";

process.env.DATABASE_URL ??= "postgres://goldis_privileged_test:unused@127.0.0.1:1/goldis_privileged_test";
process.env.PRIVILEGED_ACTION_BINDING_KEY = "synthetic-privileged-action-binding-key-32-bytes-minimum";

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
const action = "admin.user.password";
const targetId = "33333333-3333-4333-8333-333333333333";
const idempotencyKey = "44444444-4444-4444-8444-444444444444";
const payload = { temporaryPassword: "Synthetic-new-password-2026!" };
const token = "55555555-5555-4555-8555-555555555555.synthetic-token-secret-123456789012345678901234567890";

async function modules() {
  const actions = await import("./privileged-actions.service");
  const { sequelize } = await import("../../infrastructure/database/db");
  return { ...actions, sequelize };
}

test("potwierdzenie admina jest ograniczone do dozwolonej roli, akcji, tenantowego celu i payloadu", async () => {
  const { privilegedActionAllowed, privilegedActionFingerprint } = await modules();
  assert.equal(privilegedActionAllowed("manager", "team.user.create"), true);
  assert.equal(privilegedActionAllowed("admin", "team.user.create"), true);
  assert.equal(privilegedActionAllowed("manager", "team.user.recovery-link"), true);
  assert.equal(privilegedActionAllowed("manager", "team.user.recovery-email"), true);
  assert.equal(privilegedActionAllowed("operator", "team.user.recovery-link"), false);
  assert.equal(privilegedActionAllowed("admin", "admin.user.recovery-link"), true);
  assert.equal(privilegedActionAllowed("manager", "admin.user.recovery-email"), false);
  assert.equal(privilegedActionAllowed("manager", "admin.user.role"), false);
  assert.equal(privilegedActionAllowed("operator", "team.user.status"), false);
  assert.equal(privilegedActionAllowed("admin", "unknown.action"), false);
  assert.equal(
    privilegedActionFingerprint(action, targetId, { b: 2, a: 1 }),
    privilegedActionFingerprint(action, targetId, { a: 1, b: 2 }),
  );
  assert.notEqual(
    privilegedActionFingerprint(action, targetId, payload),
    privilegedActionFingerprint(action, `${targetId}/other`, payload),
  );
  assert.notEqual(
    privilegedActionFingerprint(action, targetId, payload),
    privilegedActionFingerprint("admin.user.role", targetId, payload),
  );
});

test("mutacja zużywa potwierdzenie raz i bezpiecznie odtwarza jej wynik dla tego samego klucza idempotencji", async () => {
  const { sequelize, runConfirmedPrivilegedAction, hashPrivilegedActionToken, privilegedActionFingerprint } =
    await modules();
  const originalQuery = sequelize.query;
  const expiresAt = new Date(Date.now() + 60_000);
  const row: Record<string, unknown> = {
    confirmationId: "55555555-5555-4555-8555-555555555555",
    tenantId: actor.tenantId,
    userId: actor.userId,
    sessionId: actor.sessionId,
    credentialRevision: 4,
    action,
    targetId,
    payloadFingerprint: privilegedActionFingerprint(action, targetId, payload),
    idempotencyKey,
    expiresAt,
    consumedAt: null,
    response: null,
    tokenHash: hashPrivilegedActionToken(token),
  };
  const transaction = { id: "synthetic-privileged-action-transaction" } as never;
  let businessCalls = 0;
  let completionUsedSelectQuery = false;
  let activeRevision = 4;
  (sequelize as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
    sql: unknown,
    options?: unknown,
  ) => {
    const query = String(sql);
    const queryOptions = options as { replacements?: Record<string, unknown>; type?: unknown } | undefined;
    if (query.includes("JOIN user_sessions s ON s.user_id")) {
      return [
        {
          userStatus: "active",
          userRevision: activeRevision,
          membershipStatus: "active",
          role: "admin",
          sessionRevision: activeRevision,
          sessionExpiresAt: expiresAt,
          sessionRevokedAt: null,
        },
      ];
    }
    if (query.includes("FROM privileged_action_confirmations")) {
      const replacements = queryOptions?.replacements ?? {};
      if (replacements.confirmationId !== row.confirmationId || replacements.tokenHash !== row.tokenHash) return [];
      return [row];
    }
    if (query.includes("SET consumed_at")) {
      if (row.consumedAt) return [0, {}];
      row.consumedAt = queryOptions?.replacements?.now;
      return [1, {}];
    }
    if (query.includes("SET response")) {
      completionUsedSelectQuery = queryOptions?.type === QueryTypes.SELECT;
      row.response = JSON.parse(String(queryOptions?.replacements?.response));
      return [{ confirmationId: row.confirmationId }];
    }
    throw new Error("UNEXPECTED_PRIVILEGED_ACTION_SQL");
  };
  try {
    const input = { actor, action, targetId, payload, token, idempotencyKey, transaction };
    const first = await runConfirmedPrivilegedAction(input, async () => {
      businessCalls += 1;
      return { userId: targetId, mustChangePassword: true };
    });
    assert.deepEqual(first, { userId: targetId, mustChangePassword: true });
    const replay = await runConfirmedPrivilegedAction(input, async () => {
      businessCalls += 1;
      return { impossible: true };
    });
    assert.deepEqual(replay, first);
    assert.equal(businessCalls, 1, "replay cannot execute the underlying update twice");
    await assert.rejects(() =>
      runConfirmedPrivilegedAction({ ...input, idempotencyKey: "66666666-6666-4666-8666-666666666666" }, async () => ({
        unexpected: true,
      })),
    );
    await assert.rejects(() =>
      runConfirmedPrivilegedAction(
        { ...input, payload: { temporaryPassword: "Different-password-2026!" } },
        async () => ({ unexpected: true }),
      ),
    );
    activeRevision = 5;
    await assert.rejects(
      () => runConfirmedPrivilegedAction(input, async () => ({ unexpected: true })),
      /potwierdzenie/i,
    );
    assert.equal(businessCalls, 1, "credential revision changes invalidate outstanding confirmations");
    assert.equal(
      completionUsedSelectQuery,
      true,
      "stored response uses RETURNING to verify the confirmation row was updated",
    );
  } finally {
    (sequelize as unknown as { query: unknown }).query = originalQuery;
    await sequelize.close();
  }
});
