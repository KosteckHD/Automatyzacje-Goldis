"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { analyzeSource, scanTransactionBoundaries } = require("./backend-refactor-transaction-audit.cjs");

test("transaction audit requires the outer transaction for audit writes", () => {
  const result = analyzeSource(`
    async function update() {
      await sequelize.transaction(async (transaction) => {
        await SourceRow.update({ name: "x" });
        await recordAuditEvent({ action: "row.updated" });
      });
    }
  `);
  assert.deepEqual(result.violations.map(({ kind }) => kind), [
    "database-call-missing-transaction", "audit-write-missing-transaction",
  ]);
});

test("transaction audit accepts explicit audit transaction and rejects nested independent transactions", () => {
  const result = analyzeSource(`
    async function update() {
      await sequelize.transaction(async (transaction) => {
        await SourceRow.update({ name: "x" }, { where: { id }, transaction });
        await this.audit.record({ action: "row.updated" }, transaction);
        await sequelize.transaction(async (inner) => inner.commit());
      });
    }
  `);
  assert.deepEqual(result.violations.map(({ kind }) => kind), ["nested-sequelize-transaction"]);
});

test("transaction audit tracks use-case scopes delegated to repositories", () => {
  const result = analyzeSource(`
    class Service {
      async update() {
        return this.repository.transaction(async (transaction) => {
          await SourceRow.update({ name: "x" }, { where: { id }, transaction });
        });
      }
    }
  `);
  assert.equal(result.transactions, 1);
  assert.deepEqual(result.violations, []);
});

test("current API production transaction scopes have explicit audit propagation", () => {
  const result = scanTransactionBoundaries(path.join(__dirname, "../apps/api/src"));
  assert.ok(result.files.length > 100);
  assert.ok(result.transactionCount > 90);
  assert.deepEqual(result.violations, []);
});
