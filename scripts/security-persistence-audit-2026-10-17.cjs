"use strict";
// Invoked only by the wrapper owning an isolated local PostgreSQL cluster.
// Successful assertions below reproduce defects; they are not security acceptance tests.
require("reflect-metadata");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { Umzug, SequelizeStorage } = require("umzug");
const { Module } = require("@nestjs/common");
const { APP_GUARD } = require("@nestjs/core");
const api = (file) => require(path.resolve(__dirname, "../apps/api/dist", file));

async function main() {
  const adminUrl = new URL(process.env.GOLDIS_TEST_DATABASE_ADMIN_URL || "");
  const cluster = process.env.GOLDIS_SECURITY_AUDIT_CLUSTER;
  assert.match(cluster ?? "", /^[a-f0-9]{32}$/);
  assert.equal(adminUrl.hostname, "127.0.0.1");
  assert.equal(adminUrl.pathname, "/postgres");
  assert.notEqual(adminUrl.port, "5432");
  const databaseName = "goldis_security_audit_" + cluster;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let database;
  let app;
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const target = new URL(adminUrl);
    target.pathname = "/" + databaseName;
    Object.assign(process.env, { DATABASE_URL: target.toString(), NODE_ENV: "test",
      PUBLIC_APP_ORIGIN: "https://audit.goldis.example", SESSION_SECRET: "synthetic-audit-persistence-session-secret-20261017",
      WORKER_LIVE_PORTALS: "0", GOLDIS_ENRICHMENT_PROVIDER: "disabled" });
    const { createApiDatabase } = api("infrastructure/database/database.factory");
    database = createApiDatabase(target.toString());
    const umzug = new Umzug({ context: database.getQueryInterface(), logger: undefined,
      storage: new SequelizeStorage({ sequelize: database }),
      migrations: { glob: path.resolve(__dirname, "../apps/api/dist/infrastructure/database/migrations/*.js").replaceAll("\\", "/") } });
    const migrations = await umzug.up();
    const models = api("infrastructure/database/db");
    const { QueryTypes } = require("sequelize");
    const [tenant] = await database.query("SELECT tenant_id FROM tenants WHERE slug = 'goldis'", { type: QueryTypes.SELECT });
    const userId = randomUUID();
    const sessionId = randomUUID();
    const batchId = randomUUID();
    const resultSetId = randomUUID();
    const toolId = "synthetic-confidential-tool";
    const marker = "SYNTHETIC_CONFIDENTIAL_FILENAME.xlsx";
    const now = new Date();
    const { hashPassword } = api("features/auth/password-hash");
    const passwordHash = await hashPassword("Synthetic audit fixture password 20261017!");
    await models.User.create({ userId, username: "synthetic.audit", usernameNormalized: "synthetic.audit", passwordHash, status: "active", createdAt: now, updatedAt: now });
    await models.TenantMembership.create({ tenantId: tenant.tenant_id, userId, role: "operator", status: "active", createdAt: now, updatedAt: now });
    await models.Tool.create({ toolId, displayName: "Synthetic confidential tool", description: "Synthetic audit only", status: "available", sortOrder: 100, createdAt: now, updatedAt: now });
    await models.ImportBatch.create({ id: batchId, tenantId: tenant.tenant_id, ownerUserId: userId, toolId, fileName: marker, sha256: "b".repeat(64), totalRows: 0, invalidRows: 0, createdAt: now });
    await models.ResultSet.create({ resultSetId, tenantId: tenant.tenant_id, batchId, toolId, actorUserId: userId, sourceType: "run_submission", sourceId: randomUUID(), referenceDate: "2026-10-17", status: "queued", createdAt: now, updatedAt: now });
    const { HistoryRepository } = api("features/reports/history.repository");
    const { HistoryService } = api("features/reports/history.service");
    const { DashboardRepository } = api("features/reports/dashboard.repository");
    const { DashboardService } = api("features/reports/dashboard.service");
    const { ImportController } = api("features/imports/import.controller");
    const { ImportService } = api("features/imports/import.service");
    const { DashboardController } = api("features/reports/dashboard.controller");
    const { SessionGuard } = api("features/auth/session.guard");
    const { PermissionGuard } = api("features/authorization/authorization-guard");
    const { createHttpApplication, RequestProtectionGuard } = api("infrastructure/http");
    const { issueSession } = api("features/auth/session-principal");
    const { canAccessTool } = api("features/authorization/tool-access");
    const actor = { tenantId: tenant.tenant_id, userId, role: "operator" };
    assert.equal(await canAccessTool(actor, toolId, "view_results"), false);
    const history = new HistoryService(new HistoryRepository(database));
    const dashboard = new DashboardService(new DashboardRepository(database));
    class PersistenceAuditHttpModule {}
    Module({ controllers: [ImportController, DashboardController], providers: [SessionGuard, PermissionGuard,
      { provide: "GOLDIS_SESSION_ROLE_RESOLVER", useValue: async (_user, _tenant, suppliedSession) => suppliedSession === sessionId ? "operator" : null },
      { provide: "GOLDIS_SESSION_PASSWORD_CHANGE_RESOLVER", useValue: async () => false },
      { provide: HistoryService, useValue: history }, { provide: DashboardService, useValue: dashboard },
      { provide: ImportService, useValue: { get: () => { throw new Error("Unauthorized detail must not reach service"); } } },
      { provide: APP_GUARD, useClass: RequestProtectionGuard },
    ] })(PersistenceAuditHttpModule);
    app = await createHttpApplication(PersistenceAuditHttpModule, { logger: false, cors: false });
    await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const issued = issueSession(userId, tenant.tenant_id, sessionId);
    const headers = { cookie: "goldis_session=" + issued.sessionToken };
    const list = await fetch(base + "/api/imports?toolId=" + toolId, { headers });
    const listBody = await list.json();
    const detail = await fetch(base + "/api/imports/" + batchId, { headers });
    await detail.text();
    const dashboardResponse = await fetch(base + "/api/dashboard", { headers });
    const dashboardBody = await dashboardResponse.json();
    assert.equal(list.status, 200);
    assert.ok(listBody.items.some((item) => item.fileName === marker));
    assert.equal(detail.status, 404);
    assert.equal(dashboardResponse.status, 200);
    assert.ok(dashboardBody.operations.some((item) => item.toolId === toolId && item.fileName === marker));
    assert.ok(!dashboardBody.tools.some((item) => item.toolId === toolId));
    // Input stays a bound value, so a hostile tool filter returns no rows.
    const hostile = "x' OR 1=1--";
    const injection = await new HistoryRepository(database).imports({ actor, filters: { toolId: hostile, limit: 10 }, cursor: null, dataState: "all" });
    assert.equal(injection.length, 0);
    // A forced audit-like failure rolls back a batch written earlier in the transaction.
    const rollbackBatch = randomUUID();
    await assert.rejects(database.transaction(async (transaction) => {
      await models.ImportBatch.create({ id: rollbackBatch, tenantId: tenant.tenant_id, ownerUserId: userId, toolId, fileName: "rollback.xlsx", sha256: "c".repeat(64), totalRows: 0, invalidRows: 0, createdAt: now }, { transaction });
      throw new Error("SYNTHETIC_AUDIT_FAILURE");
    }), /SYNTHETIC_AUDIT_FAILURE/);
    assert.equal(await models.ImportBatch.findByPk(rollbackBatch), null);
    const evidence = { date: "2026-10-17", database: "disposable PostgreSQL 18 cluster, loopback random port",
      migrations: migrations.length, queryIdentity: "postgres; runtime least privilege independently checked by security-db smoke",
      syntheticDataOnly: true, findingsReproduced: [
        { id: "SEC-01", capability: "view_results", granted: false, role: "operator", toolId,
          endpoint: "/api/imports?toolId=" + toolId, status: list.status, leakedFileName: marker, detailStatus: detail.status },
        { id: "SEC-02", capability: "view_results", granted: false, role: "operator", toolId,
          endpoint: "/api/dashboard", status: dashboardResponse.status, leakedFileName: marker,
          toolsListsUnauthorizedTool: false, operationListsUnauthorizedTool: true },
      ], injectionFilterReturnedRows: injection.length, forcedTransactionRollback: true };
    fs.writeFileSync(path.resolve(__dirname, "../docs/security/audit-2026-10-17/persistence-probes.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log("PERSISTENCE_AUDIT_REPRODUCED SEC-01=list-grant-bypass SEC-02=dashboard-tool-scope SQLi=blocked rollback=pass migrations=" + migrations.length);
  } finally {
    if (app) await app.close();
    if (database) await database.close();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
