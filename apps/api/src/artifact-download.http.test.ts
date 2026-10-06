import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SessionGuard } from "./session";

const sessionSecret = "artifact-http-smoke-synthetic-session-secret";
const artifactId = "12345678-1234-1234-1234-123456789abc";
const tenantId = "99999999-9999-4999-8999-999999999999";
const userIds = {
  admin: "11111111-1111-4111-8111-111111111111",
  operator: "22222222-2222-4222-8222-222222222222",
  reviewer: "33333333-3333-4333-8333-333333333333",
};
const bytes = Buffer.from("synthetic-xlsx-payload");

function sessionCookie(role: string, exp = Date.now() + 60_000): string {
  const payload = Buffer.from(JSON.stringify({
    exp, userId: userIds[role as keyof typeof userIds], tenantId,
    csrf: "synthetic-csrf-token-for-artifact-http-tests-123456",
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}`;
}

const runService = {
  async get(id: string) {
    if (id !== artifactId) throw new Error("RUN_NOT_FOUND");
    return {
      id, status: "completed", referenceDate: "2026-09-30",
      policyCounts: { totalOcCount: 4, currentOcCount: 2 }, artifactAvailable: true, events: [],
    };
  },
  async downloadArtifact(id: string) {
    if (id !== artifactId) throw new Error("ARTIFACT_NOT_FOUND");
    return { fileName: "012345678_Synthetic_Company.xlsx", bytes, sha256: "synthetic-hash" };
  },
};

test("GET /api/runs/:id/artifact wymaga sesji, roli i zwraca gotowy plik", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = sessionSecret;
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "postgres://goldis:unused@127.0.0.1:5432/goldis";
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  let auditCreate: unknown;
  let auditRecords: Array<Record<string, unknown>> = [];
  try {
    const models = await import("./db");
    auditCreate = models.AuditEvent.create;
    (models.AuditEvent as unknown as { create: (...args: unknown[]) => Promise<unknown> }).create = async (...args: unknown[]) => {
      const values = args[0] as Record<string, unknown>;
      auditRecords.push(values);
      return values;
    };
    const { RunController, RunService } = await import("./runs");
    const { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER } = await import("./session");
    const { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } = await import("./authorization-guard");
    @Module({
      controllers: [RunController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: SESSION_ROLE_RESOLVER, useValue: async (userId: string, requestedTenantId: string) =>
          requestedTenantId === tenantId
            ? userId === userIds.admin ? "admin" : userId === userIds.operator ? "operator" : userId === userIds.reviewer ? "reviewer" : null
            : null },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        { provide: PERMISSION_RESOURCE_RESOLVER, useValue: async (selector: string, request: { params?: { id?: string } }) =>
          selector === "route-run" && request.params?.id === artifactId
            ? { resourceTenantId: tenantId, resourceOwnerId: userIds.admin }
            : null },
        { provide: RunService, useValue: runService },
      ],
    })
    class ArtifactHttpTestModule {}
    app = await NestFactory.create(ArtifactHttpTestModule, { logger: false });
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const runEndpoint = `http://127.0.0.1:${address.port}/api/runs/${artifactId}`;
    const endpoint = `${runEndpoint}/artifact`;

    const unauthenticated = await fetch(endpoint);
    assert.equal(unauthenticated.status, 401);

    const expiredSession = await fetch(endpoint, { headers: { cookie: sessionCookie("admin", Date.now() - 1) } });
    assert.equal(expiredSession.status, 401);
    assert.equal(auditRecords.length, 0);

    const forbidden = await fetch(endpoint, { headers: { cookie: sessionCookie("operator") } });
    assert.equal(forbidden.status, 404);

    const reviewerRunDetails = await fetch(runEndpoint, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewerRunDetails.status, 200);
    const reviewerArtifact = await fetch(endpoint, { headers: { cookie: sessionCookie("reviewer") } });
    assert.equal(reviewerArtifact.status, 403);

    const missing = await fetch(`http://127.0.0.1:${address.port}/api/runs/00000000-0000-0000-0000-000000000000/artifact`, {
      headers: { cookie: sessionCookie("admin") },
    });
    assert.equal(missing.status, 404);

    const downloaded = await fetch(endpoint, { headers: { cookie: sessionCookie("admin") } });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
    assert.match(downloaded.headers.get("content-disposition") ?? "", /012345678_Synthetic_Company\.xlsx/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    assert.equal(auditRecords.length, 1);
    assert.deepEqual(auditRecords[0], {
      eventId: auditRecords[0].eventId,
      tenantId,
      actorUserId: userIds.admin,
      action: "artifact.downloaded",
      resourceType: "artifact",
      resourceId: artifactId,
      outcome: "succeeded",
      requestRef: auditRecords[0].requestRef,
      metadata: {},
      createdAt: auditRecords[0].createdAt,
    });

    const details = await fetch(runEndpoint, { headers: { cookie: sessionCookie("admin") } });
    assert.equal(details.status, 200);
    assert.deepEqual(await details.json(), {
      id: artifactId, status: "completed", referenceDate: "2026-09-30",
      policyCounts: { totalOcCount: 4, currentOcCount: 2 }, artifactAvailable: true, events: [],
    });
  } finally {
    if (app) await app.close();
    if (auditCreate) {
      const models = await import("./db");
      (models.AuditEvent as unknown as { create: unknown }).create = auditCreate;
      await models.sequelize.close();
    }
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
