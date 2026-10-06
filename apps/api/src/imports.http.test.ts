import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const sessionSecret = "import-correction-synthetic-session-secret";
const csrfToken = "synthetic-csrf-token-for-import-correction-http-123456";
const batchId = "12345678-1234-1234-1234-123456789abc";
const tenantId = "99999999-9999-4999-8999-999999999999";
const userIds = {
  admin: "11111111-1111-4111-8111-111111111111",
  operator: "22222222-2222-4222-8222-222222222222",
  reviewer: "33333333-3333-4333-8333-333333333333",
  auditor: "44444444-4444-4444-8444-444444444444",
};

function sessionCookie(role: string): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 60_000, userId: userIds[role as keyof typeof userIds], tenantId, csrf: csrfToken,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrfToken}`;
}

test("PATCH /api/imports/:id/rows/:rowNumber wymaga CSRF i przekazuje autora z sesji", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  let received: unknown[] | null = null;
  let receivedReview: unknown[] | null = null;
  let receivedImportList: unknown[] | null = null;
  let receivedRunHistory: unknown[] | null = null;
  let receivedCreate: unknown[] | null = null;
  try {
    const { ImportController, ImportService } = await import("./imports");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } = await import("./session");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("./authorization-guard");
    const service = {
      async create(...args: unknown[]) {
        receivedCreate = args;
        return { id: "synthetic-import", totalRows: 0, invalidRows: 0, readyRows: 0 };
      },
      async proposeRegonCorrection(...args: unknown[]) {
        received = args;
        return { correctionId: "synthetic-correction", rowNumber: 18001, status: "pending", rowVersion: 2 };
      },
      async enrichmentReview(...args: unknown[]) {
        receivedReview = args;
        return {
          page: 1, pageSize: 50, totalRows: 1,
          summary: { missingRegonRows: 0, pendingCorrectionRows: 1, openConflictRows: 0, lookupStatuses: { matched: 1 } },
          rows: [{ rowNumber: 18001, companyName: "Synthetic Company", regonRaw: "", effectiveRegon: "012345678", source: "registry", state: "correction_pending" }],
        };
      },
      async imports(...args: unknown[]) {
        receivedImportList = args;
        return { items: [], nextCursor: null };
      },
      async runs(...args: unknown[]) {
        receivedRunHistory = args;
        return { items: [{ id: "synthetic-run" }], nextCursor: null };
      },
      async results(...args: unknown[]) {
        receivedRunHistory = args;
        return { items: [], nextCursor: null };
      },
    };
    const { HistoryController, HistoryService } = await import("./history");
    @Module({
      controllers: [ImportController, HistoryController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: SESSION_ROLE_RESOLVER, useValue: async (userId: string, requestedTenantId: string) =>
          requestedTenantId === tenantId
          ? userId === userIds.admin ? "admin" : userId === userIds.operator ? "operator" : userId === userIds.reviewer ? "reviewer" : userId === userIds.auditor ? "auditor" : null
            : null },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: async (
          selector: string,
          request: { params?: { id?: string } },
          principal: { userId: string; tenantId: string },
        ) => selector === "new-batch" || selector === "collection"
          ? { resourceTenantId: principal.tenantId, resourceOwnerId: principal.userId }
          : selector === "route-batch" && request.params?.id === batchId
            ? { resourceTenantId: tenantId, resourceOwnerId: userIds.admin }
            : null },
        { provide: ImportService, useValue: service },
        { provide: HistoryService, useValue: service },
      ],
    })
    class ImportCorrectionHttpTestModule {}

    app = await NestFactory.create(ImportCorrectionHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/imports/${batchId}/rows/18001`;
    const body = { proposedRegon: "987654321", reason: "Synthetic operator correction", expectedVersion: 1 };

    const unauthenticated = await fetch(endpoint, { method: "PATCH", body: JSON.stringify(body) });
    assert.equal(unauthenticated.status, 401);

    const noCsrf = await fetch(endpoint, {
      method: "PATCH", headers: { cookie: sessionCookie("admin"), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(noCsrf.status, 403);

    const forbidden = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        cookie: `${sessionCookie("operator")}; goldis_csrf=${csrfToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(forbidden.status, 404);

    const accepted = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        cookie: `${sessionCookie("admin")}; goldis_csrf=${csrfToken}`,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      correctionId: "synthetic-correction", rowNumber: 18001, status: "pending", rowVersion: 2,
    });
    assert.deepEqual(received, [batchId, 18001, body, userIds.admin, { tenantId, actorUserId: userIds.admin }]);

    const upload = new FormData();
    upload.set("file", new Blob(["synthetic-only"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "synthetic.xlsx");
    const uploadWithoutCsrf = await fetch(`http://127.0.0.1:${address.port}/api/imports`, {
      method: "POST", headers: { cookie: sessionCookie("operator") }, body: upload,
    });
    assert.equal(uploadWithoutCsrf.status, 403);
    const created = await fetch(`http://127.0.0.1:${address.port}/api/imports`, {
      method: "POST", headers: { cookie: sessionCookie("operator"), "x-csrf-token": csrfToken }, body: upload,
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { id: "synthetic-import", totalRows: 0, invalidRows: 0, readyRows: 0 });
    assert.equal(receivedCreate?.[1], tenantId);
    assert.equal(receivedCreate?.[2], userIds.operator);

    const importListUnauthenticated = await fetch(`http://127.0.0.1:${address.port}/api/imports`);
    assert.equal(importListUnauthenticated.status, 401);
    const importList = await fetch(`http://127.0.0.1:${address.port}/api/imports?dataState=needs_review&limit=10`, {
      headers: { cookie: sessionCookie("operator") },
    });
    assert.equal(importList.status, 200);
    assert.deepEqual(await importList.json(), { items: [], nextCursor: null });
    const receivedActor = receivedImportList![0] as unknown as { userId: string; tenantId: string; role: string };
    assert.equal(receivedActor.userId, userIds.operator);
    assert.equal(receivedActor.tenantId, tenantId);
    assert.equal(receivedActor.role, "operator");
    assert.deepEqual({ ...(receivedImportList![1] as Record<string, string>) }, { dataState: "needs_review", limit: "10" });

    const historyEndpoint = `http://127.0.0.1:${address.port}/api/history/runs?status=completed&limit=25`;
    const reviewerHistory = await fetch(historyEndpoint, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewerHistory.status, 200);
    assert.deepEqual(await reviewerHistory.json(), { items: [{ id: "synthetic-run" }], nextCursor: null });
    const receivedHistoryActor = receivedRunHistory![0] as unknown as { userId: string; tenantId: string; role: string };
    assert.equal(receivedHistoryActor.userId, userIds.reviewer);
    assert.equal(receivedHistoryActor.role, "reviewer");
    const historyUnauthenticated = await fetch(historyEndpoint);
    assert.equal(historyUnauthenticated.status, 401);
    const auditorHistory = await fetch(historyEndpoint, { headers: { cookie: sessionCookie("auditor") } });
    assert.equal(auditorHistory.status, 403);

    const reviewEndpoint = `http://127.0.0.1:${address.port}/api/imports/${batchId}/enrichment?page=1`;
    const reviewUnauthenticated = await fetch(reviewEndpoint);
    assert.equal(reviewUnauthenticated.status, 401);
    const reviewForbidden = await fetch(reviewEndpoint, { headers: { cookie: sessionCookie("operator") } });
    assert.equal(reviewForbidden.status, 404);
    const reviewByReviewer = await fetch(reviewEndpoint, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewByReviewer.status, 200);
    const reviewResponse = await fetch(reviewEndpoint, { headers: { cookie: sessionCookie("admin") } });
    assert.equal(reviewResponse.status, 200);
    const reviewPayload = await reviewResponse.json();
    assert.equal(reviewPayload.rows[0].source, "registry");
    assert.equal(reviewPayload.rows[0].state, "correction_pending");
    assert.deepEqual(receivedReview, [batchId, 1]);
  } finally {
    if (app) await app.close();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
