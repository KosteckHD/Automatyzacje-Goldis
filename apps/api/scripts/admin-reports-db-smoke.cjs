const assert = require("node:assert/strict");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { sequelize } = require("../dist/infrastructure/database/db");

const from = "2026-10-01T00:00:00.000Z";
const to = "2026-10-03T00:00:00.000Z";
const inside = "2026-10-02T08:00:00.000Z";

function principal(userId, tenantId) {
  return {
    goldisPrincipal: {
      userId, tenantId, actorRef: userId, role: "admin", exp: Date.now() + 60_000,
      csrf: "synthetic-report-csrf-token-012345678901234567890",
    },
  };
}

function sessionCookie({ sessionId, userId, tenantId, secret }) {
  const payload = Buffer.from(JSON.stringify({
    v: 2, sessionId, exp: Date.now() + 60_000, userId, tenantId,
    csrf: "synthetic-reports-http-csrf-token-0123456789",
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=synthetic-reports-http-csrf-token-0123456789`;
}

async function seedTenant(tenantId, actorId, seeded, index) {
  const nip = index === 1 ? "1010101010" : "2020202020";
  const entityId = randomUUID();
  const submissionId = randomUUID();
  const groupId = randomUUID();
  const artifactId = randomUUID();
  const leadIdentityKey = createHash("sha256").update(`synthetic-report-${index}`).digest("hex");
  const sha256 = "a".repeat(64);
  let stage = "update_batch";
  try {
  await sequelize.query("UPDATE import_batches SET created_at = $1 WHERE id = $2", { bind: [inside, seeded.batchId] });
  stage = "update_run";
  await sequelize.query(
    index === 1
      ? `UPDATE automation_runs SET status = 'completed', current_step = 'completed', created_at = $1,
           updated_at = $1, started_at = $1, finished_at = $1, error_code = NULL WHERE id = $2`
      : `UPDATE automation_runs SET status = 'failed', current_step = 'failed', created_at = $1,
           updated_at = $1, started_at = NULL, finished_at = $1, error_code = 'SYNTHETIC_REPORT_FAILURE' WHERE id = $2`,
    { bind: [inside, seeded.runId] },
  );
  stage = "insert_entity";
  await sequelize.query(
    `INSERT INTO canonical_entities
       (canonical_entity_id, tenant_id, nip_normalized, regon, business_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    { bind: [entityId, tenantId, nip, index === 1 ? "123456789" : "987654321", `Synthetic Report Company ${index}`, inside] },
  );
  stage = "insert_entity_link";
  await sequelize.query(
    `INSERT INTO source_entity_links (source_row_id, canonical_entity_id, tenant_id, match_method, linked_at)
     VALUES ($1, $2, $3, 'manual', $4)`,
    { bind: [seeded.sourceRowId, entityId, tenantId, inside] },
  );
  stage = "insert_submission";
  await sequelize.query(
    `INSERT INTO run_submissions
       (submission_id, import_batch_id, tenant_id, tool_id, actor_user_id, idempotency_key, request_hash,
        reference_date, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, 'oc-policy-verification', $4, $5, $6, '2026-10-02', 'queued', 1, $7, $7)`,
    { bind: [submissionId, seeded.batchId, tenantId, actorId, `synthetic-report-key-${index}`, sha256, inside] },
  );
  stage = "insert_submission_group";
  await sequelize.query(
    `INSERT INTO run_submission_groups
       (group_id, submission_id, tenant_id, canonical_entity_id, lead_identity_key, run_id,
        admission_state, reason_code, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
    { bind: [groupId, submissionId, tenantId, entityId, leadIdentityKey,
      index === 1 ? seeded.runId : null, index === 1 ? "accepted" : "waiting_capacity",
      index === 1 ? null : "CAPACITY_LIMIT", inside] },
  );
  stage = "insert_artifact";
  await sequelize.query(
    `INSERT INTO export_artifacts
       (artifact_id, run_id, file_name, storage_key, sha256, policy_count, state, created_at, ready_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'ready', $6, $6)`,
    { bind: [artifactId, seeded.runId, `synthetic-${index}.xlsx`, `synthetic/report/${artifactId}`, sha256, inside] },
  );
  if (index === 1) {
    await sequelize.query(
      `INSERT INTO export_artifacts
         (artifact_id, run_id, file_name, storage_key, sha256, policy_count, state, created_at, ready_at)
       VALUES ($1, $2, 'synthetic-legacy-second-artifact.xlsx', $3, $4, 1, 'ready', $5, $5)`,
      { bind: [randomUUID(), seeded.runId, `synthetic/report/legacy-${randomUUID()}`, sha256, inside] },
    );
  }
  const resourceIds = index === 1 ? [artifactId, seeded.runId] : [artifactId];
  for (const resourceId of resourceIds) {
    stage = "insert_download_audit";
    await sequelize.query(
      `INSERT INTO audit_events
         (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, outcome, request_ref, metadata, created_at)
       VALUES ($1, $2, $3, 'artifact.downloaded', 'artifact', $4, 'succeeded', NULL, '{}'::jsonb, $5)`,
      { bind: [randomUUID(), tenantId, actorId, resourceId, inside] },
    );
  }
  return { entityId, submissionId, groupId, artifactId };
  } catch (error) {
    error.message = `reports_seed_${index}_${stage}: ${error?.parent?.message ?? error?.message ?? "UNKNOWN"}`;
    throw error;
  }
}

async function seedOperationalRunPages(tenantId, actorId) {
  const batchId = randomUUID();
  const createdAt = "2025-10-02T08:00:00.000Z";
  await sequelize.query(
    `INSERT INTO import_batches
       (id, file_name, sha256, total_rows, invalid_rows, created_at, tenant_id, owner_user_id, tool_id)
     VALUES ($1, 'synthetic-operations-pagination.xlsx', $2, 51, 0, $3, $4, $5, 'oc-policy-verification')`,
    { bind: [batchId, createHash("sha256").update(randomUUID()).digest("hex"), createdAt, tenantId, actorId] },
  );
  await sequelize.query(
    `INSERT INTO source_rows
       (id, batch_id, row_number, company_name, decision_maker_name, nip_raw, address, postal_code, city,
        regon_raw, regon, issues)
     SELECT gen_random_uuid(), $1, ordinal, 'Synthetic Page ' || ordinal, NULL, '0000000000', 'Synthetic',
            '00-000', 'Synthetic City', '012345678', '012345678', '[]'::jsonb
       FROM generate_series(1, 51) AS ordinal`,
    { bind: [batchId] },
  );
  await sequelize.query(
    `INSERT INTO automation_runs
       (id, batch_id, source_row_id, row_number, tool_id, status, current_step, reference_date,
        error_code, created_at, updated_at)
     SELECT gen_random_uuid(), $1, s.id, s.row_number, 'oc-policy-verification', 'failed', 'failed',
            '2025-10-02', 'SYNTHETIC_PAGE_FAILURE', $2::timestamptz + (s.row_number || ' milliseconds')::interval,
            $2::timestamptz + (s.row_number || ' milliseconds')::interval
       FROM source_rows s WHERE s.batch_id = $1`,
    { bind: [batchId, createdAt] },
  );
}

module.exports = async function verifyAdminReportTenantAggregation(seed) {
  const { AdminReportsController } = require("../dist/features/reports/admin-reports.controller");
  const { AdminReportsService } = require("../dist/features/reports/admin-reports.service");
  const controller = new AdminReportsService();
  let stage = "seed_goldis";
  try {
  const goldis = await seedTenant(seed.goldisTenantId, seed.goldisActorId, seed.goldis, 1);
  stage = "seed_other";
  const other = await seedTenant(seed.otherTenantId, seed.otherActorId, seed.other, 2);

  stage = "goldis_report";
  const goldisReport = await controller.overview(principal(seed.goldisActorId, seed.goldisTenantId).goldisPrincipal, from, to);
  assert.deepEqual(goldisReport.counts, {
    sourceRows: 1, canonicalGroups: 1, submissions: 1, actualRuns: 1, created: 1,
    completed: 1, noPolicies: 0, failed: 0, inProgress: 0, downloads: 2, generated: 2,
    openInterventions: 0,
  }, "Goldis report reflects hand-counted records and counts both legacy/new downloads once per event");
  assert.deepEqual(goldisReport.submissionsByStatus, { queued: 1 });
  assert.deepEqual(goldisReport.submissionGroupsByStateAndReason, [{ status: "accepted", reasonCode: null, count: 1 }]);
  assert.equal(goldisReport.daily.length, 1);
  assert.equal(goldisReport.daily[0].created, 1);

  stage = "other_report";
  const otherReport = await controller.overview(principal(seed.otherActorId, seed.otherTenantId).goldisPrincipal, from, to);
  assert.deepEqual(otherReport.counts, {
    sourceRows: 1, canonicalGroups: 1, submissions: 1, actualRuns: 1, created: 1,
    completed: 0, noPolicies: 0, failed: 1, inProgress: 0, downloads: 1, generated: 1,
    openInterventions: 0,
  }, "second tenant sees only its own source, canonical, submission, run and download rows");
  assert.deepEqual(otherReport.submissionsByStatus, { queued: 1 });
  assert.deepEqual(otherReport.submissionGroupsByStateAndReason, [{ status: "waiting_capacity", reasonCode: "CAPACITY_LIMIT", count: 1 }]);

  stage = "tool_filter";
  const filtered = await controller.overview(
    principal(seed.goldisActorId, seed.goldisTenantId).goldisPrincipal,
    from,
    to,
    "oc-policy-verification",
  );
  assert.equal(filtered.counts.sourceRows, 1);
  assert.equal(filtered.counts.canonicalGroups, 1);
  assert.equal(filtered.counts.submissions, 1);
  assert.equal(filtered.counts.actualRuns, 1);
  assert.equal(filtered.counts.downloads, 2);
  assert.equal(filtered.counts.generated, 2);

  const inclusiveStart = await controller.overview(
    principal(seed.goldisActorId, seed.goldisTenantId).goldisPrincipal,
    inside,
    to,
  );
  assert.equal(inclusiveStart.counts.sourceRows, 1, "from includes rows at the exact boundary");
  assert.equal(inclusiveStart.counts.canonicalGroups, 1, "from includes canonical entities at the exact boundary");
  assert.equal(inclusiveStart.counts.submissions, 1, "from includes submissions at the exact boundary");
  assert.equal(inclusiveStart.counts.actualRuns, 1, "from includes runs at the exact boundary");

  stage = "exclusive_end";
  const exclusiveEnd = await controller.overview(
    principal(seed.goldisActorId, seed.goldisTenantId).goldisPrincipal,
    "2026-10-01T00:00:00.000Z",
    inside,
  );
  assert.equal(exclusiveEnd.counts.sourceRows, 0, "to is exclusive for source import counts");
  assert.equal(exclusiveEnd.counts.canonicalGroups, 0, "to is exclusive for canonical entity counts");
  assert.equal(exclusiveEnd.counts.submissions, 0, "to is exclusive for submissions");
  assert.equal(exclusiveEnd.counts.actualRuns, 0, "to is exclusive for execution counts");

  stage = "http_db_route_scope";
  require("reflect-metadata");
  const { UserSession } = require("../dist/infrastructure/database/db");
  const { createHttpApplication } = require("../dist/infrastructure/http/index");
  const { SessionGuard, SESSION_ROLE_RESOLVER, SESSION_PASSWORD_CHANGE_RESOLVER,
    resolveCurrentSessionRole, resolveMustChangePassword } = require("../dist/features/auth/index");
  const { AdminOnlyGuard } = require("../dist/features/admin/admin.support");
  const { RequestProtectionGuard } = require("../dist/infrastructure/http/index");
  const { APP_GUARD } = require("@nestjs/core");
  const { Module } = require("@nestjs/common");
  const { AdminReportsController: ReportsHttpController } = require("../dist/features/reports/admin-reports.controller");
  const { AdminReportsService: ReportsHttpService } = require("../dist/features/reports/admin-reports.service");
  const secret = `synthetic-reports-session-${randomUUID()}`;
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = secret;
  const httpSessions = {
    goldis: randomUUID(), other: randomUUID(),
  };
  const sessionNow = new Date();
  await UserSession.create({
    sessionId: httpSessions.goldis, tenantId: seed.goldisTenantId, userId: seed.goldisActorId,
    createdAt: sessionNow, lastSeenAt: sessionNow, lastActivityAt: sessionNow, expiresAt: new Date(sessionNow.getTime() + 60_000),
    revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic reports HTTP test",
  });
  await UserSession.create({
    sessionId: httpSessions.other, tenantId: seed.otherTenantId, userId: seed.otherActorId,
    createdAt: sessionNow, lastSeenAt: sessionNow, lastActivityAt: sessionNow, expiresAt: new Date(sessionNow.getTime() + 60_000),
    revokedAt: null, revokedBy: null, revokeReason: null, ipHash: null, browserLabel: "Synthetic reports HTTP test",
  });
  class ReportsHttpIntegrationModule {}
  Module({
    controllers: [ReportsHttpController],
    providers: [
      ReportsHttpService,
      SessionGuard, AdminOnlyGuard,
      { provide: APP_GUARD, useClass: RequestProtectionGuard },
      { provide: SESSION_ROLE_RESOLVER, useValue: resolveCurrentSessionRole },
      { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: resolveMustChangePassword },
    ],
  })(ReportsHttpIntegrationModule);
  let reportsApp;
  try {
    reportsApp = await createHttpApplication(ReportsHttpIntegrationModule, { logger: false });
    await reportsApp.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${reportsApp.getHttpServer().address().port}/api/admin/reports/overview`;
    const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    assert.equal((await fetch(`${baseUrl}${query}`)).status, 401, "report route requires current session");
    const goldisResponse = await fetch(`${baseUrl}${query}`, {
      headers: { cookie: sessionCookie({ sessionId: httpSessions.goldis, userId: seed.goldisActorId, tenantId: seed.goldisTenantId, secret }) },
    });
    assert.equal(goldisResponse.status, 200, "admin report HTTP route must query its scoped live test database");
    assert.equal((await goldisResponse.json()).counts.canonicalGroups, 1);
    const otherResponse = await fetch(`${baseUrl}${query}`, {
      headers: { cookie: sessionCookie({ sessionId: httpSessions.other, userId: seed.otherActorId, tenantId: seed.otherTenantId, secret }) },
    });
    assert.equal(otherResponse.status, 200);
    const httpOtherReport = await otherResponse.json();
    assert.equal(httpOtherReport.counts.sourceRows, 1);
    assert.equal(httpOtherReport.counts.actualRuns, 1);
    assert.equal(httpOtherReport.counts.downloads, 1);
    assert.equal(httpOtherReport.counts.canonicalGroups, 1);
    console.log("ADMIN_REPORTS_HTTP_DB_SCOPE_PASS unauthenticated=401 tenantScopedAggregate=true crossTenantLeak=false");
  } finally {
    if (reportsApp) await reportsApp.close();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }

  stage = "operations_run_pagination";
  await seedOperationalRunPages(seed.goldisTenantId, seed.goldisActorId);
  const { AdminOperationsService } = require("../dist/features/admin/admin-operations.service");
  const { AdminOperationsRepository } = require("../dist/features/admin/admin-operations.repository");
  const { AdminMutationsService } = require("../dist/features/admin/admin-mutations.service");
  const { AdminMutationsRepository } = require("../dist/features/admin/admin-mutations.repository");
  const { AdminOverviewRepository } = require("../dist/features/admin/admin-overview.repository");
  const operationsController = new AdminOperationsService(
    { record: async () => {} },
    new AdminMutationsService(new AdminMutationsRepository(sequelize)),
    new AdminOperationsRepository(sequelize),
    new AdminOverviewRepository(),
  );
  const firstPage = await operationsController.operationsRuns(
    principal(seed.goldisActorId, seed.goldisTenantId).goldisPrincipal,
    "oc-policy-verification",
    undefined,
    "1",
  );
  const secondPage = await operationsController.operationsRuns(
    principal(seed.goldisActorId, seed.goldisTenantId).goldisPrincipal,
    "oc-policy-verification",
    undefined,
    "2",
  );
  assert.equal(firstPage.page, 1);
  assert.equal(firstPage.items.length, 50);
  assert.equal(firstPage.hasMore, true);
  assert.equal(secondPage.items.length, 2);
  assert.equal(secondPage.hasMore, false);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((row) => row.id)).size, 52,
    "stable page boundaries neither duplicate nor omit the 52 Goldis runs");
  assert.ok([...firstPage.items, ...secondPage.items].every((row) => row.batchId !== seed.other.batchId),
    "run pages are tenant-scoped before limit and offset");

  console.log("ADMIN_REPORTS_TENANT_AGGREGATION_PASS twoTenants=true sourceRows=1 canonicalGroups=1 submissions=1 actualRuns=1 downloadsGoldis=2 downloadsOther=1 toolFilter=true fromInclusive=true toExclusive=true runPagination=52Rows crossTenantLeak=false");
  return { goldis, other };
  } catch (error) {
    console.error("ADMIN_REPORTS_SMOKE_FAILED", `stage=${stage}`, error?.parent?.code ?? error?.code ?? "UNKNOWN", error?.parent?.message ?? error?.message ?? "UNKNOWN");
    throw error;
  }
};
