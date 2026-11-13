"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { analyze, sqlTables } = require("./backend-persistence-inventory.cjs");

test("persistence inventory detects Sequelize model calls and records owner and unresolved contract fields", () => {
  const result = analyze("apps/api/src/features/review/review.service.ts", `
    import { SourceRow, sequelize } from "../../infrastructure/database/db";
    export class ReviewService {
      async save() { return SourceRow.update({ accepted: true }, { where: { tenantId: "t" } }); }
      async list() { return sequelize.query("SELECT * FROM source_rows WHERE tenant_id = :tenantId"); }
    }
  `);
  assert.equal(result.owner, "api-feature:review");
  assert.equal(result.callSites.length, 2);
  assert.equal(result.callSites[0].operation, "orm-update");
  assert.equal(result.callSites[1].operation, "sql-query");
  assert.deepEqual(result.tables, ["source_rows"]);
  assert.equal(result.assessment.tenantScope, "REVIEW_REQUIRED");
});

test("persistence inventory includes direct database imports even before a query is found", () => {
  const result = analyze("apps/api/src/features/example/example.service.ts", `
    import { TenantMembership } from "../../infrastructure/database/db";
    export class ExampleService { lookup() { return TenantMembership.findOne({ where: {} }); } }
  `);
  assert.equal(result.persistenceImports.length, 1);
  assert.equal(result.callSites[0].operation, "orm-findOne");
});

test("SQL table extraction ignores common SQL keywords used as aliases or modifiers", () => {
  assert.deepEqual(sqlTables("SELECT * FROM public.users u JOIN source_rows r ON true UPDATE groups SET name='x'"), ["groups", "source_rows", "users"]);
});
