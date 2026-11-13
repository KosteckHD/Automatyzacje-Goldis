import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sequelize } from "sequelize";
import { ReviewRepository } from "./review.repository";

test("review correction projection binds tenant, grant scope, filters, author and cursor in persistence", async () => {
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  const database = {
    async query(sql: string, options: { replacements: Record<string, unknown> }) {
      calls.push({ sql, replacements: options.replacements });
      return [];
    },
  } as unknown as Sequelize;
  const repository = new ReviewRepository(database);

  await repository.listCorrections({
    tenantId: "tenant-a",
    userId: "user-a",
    role: "reviewer",
    ownOnly: true,
    filters: {
      status: "pending",
      batchId: "11111111-1111-4111-8111-111111111111",
      toolId: "oc-policy-verification",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
    },
    cursor: { createdAt: "2026-10-01T12:00:00.000Z", id: "22222222-2222-4222-8222-222222222222" },
    limit: 25,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /b\.tenant_id = :tenantId/);
  assert.match(calls[0].sql, /q\.author_ref = :userId/);
  assert.match(calls[0].sql, /q\.created_at >= :from/);
  assert.match(calls[0].sql, /q\.created_at <= :to/);
  assert.match(calls[0].sql, /q\.correction_id DESC LIMIT :limit/);
  assert.deepEqual(calls[0].replacements, {
    limit: 26,
    tenantId: "tenant-a",
    userId: "user-a",
    status: "pending",
    batchId: "11111111-1111-4111-8111-111111111111",
    toolId: "oc-policy-verification",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-02T00:00:00.000Z",
    cursorCreatedAt: "2026-10-01T12:00:00.000Z",
    cursorId: "22222222-2222-4222-8222-222222222222",
  });
});
