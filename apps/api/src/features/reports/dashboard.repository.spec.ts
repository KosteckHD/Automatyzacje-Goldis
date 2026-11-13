import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sequelize } from "sequelize";
import { DashboardRepository } from "./dashboard.repository";

test("dashboard projections bind actor scope and preserve deletion barriers", async () => {
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  const database = {
    query: async (sql: string, options: { replacements: Record<string, unknown> }) => {
      calls.push({ sql, replacements: options.replacements });
      return [{ count: 3 }];
    },
  } as unknown as Sequelize;
  const repository = new DashboardRepository(database);
  const actor = { tenantId: "tenant-a", userId: "user-a" };

  await repository.operations(actor);
  await repository.ownOperationMetrics(actor);
  await repository.ownLeadMetrics(actor);
  await repository.teamLeadMetrics(actor.tenantId);
  assert.equal(await repository.unreadNotifications(actor), 3);

  assert.equal(calls.length, 5);
  assert.match(calls[0].sql, /result_set\.tool_id = 'oc-policy-verification'/);
  assert.ok(calls[0].sql.indexOf("result_set.tool_id = 'oc-policy-verification'") < calls[0].sql.indexOf("GROUP BY"));
  assert.ok(calls[0].sql.indexOf("result_set.tool_id = 'oc-policy-verification'") < calls[0].sql.indexOf("LIMIT 8"));
  assert.match(calls[0].sql, /lead\.tenant_id = result_set\.tenant_id/);
  for (const call of calls) {
    assert.match(call.sql, /resource_tombstones/);
    assert.match(call.sql, /:tenantId/);
    assert.equal(call.replacements.tenantId, actor.tenantId);
  }
  for (const call of calls.filter(({ sql }) => /:userId/.test(sql))) {
    assert.equal(call.replacements.userId, actor.userId);
  }
});
