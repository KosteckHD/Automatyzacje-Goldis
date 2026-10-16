import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IdentityRepository } from "./identity.repository";

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ??= "postgres://synthetic:unused@127.0.0.1:5432/goldis_identity_repository_test";
let modelsPromise: Promise<typeof import("../../infrastructure/database/db")> | undefined;

function models() {
  modelsPromise ??= import("../../infrastructure/database/db");
  return modelsPromise;
}

after(async () => {
  const importedModels = await modelsPromise;
  if (importedModels) await importedModels.sequelize.close();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

test("IdentityRepository scopes account projection to the active user and tenant membership", async () => {
  const database = await models();
  const previousFindUser = database.User.findByPk;
  const previousQuery = database.sequelize.query;
  const calls: Array<{ sql: string; options: unknown }> = [];
  try {
    (database.User as unknown as { findByPk: (...args: unknown[]) => Promise<unknown> }).findByPk = async (
      userId: unknown,
      options: unknown,
    ) => {
      assert.equal(userId, "11111111-1111-4111-8111-111111111111");
      assert.deepEqual(options, { attributes: ["username", "mustChangePassword"] });
      return { username: "Synthetic.User", mustChangePassword: true };
    };
    (database.sequelize as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
      ...args: unknown[]
    ) => {
      const sql = args[0] as string;
      const options = args[1];
      calls.push({ sql, options });
      return [{ canDeleteData: true }];
    };

    const account = await new IdentityRepository({ record: async () => undefined } as never).findCurrentAccount(
      "11111111-1111-4111-8111-111111111111",
      "99999999-9999-4999-8999-999999999999",
    );

    assert.deepEqual(account, {
      username: "Synthetic.User",
      mustChangePassword: true,
      canDeleteData: true,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /tenant_id = :tenantId AND user_id = :userId AND status = 'active'/);
    assert.deepEqual((calls[0].options as { replacements: unknown }).replacements, {
      tenantId: "99999999-9999-4999-8999-999999999999",
      userId: "11111111-1111-4111-8111-111111111111",
    });
  } finally {
    (database.User as unknown as { findByPk: unknown }).findByPk = previousFindUser;
    (database.sequelize as unknown as { query: unknown }).query = previousQuery;
  }
});

test("IdentityRepository logs out and revokes only owner-scoped sessions in audited transactions", async () => {
  const database = await models();
  const previousUpdate = database.UserSession.update;
  const previousTransaction = database.sequelize.transaction;
  const transaction = { id: "synthetic-identity-transaction", sequelize: database.sequelize };
  const updates: Array<{ values: unknown; options: unknown }> = [];
  const audits: Array<{ input: Record<string, unknown>; transaction?: unknown }> = [];
  try {
    (database.UserSession as unknown as { update: (...args: unknown[]) => Promise<unknown> }).update = async (
      values: unknown,
      options: unknown,
    ) => {
      updates.push({ values, options });
      return [1];
    };
    (
      database.sequelize as unknown as {
        transaction: (callback: (value: unknown) => Promise<unknown>) => Promise<unknown>;
      }
    ).transaction = (callback) => callback(transaction);
    const audit = {
      async record(input: Record<string, unknown>, passedTransaction?: unknown) {
        audits.push({ input, transaction: passedTransaction });
      },
    };

    const repository = new IdentityRepository(audit as never);
    const now = new Date("2026-10-16T12:00:00.000Z");
    assert.equal(
      await repository.logoutSession({
        userId: "11111111-1111-4111-8111-111111111111",
        tenantId: "99999999-9999-4999-8999-999999999999",
        sessionId: "22222222-2222-4222-8222-222222222222",
        now,
      }),
      true,
    );
    assert.equal(
      await repository.revokeOwnedSession({
        userId: "11111111-1111-4111-8111-111111111111",
        tenantId: "99999999-9999-4999-8999-999999999999",
        sessionId: "33333333-3333-4333-8333-333333333333",
        now,
      }),
      true,
    );

    assert.equal(updates.length, 2);
    assert.deepEqual((updates[0].options as { where: unknown }).where, {
      sessionId: "22222222-2222-4222-8222-222222222222",
      userId: "11111111-1111-4111-8111-111111111111",
      tenantId: "99999999-9999-4999-8999-999999999999",
      revokedAt: null,
    });
    assert.deepEqual(updates[0].values, { revokedAt: now, revokeReason: "logout" });
    assert.deepEqual((updates[1].options as { where: unknown }).where, {
      sessionId: "33333333-3333-4333-8333-333333333333",
      tenantId: "99999999-9999-4999-8999-999999999999",
      userId: "11111111-1111-4111-8111-111111111111",
      revokedAt: null,
    });
    assert.deepEqual(updates[1].values, {
      revokedAt: now,
      revokedBy: "11111111-1111-4111-8111-111111111111",
      revokeReason: "admin",
    });
    assert.deepEqual(
      audits.map(({ input }) => input.action),
      ["logout.succeeded", "session.revoked"],
    );
    assert.ok(audits.every((auditCall) => auditCall.transaction === transaction));
    assert.ok(updates.every((update) => (update.options as { transaction: unknown }).transaction === transaction));
  } finally {
    (database.UserSession as unknown as { update: unknown }).update = previousUpdate;
    (database.sequelize as unknown as { transaction: unknown }).transaction = previousTransaction;
  }
});
