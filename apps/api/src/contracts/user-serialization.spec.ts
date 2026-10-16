import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transaction } from "sequelize";
import { lockUsersInTransaction } from "./user-serialization";

test("credential locks deduplicate and acquire globally sorted user keys in one transaction", async () => {
  const calls: Array<{ sql: string; lockKey: string; transaction: unknown }> = [];
  const transaction = {
    id: "synthetic-transaction",
    sequelize: {
      async query(sql: string, options: { replacements: { lockKey: string }; transaction: unknown }) {
        calls.push({ sql, lockKey: options.replacements.lockKey, transaction: options.transaction });
        return [];
      },
    },
  } as unknown as Transaction;

  await lockUsersInTransaction([
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ], transaction);

  assert.deepEqual(calls.map((call) => call.lockKey), [
    "goldis:user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "goldis:user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ]);
  assert.ok(calls.every((call) => call.sql.includes("pg_advisory_xact_lock") && call.transaction === transaction));
});
