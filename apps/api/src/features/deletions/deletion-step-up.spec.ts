import assert from "node:assert/strict";
import { test } from "node:test";

async function loadModule() {
  process.env.DATABASE_URL ??= "postgres://goldis_deletion_test:unused@127.0.0.1:1/goldis_deletion_test";
  return import("./deletion-step-up");
}

test("fingerprint podglądu jest kanoniczny, a tylko Admin lub grantowany Menedżer może uzyskać step-up", async () => {
  const { normalizeDeletionPreviewFingerprint, canRequestDeletionStepUp, isDeletionStepUpFingerprint } =
    await loadModule();
  const upper = "A".repeat(64);
  assert.equal(normalizeDeletionPreviewFingerprint(upper), "a".repeat(64));
  assert.equal(isDeletionStepUpFingerprint("a".repeat(64)), true);
  for (const malformed of ["a".repeat(63), "a".repeat(65), "g".repeat(64), " ".repeat(64), null, 123]) {
    assert.equal(normalizeDeletionPreviewFingerprint(malformed), null);
  }
  assert.equal(canRequestDeletionStepUp("admin", false), true);
  assert.equal(canRequestDeletionStepUp("manager", true), true);
  assert.equal(canRequestDeletionStepUp("manager", false), false);
  assert.equal(canRequestDeletionStepUp("operator", true), false);
  assert.equal(canRequestDeletionStepUp("reviewer", true), false);
});

test("step-up jest przechowywany jako hash, związany z sesją, rewizjami i fingerprintem oraz atomowo zużywany raz", async () => {
  const { sequelize } = await import("../../infrastructure/database/db");
  const { createDeletionStepUpGrant, consumeDeletionStepUpGrant, hashDeletionStepUpToken } = await loadModule();
  const originalQuery = sequelize.query;
  const transaction = { id: "synthetic-step-up-transaction" } as never;
  const actor = {
    exp: Date.now() + 60_000,
    csrf: "synthetic-csrf-token-for-step-up-test-1234567890",
    userId: "11111111-1111-4111-8111-111111111111",
    tenantId: "99999999-9999-4999-8999-999999999999",
    actorRef: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    version: 2 as const,
    role: "admin" as const,
  };
  const fingerprint = "b".repeat(64);
  const previewId = "33333333-3333-4333-8333-333333333333";
  const captured: { sql: string; replacements?: Record<string, unknown> }[] = [];
  let consumed = false;
  (sequelize as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
    sql: unknown,
    options?: unknown,
  ) => {
    const query = String(sql);
    const replacements = (options as { replacements?: Record<string, unknown> } | undefined)?.replacements;
    captured.push({ sql: query, replacements });
    if (query.includes("UPDATE deletion_step_up_grants")) {
      if (consumed) return [];
      consumed = true;
      return [{ grantId: replacements?.grantId }];
    }
    return [];
  };
  try {
    const token = await createDeletionStepUpGrant({
      actor,
      previewId,
      credentialRevision: 7,
      deletionGrantVersion: 3,
      scopeFingerprint: fingerprint,
      now: new Date("2026-10-09T10:00:00.000Z"),
      transaction,
    });
    assert.match(token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/i);
    const insert = captured.find((entry) => entry.sql.includes("INSERT INTO deletion_step_up_grants"));
    assert.ok(insert);
    assert.equal(insert.replacements?.tokenHash, hashDeletionStepUpToken(token));
    assert.notEqual(insert.replacements?.tokenHash, token);
    assert.equal(insert.replacements?.scopeFingerprint, fingerprint);
    assert.equal(insert.replacements?.previewId, previewId);
    assert.equal(insert.replacements?.sessionId, actor.sessionId);
    assert.equal(insert.replacements?.credentialRevision, 7);
    assert.equal(insert.replacements?.deletionGrantVersion, 3);

    assert.equal(
      await consumeDeletionStepUpGrant({
        token,
        actor,
        previewId,
        credentialRevision: 7,
        deletionGrantVersion: 3,
        scopeFingerprint: fingerprint,
        now: new Date("2026-10-09T10:01:00.000Z"),
        transaction,
      }),
      true,
    );
    assert.equal(
      await consumeDeletionStepUpGrant({
        token,
        actor,
        previewId,
        credentialRevision: 7,
        deletionGrantVersion: 3,
        scopeFingerprint: fingerprint,
        now: new Date("2026-10-09T10:01:01.000Z"),
        transaction,
      }),
      false,
    );
    assert.equal(
      await consumeDeletionStepUpGrant({
        token,
        actor,
        previewId,
        credentialRevision: 7,
        deletionGrantVersion: 3,
        scopeFingerprint: "c".repeat(64),
        transaction,
      }),
      false,
    );
    const update = captured.find((entry) => entry.sql.includes("UPDATE deletion_step_up_grants"));
    assert.match(update?.sql ?? "", /consumed_at IS NULL AND expires_at > :now/);
    assert.match(update?.sql ?? "", /scope_fingerprint = :scopeFingerprint/);
    assert.match(update?.sql ?? "", /preview_id = :previewId/);
    assert.match(update?.sql ?? "", /deletion_grant_version = :deletionGrantVersion/);
  } finally {
    (sequelize as unknown as { query: unknown }).query = originalQuery;
    await sequelize.close();
  }
});
