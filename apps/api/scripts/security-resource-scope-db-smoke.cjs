const assert = require("node:assert/strict");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../dist/infrastructure/database/db");
let seedClient;

const operatorRole = "operator";
const privateToolIds = {
  noGrant: "synthetic-private-no-grant",
  discover: "synthetic-private-discover",
  execute: "synthetic-private-execute",
  view: "synthetic-private-view",
};

function cookie({ sessionId, userId, tenantId, secret }) {
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    sessionId,
    exp: Date.now() + 60_000,
    userId,
    tenantId,
    csrf: "synthetic-resource-scope-csrf-token-0123456789",
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=synthetic-resource-scope-csrf-token-0123456789`;
}

async function addTool(toolId, displayName) {
  await seedClient.query(
    `INSERT INTO tools (tool_id, display_name, description, status, sort_order, created_at, updated_at)
     VALUES ($1, $2, 'synthetic security fixture', 'available', 900, now(), now())`,
    [toolId, displayName],
  );
}

async function addGrant(tenantId, userId, toolId, capabilities) {
  await seedClient.query(
    `INSERT INTO tool_grants (tenant_id, tool_id, user_id, can_discover, can_execute, can_view_results,
        can_download_results, granted_by, created_at, updated_at, version)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE, NULL, now(), now(), 1)`,
    [tenantId, toolId, userId, capabilities.discover, capabilities.execute, capabilities.view],
  );
}

async function addBatch({ id = randomUUID(), tenantId, ownerId, toolId, fileName, createdAt }) {
  await seedClient.query(
    `INSERT INTO import_batches (id, file_name, sha256, total_rows, invalid_rows, created_at, tenant_id, owner_user_id, tool_id)
     VALUES ($1, $2, $3, 1, 0, $4, $5, $6, $7)`,
    [id, fileName, createHash("sha256").update(`${id}:${fileName}`).digest("hex"), createdAt, tenantId, ownerId, toolId],
  );
  return id;
}

async function addOperation({ tenantId, userId, batchId, toolId, createdAt }) {
  const resultSetId = randomUUID();
  await seedClient.query(
    `INSERT INTO result_sets (result_set_id, tenant_id, batch_id, tool_id, actor_user_id, source_type, source_id,
        reference_date, status, created_at, updated_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, 'prepared_set_execution', $6, '2026-10-01', 'waiting_attention', $7, $7, NULL)`,
    [resultSetId, tenantId, batchId, toolId, userId, randomUUID(), createdAt],
  );
  return resultSetId;
}

async function verifyResourceScope(seed) {
  if (process.env.GOLDIS_MIGRATOR_DATABASE_URL) {
    const roleRows = await sequelize.query("SELECT current_user AS database_role", { type: QueryTypes.SELECT });
    if (roleRows[0]?.database_role !== "goldis_api") throw new Error("RESOURCE_SCOPE_API_DATABASE_ROLE_INVALID");
  }
  const tenantId = seed.goldisTenantId;
  const userId = randomUUID();
  const sessionId = randomUUID();
  const now = new Date();
  const username = `Synthetic.ResourceScope.${userId.slice(0, 8)}`;
  const ids = { hidden: [], visible: [], operations: {} };

  await seedClient.query(
    `INSERT INTO users (user_id, username, username_normalized, password_hash, status, created_at, updated_at, last_login_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $5, NULL)`,
    [userId, username, username.toLowerCase(), "synthetic-resource-scope-password-hash-0123456789", now],
  );
  await seedClient.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, 'operator', 'active', $3, $3)`,
    [tenantId, userId, now],
  );
  for (const [toolId, displayName] of Object.entries({
    [privateToolIds.noGrant]: "Synthetic Private Without Grant",
    [privateToolIds.discover]: "Synthetic Discover Only",
    [privateToolIds.execute]: "Synthetic Execute Only",
    [privateToolIds.view]: "Synthetic Private With View Grant",
  })) await addTool(toolId, displayName);

  await addGrant(tenantId, userId, privateToolIds.discover, { discover: true, execute: false, view: false });
  await addGrant(tenantId, userId, privateToolIds.execute, { discover: true, execute: true, view: false });
  await addGrant(tenantId, userId, privateToolIds.view, { discover: true, execute: false, view: true });

  for (let index = 0; index < 9; index += 1) {
    ids.hidden.push(await addBatch({
      tenantId,
      ownerId: userId,
      toolId: privateToolIds.noGrant,
      fileName: `synthetic-hidden-no-grant-${index}.xlsx`,
      createdAt: new Date(Date.UTC(2098, 0, index + 1)),
    }));
  }
  ids.hidden.push(await addBatch({
    tenantId,
    ownerId: userId,
    toolId: privateToolIds.discover,
    fileName: "synthetic-hidden-discover-only.xlsx",
    createdAt: new Date(Date.UTC(2098, 1, 1)),
  }));
  ids.hidden.push(await addBatch({
    tenantId,
    ownerId: userId,
    toolId: privateToolIds.execute,
    fileName: "synthetic-hidden-execute-only.xlsx",
    createdAt: new Date(Date.UTC(2098, 1, 2)),
  }));
  ids.visible.push(await addBatch({
    tenantId,
    ownerId: userId,
    toolId: privateToolIds.view,
    fileName: "synthetic-visible-private-older.xlsx",
    createdAt: new Date(Date.UTC(2097, 0, 1)),
  }));
  ids.visible.push(await addBatch({
    tenantId,
    ownerId: userId,
    toolId: privateToolIds.view,
    fileName: "synthetic-visible-private-newer.xlsx",
    createdAt: new Date(Date.UTC(2097, 0, 2)),
  }));

  // A second membership lets the same user own a record in another tenant.
  // The current Goldis request must still be unable to discover it.
  await seedClient.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, 'operator', 'active', $3, $3)`,
    [seed.otherTenantId, userId, now],
  );
  const foreignTenantBatchId = await addBatch({
    tenantId: seed.otherTenantId,
    ownerId: userId,
    toolId: privateToolIds.noGrant,
    fileName: "synthetic-hidden-other-tenant.xlsx",
    createdAt: new Date(Date.UTC(2099, 0, 1)),
  });

  const ocBatchId = await addBatch({
    tenantId,
    ownerId: userId,
    toolId: "oc-policy-verification",
    fileName: "synthetic-visible-shared-oc.xlsx",
    createdAt: new Date(Date.UTC(2096, 0, 1)),
  });
  await addOperation({ tenantId, userId, batchId: ids.visible[1], toolId: privateToolIds.view, createdAt: new Date(Date.UTC(2097, 0, 2)) });
  ids.operations.oc = await addOperation({ tenantId, userId, batchId: ocBatchId, toolId: "oc-policy-verification", createdAt: new Date(Date.UTC(2096, 0, 1)) });

  const { HistoryRepository } = require("../dist/features/reports/history.repository");
  const { HistoryService } = require("../dist/features/reports/history.service");
  const actor = { tenantId, userId, role: operatorRole };
  const history = new HistoryService(new HistoryRepository(sequelize));
  const filteredFirstPage = await history.imports(actor, { toolId: privateToolIds.view, limit: "1" });
  assert.equal(filteredFirstPage.items.length, 1);
  assert.equal(filteredFirstPage.items[0].id, ids.visible[1]);
  assert.ok(filteredFirstPage.nextCursor);
  const filteredSecondPage = await history.imports(actor, {
    toolId: privateToolIds.view,
    limit: "1",
    cursor: filteredFirstPage.nextCursor,
  });
  assert.deepEqual(filteredSecondPage.items.map((item) => item.id), [ids.visible[0]]);

  const unfilteredFirstPage = await history.imports(actor, { limit: "1" });
  assert.equal(unfilteredFirstPage.items[0]?.id, ids.visible[1], "newer private rows without view_results do not occupy the first page");
  const allVisible = await history.imports(actor, { limit: "100" });
  const allIds = new Set(allVisible.items.map((item) => item.id));
  for (const hiddenId of ids.hidden) assert.equal(allIds.has(hiddenId), false);
  assert.equal(allIds.has(foreignTenantBatchId), false);
  assert.ok(ids.visible.every((visibleId) => allIds.has(visibleId)), "view_results is the positive control for an owned private import");
  for (const item of allVisible.items) assert.doesNotMatch(item.fileName, /hidden-(no-grant|discover-only|execute-only|other-tenant)/);

  const secret = `synthetic-resource-scope-session-${randomUUID()}-0123456789`;
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = secret;
  const integrationSessionId = randomUUID();
  require("reflect-metadata");
  const { Module } = require("@nestjs/common");
  const { createHttpApplication } = require("../dist/infrastructure/http/index");
  const { ImportController } = require("../dist/features/imports/import.controller");
  const { ImportService } = require("../dist/features/imports/import.service");
  const { PermissionGuard, PERMISSION_RESOURCE_RESOLVER } = require("../dist/features/authorization/authorization-guard");
  const { resolvePermissionResource } = require("../dist/features/authorization/authorization.repository");
  const { SessionGuard, SESSION_ROLE_RESOLVER, SESSION_PASSWORD_CHANGE_RESOLVER } = require("../dist/features/auth/session.guard");
  class ResourceScopeHttpModule {}
  Module({
    controllers: [ImportController],
    providers: [
      { provide: ImportService, useValue: { get: async (id) => ({ id, fileName: "synthetic-authorized-detail.xlsx" }) } },
      { provide: HistoryService, useValue: history },
      SessionGuard,
      PermissionGuard,
      { provide: PERMISSION_RESOURCE_RESOLVER, useValue: resolvePermissionResource },
      { provide: SESSION_ROLE_RESOLVER, useValue: async (claimedUser, claimedTenant, claimedSession) =>
        claimedUser === userId && claimedTenant === tenantId && claimedSession === integrationSessionId ? operatorRole : null },
      { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
    ],
  })(ResourceScopeHttpModule);
  let app;
  try {
    app = await createHttpApplication(ResourceScopeHttpModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}/api/imports`;
    const sessionCookie = cookie({ sessionId: integrationSessionId, userId, tenantId, secret });
    assert.equal((await fetch(baseUrl)).status, 401, "imports collection requires a signed-in user");
    const listResponse = await fetch(`${baseUrl}?toolId=${privateToolIds.view}&limit=1`, { headers: { cookie: sessionCookie } });
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).items[0]?.id, ids.visible[1]);
    assert.equal((await fetch(`${baseUrl}/${ids.hidden[0]}`, { headers: { cookie: sessionCookie } })).status, 404,
      "the owned private import detail remains concealed without view_results");
    assert.equal((await fetch(`${baseUrl}/${ids.visible[1]}`, { headers: { cookie: sessionCookie } })).status, 200,
      "the view_results grant allows the positive-control detail");

    await seedClient.query(
      `UPDATE tool_grants SET can_view_results = FALSE, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND tool_id = $3`,
      [tenantId, userId, privateToolIds.view],
    );
    const revokedListResponse = await fetch(
      `${baseUrl}?toolId=${privateToolIds.view}&limit=1&cursor=${encodeURIComponent(filteredFirstPage.nextCursor)}`,
      { headers: { cookie: sessionCookie } },
    );
    assert.equal(revokedListResponse.status, 200);
    assert.deepEqual((await revokedListResponse.json()).items, [],
      "the same signed-in session and signed cursor do not retain revoked access");
    assert.equal((await fetch(`${baseUrl}/${ids.visible[1]}`, { headers: { cookie: sessionCookie } })).status, 404,
      "the next HTTP detail read observes the revoked grant");

    await seedClient.query(
      `UPDATE tool_grants SET can_view_results = TRUE, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND tool_id = $3`,
      [tenantId, userId, privateToolIds.view],
    );
  } finally {
    if (app) await app.close();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }

  const { DashboardRepository } = require("../dist/features/reports/dashboard.repository");
  const { DashboardService } = require("../dist/features/reports/dashboard.service");
  const dashboard = await new DashboardService(new DashboardRepository(sequelize)).get(actor);
  assert.ok(dashboard.tools.some((tool) => tool.toolId === privateToolIds.view && tool.canViewResults),
    "a private-tool view grant remains visible in the tool capability list");
  assert.ok(dashboard.operations.some((operation) => operation.resultSetId === ids.operations.oc), "shared OC remains the positive dashboard control");
  assert.equal(dashboard.operations.some((operation) => operation.toolId !== "oc-policy-verification"), false,
    "the OC dashboard does not include any private-tool operation");
  assert.equal(dashboard.actionRequired.some((item) => item.id === ids.operations.oc), true);
  assert.equal(dashboard.actionRequired.some((item) => item.toolName.includes("Synthetic Private")), false);
  assert.deepEqual(dashboard.metrics.operations, { total: 1, active: 0, attention: 1, completed: 0 });

  console.log(`RESOURCE_SCOPE_DB_PASS role=${process.env.GOLDIS_MIGRATOR_DATABASE_URL ? "goldis_api" : "migration_smoke"} operatorPrivateGrant=true revokedGrantSameSession=true staleCursorDenied=true foreignTenantDenied=true privateDashboardHidden=true sharedOcVisible=true anonymous=401 detailDenied=404`);
}

module.exports = async function runResourceScopeSmoke(seed) {
  const migratorUrl = process.env.GOLDIS_MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!migratorUrl) throw new Error("RESOURCE_SCOPE_MIGRATOR_DATABASE_URL_REQUIRED");
  seedClient = new Client({ connectionString: migratorUrl, connectionTimeoutMillis: 3_000 });
  await seedClient.connect();
  try {
    if (!seed) {
      const goldis = await seedClient.query("SELECT tenant_id FROM tenants WHERE slug = 'goldis'");
      if (goldis.rowCount !== 1) throw new Error("RESOURCE_SCOPE_GOLDIS_TENANT_MISSING");
      const otherTenantId = randomUUID();
      await seedClient.query(
        `INSERT INTO tenants (tenant_id, slug, display_name, created_at)
         VALUES ($1, $2, 'Synthetic Resource Scope Tenant', now())`,
        [otherTenantId, `resource-scope-${otherTenantId.slice(0, 8)}`],
      );
      seed = { goldisTenantId: goldis.rows[0].tenant_id, otherTenantId };
    }
    return await verifyResourceScope(seed);
  } finally {
    await seedClient.end().catch(() => undefined);
    seedClient = undefined;
  }
};

if (require.main === module) {
  module.exports().catch((error) => {
    console.error("RESOURCE_SCOPE_DB_FAIL", error instanceof Error ? error.message : "UNKNOWN");
    process.exitCode = 1;
  });
}
