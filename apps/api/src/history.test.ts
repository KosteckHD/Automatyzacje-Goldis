import assert from "node:assert/strict";
import { test } from "node:test";

async function historyHarness() {
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  const [{ sequelize }, { HistoryService }] = await Promise.all([import("./db"), import("./history")]);
  return { sequelize, HistoryService };
}

const tenantId = "99999999-9999-4999-8999-999999999999";
const ownerId = "11111111-1111-4111-8111-111111111111";
const firstId = "22222222-2222-4222-8222-222222222222";
const secondId = "33333333-3333-4333-8333-333333333333";
const actor = { tenantId, userId: ownerId, role: "operator" as const };

test("lista importów stosuje scope w SQL, liczy przegląd z danych bieżących i nie zwraca danych wrażliwych", async () => {
  const { sequelize, HistoryService } = await historyHarness();
  const originalQuery = sequelize.query.bind(sequelize);
  let capturedSql = "";
  let capturedReplacements: Record<string, unknown> = {};
  (sequelize as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (sql, options) => {
    capturedSql = String(sql);
    capturedReplacements = (options as { replacements: Record<string, unknown> }).replacements;
    return [{
      id: firstId, tool_id: "oc-policy-verification", file_name: "Baza.xlsx", total_rows: 8,
      review_count: 3, created_at: new Date("2026-10-05T12:00:00Z"), owner_label: "operator-a",
    }];
  };
  try {
    const service = new HistoryService();
    const page = await service.imports(actor, { dataState: "needs_review", limit: "20" });
    assert.match(capturedSql, /b\.tenant_id = :tenantId/);
    assert.match(capturedSql, /b\.owner_user_id = :userId/);
    assert.match(capturedSql, /tg\.can_view_results = TRUE OR tg\.can_download_results = TRUE/);
    assert.ok(capturedSql.indexOf("WHERE b.tenant_id") < capturedSql.indexOf("ORDER BY created_at DESC"));
    assert.equal(capturedReplacements.tenantId, tenantId);
    assert.equal(capturedReplacements.userId, ownerId);
    assert.equal(capturedReplacements.limit, 21);
    assert.doesNotMatch(capturedSql, /pesel|nip|regon_raw|company_name/i);
    assert.deepEqual(page, {
      items: [{ id: firstId, toolId: "oc-policy-verification", fileName: "Baza.xlsx", totalRows: 8,
        reviewCount: 3, createdAt: "2026-10-05T12:00:00.000Z", ownerLabel: "operator-a" }],
      nextCursor: null,
    });
    await assert.rejects(service.imports(actor, { status: "completed" }),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 400);
  } finally {
    (sequelize as unknown as { query: typeof sequelize.query }).query = originalQuery;
  }
});

test("historia wyników zwraca jawny zerowy wynik, counts i kursor stabilny po created_at/id", async () => {
  const { sequelize, HistoryService } = await historyHarness();
  const originalQuery = sequelize.query.bind(sequelize);
  const calls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
  (sequelize as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (sql, options) => {
    calls.push({ sql: String(sql), replacements: (options as { replacements: Record<string, unknown> }).replacements });
    if (calls.length === 1) return [
      { id: firstId, batch_id: secondId, row_number: 12, tool_id: "oc-policy-verification", status: "no_matching_policies",
        reference_date: "2026-10-05", error_code: null, total_oc_count: 4, current_oc_count: 0,
        artifact_available: false, created_at: new Date("2026-10-05T12:00:00Z") },
      { id: secondId, batch_id: secondId, row_number: 13, tool_id: "oc-policy-verification", status: "completed",
        reference_date: "2026-10-05", error_code: null, total_oc_count: 2, current_oc_count: 1,
        artifact_available: true, created_at: new Date("2026-10-05T11:00:00Z") },
    ];
    return [];
  };
  try {
    const service = new HistoryService();
    const firstPage = await service.results(actor, { limit: "1" });
    assert.equal(firstPage.items.length, 1);
    assert.deepEqual(firstPage.items[0].policyCounts, { totalOcCount: 4, currentOcCount: 0 });
    assert.equal(firstPage.items[0].status, "no_matching_policies");
    assert.equal(firstPage.items[0].artifactAvailable, false);
    assert.ok(firstPage.nextCursor);
    assert.match(calls[0].sql, /r\.status IN \('completed', 'no_matching_policies'\)/);
    assert.match(calls[0].sql, /ORDER BY r\.created_at DESC, r\.id DESC/);
    assert.doesNotMatch(calls[0].sql, /pesel|source_rows|oc_policies\.insured_name/i);

    await service.results(actor, { limit: "1", cursor: firstPage.nextCursor! });
    assert.equal(calls[1].replacements.cursorId, firstId);
    assert.equal(calls[1].replacements.cursorCreatedAt, "2026-10-05T12:00:00.000Z");
    await assert.rejects(service.results(actor, { limit: "1", status: "completed", cursor: firstPage.nextCursor! }),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 400);
  } finally {
    (sequelize as unknown as { query: typeof sequelize.query }).query = originalQuery;
  }
});
