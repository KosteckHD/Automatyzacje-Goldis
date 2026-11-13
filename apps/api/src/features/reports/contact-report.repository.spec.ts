import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sequelize } from "sequelize";
import { ContactReportRepository } from "./contact-report.repository";

test("contact projection binds tenant and date filters and excludes pending deletions", async () => {
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  const database = {
    query: async (sql: string, options: { replacements: Record<string, unknown> }) => {
      calls.push({ sql, replacements: options.replacements });
      return calls.length === 1 ? [{ total: 2 }] : [{ userId: "user-a", username: "operator-a", assigned: 2 }];
    },
  } as unknown as Sequelize;
  const repository = new ContactReportRepository(database);
  const from = new Date("2026-10-01T00:00:00.000Z");
  const to = new Date("2026-10-07T00:00:00.000Z");

  const result = await repository.overview({
    tenantId: "tenant-a",
    toolId: "oc-policy-verification",
    from,
    to,
    resultSetId: null,
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.replacements.tenantId, "tenant-a");
    assert.equal(call.replacements.from, from);
    assert.equal(call.replacements.to, to);
    assert.equal(call.replacements.resultSetId, null);
    assert.match(call.sql, /resource_tombstones/);
    assert.match(call.sql, /lead\.tenant_id = :tenantId/);
  }
  assert.deepEqual(result.totals, [{ total: 2 }]);
  assert.deepEqual(result.employees, [{ userId: "user-a", username: "operator-a", assigned: 2 }]);
});
