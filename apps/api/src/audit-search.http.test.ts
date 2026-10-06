import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const secret = "audit-search-synthetic-session-secret-123456";
const csrf = "synthetic-audit-csrf-token-12345678901234567890";
const tenantId = "99999999-9999-4999-8999-999999999999";
const userIds = {
  admin: "11111111-1111-4111-8111-111111111111",
  operator: "22222222-2222-4222-8222-222222222222",
  reviewer: "33333333-3333-4333-8333-333333333333",
  auditor: "44444444-4444-4444-8444-444444444444",
};

function sessionCookie(role: keyof typeof userIds): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 60_000, userId: userIds[role], tenantId, csrf,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrf}`;
}

test("audit API scopes roles, filters reviewer events to current grants and binds pagination cursor", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = secret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  let restoreQuery: (() => void) | undefined;
  try {
    const { sequelize } = await import("./db");
    const { AuditSearchController } = await import("./admin-reports");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("./session");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("./authorization-guard");
    const sqlCalls: Array<{ sql: string; replacements: Record<string, unknown> }> = [];
    const originalQuery = sequelize.query;
    restoreQuery = () => { (sequelize as unknown as { query: unknown }).query = originalQuery; };
    (sequelize as unknown as { query: unknown }).query = async (sql: string, options: { replacements?: Record<string, unknown> }) => {
      sqlCalls.push({ sql, replacements: options.replacements ?? {} });
      return [
        { eventId: "66666666-6666-4666-8666-666666666666", actorUserId: null, actorUsername: null, action: "run.created", resourceType: "run", resourceId: "88888888-8888-4888-8888-888888888888", outcome: "succeeded", requestRef: null, createdAt: new Date("2026-10-02T08:00:00.000Z") },
        { eventId: "77777777-7777-4777-8777-777777777777", actorUserId: null, actorUsername: null, action: "import.created", resourceType: "import", resourceId: "99999999-9999-4999-8999-999999999998", outcome: "succeeded", requestRef: null, createdAt: new Date("2026-10-01T08:00:00.000Z") },
      ];
    };

    @Module({
      controllers: [AuditSearchController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: SESSION_ROLE_RESOLVER, useValue: async (_userId: string, _tenantId: string, _sessionId?: string) => {
          if (_userId === userIds.admin) return "admin";
          if (_userId === userIds.operator) return "operator";
          if (_userId === userIds.reviewer) return "reviewer";
          if (_userId === userIds.auditor) return "auditor";
          return null;
        } },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: async (
          selector: string,
          _request: unknown,
          principal: { userId: string; tenantId: string },
        ) => selector === "collection" ? { resourceTenantId: principal.tenantId, resourceOwnerId: principal.userId } : null },
      ],
    })
    class AuditSearchHttpTestModule {}

    app = await NestFactory.create(AuditSearchHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/audit/events`;
    const range = "?from=2026-10-01T00:00:00.000Z&to=2026-10-03T00:00:00.000Z&limit=1";

    const unauthenticated = await fetch(base + range);
    assert.equal(unauthenticated.status, 401);

    const auditor = await fetch(base + range, { headers: { cookie: sessionCookie("auditor") } });
    assert.equal(auditor.status, 200);
    const auditorPage = await auditor.json() as { items: unknown[]; nextCursor: string | null };
    assert.equal(auditorPage.items.length, 1);
    assert.ok(auditorPage.nextCursor);
    const auditorSql = sqlCalls.at(-1)!;
    assert.match(auditorSql.sql, /a\.tenant_id = :tenantId/);
    assert.doesNotMatch(auditorSql.sql, /tg\.user_id = :viewerUserId/);

    const reviewer = await fetch(base + range, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewer.status, 200);
    const reviewerSql = sqlCalls.at(-1)!;
    assert.match(reviewerSql.sql, /a\.action IN \('import\.created', 'run\.created'/);
    assert.match(reviewerSql.sql, /tool_grants tg/);
    assert.match(reviewerSql.sql, /tg\.user_id = :viewerUserId/);
    assert.match(reviewerSql.sql, /'regon\.correction\.reviewed'/);
    assert.match(reviewerSql.sql, /'entity\.conflict\.reviewed'/);
    assert.match(reviewerSql.sql, /ec\.conflict_id::text = a\.resource_id/);
    assert.equal(reviewerSql.replacements.viewerUserId, userIds.reviewer);

    const reviewerToolFilter = await fetch(`${base + range}&toolId=oc-policy-verification`, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewerToolFilter.status, 200);
    const reviewerToolSql = sqlCalls.at(-1)!.sql;
    assert.match(reviewerToolSql, /rc\.correction_id::text = a\.resource_id AND b\.tool_id = :toolId/);
    assert.match(reviewerToolSql, /ec\.conflict_id::text = a\.resource_id AND b\.tool_id = :toolId/);
    assert.match(reviewerToolSql, /e\.artifact_id::text = a\.resource_id OR e\.run_id::text = a\.resource_id/);

    const reviewerAccountAction = await fetch(`${base + range}&action=user.created`, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewerAccountAction.status, 400);
    const reviewerAccountResource = await fetch(`${base + range}&resourceType=settings`, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewerAccountResource.status, 400);
    assert.equal((await fetch(`${base + range}&action=entity.conflict.reviewed`, { headers: { cookie: sessionCookie("reviewer") } })).status, 200);
    assert.equal((await fetch(`${base + range}&resourceType=entity_conflict`, { headers: { cookie: sessionCookie("reviewer") } })).status, 200);
    assert.equal((await fetch(`${base + range}&resourceType=enrichment_job&action=enrichment.job.created`, { headers: { cookie: sessionCookie("reviewer") } })).status, 200);
    assert.match(sqlCalls.at(-1)?.sql ?? "", /FROM enrichment_jobs ej JOIN import_batches b ON b\.id = ej\.batch_id/);

    const nextPage = await fetch(`${base + range}&cursor=${encodeURIComponent(auditorPage.nextCursor!)}`, { headers: { cookie: sessionCookie("auditor") } });
    assert.equal(nextPage.status, 200);
    const mismatchedCursor = await fetch(`${base}?from=2026-09-30T00:00:00.000Z&to=2026-10-03T00:00:00.000Z&limit=1&cursor=${encodeURIComponent(auditorPage.nextCursor!)}`, { headers: { cookie: sessionCookie("auditor") } });
    assert.equal(mismatchedCursor.status, 400);
    const invalidCalendarDate = await fetch(`${base}?from=2026-02-30T00:00:00Z&to=2026-03-02T00:00:00Z`, { headers: { cookie: sessionCookie("auditor") } });
    assert.equal(invalidCalendarDate.status, 400);

    const operator = await fetch(base + range, { headers: { cookie: sessionCookie("operator") } });
    assert.equal(operator.status, 403);
    assert.equal(sqlCalls.length, 7, "rejected role/action/resource/cursor requests must not reach SQL");
  } finally {
    restoreQuery?.();
    await app?.close();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
