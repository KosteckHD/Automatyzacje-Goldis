import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Controller, Get, Module, Param, Post, Req, UseGuards } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Request } from "express";
import { createHttpApplication, RequestProtectionGuard } from "../../infrastructure/http/index";
import { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, SessionGuard } from "../auth/index";
import { PERMISSION_RESOURCE_RESOLVER, PermissionGuard, RequirePermission } from "../authorization/index";

const sessionSecret = "manager-revocation-http-synthetic-session-secret";
const csrfToken = "synthetic-manager-revocation-csrf-token-2026";
const managerId = "11111111-1111-4111-8111-111111111111";
const tenantId = "99999999-9999-4999-8999-999999999999";
const batchId = "33333333-3333-4333-8333-333333333333";
const runId = "22222222-2222-4222-8222-222222222222";
const interventionId = "44444444-4444-4444-8444-444444444444";
const correctionId = "55555555-5555-4555-8555-555555555555";
const submissionId = "66666666-6666-4666-8666-666666666666";
const toolId = "oc-policy-verification";

function signedCookie(): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + 60_000, userId: managerId, tenantId, csrf: csrfToken }),
  ).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrfToken}`;
}

test("wspólny odczyt OC zostaje dostępny, a cofnięcie prawa uruchamiania blokuje akcje na tej samej sesji", async () => {
  const prior = {
    secret: process.env.SESSION_SECRET,
    databaseUrl: process.env.DATABASE_URL,
    origin: process.env.PUBLIC_APP_ORIGIN,
  };
  process.env.SESSION_SECRET = sessionSecret;
  process.env.DATABASE_URL ??= "postgres://goldis_manager_revocation:unused@127.0.0.1:1/goldis_manager_revocation";
  process.env.PUBLIC_APP_ORIGIN = "https://goldis-manager-revocation.synthetic";
  let restoreModels: (() => void) | null = null;
  let app: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  const calls: string[] = [];
  const grant = { canDiscover: true, canExecute: true, canViewResults: true, canDownloadResults: true };

  @Controller("manager-revocation-probe")
  @UseGuards(SessionGuard, PermissionGuard)
  class ProbeController {
    @Get("batches/:id")
    @RequirePermission("batch:read", "route-batch")
    readBatch(@Param("id") id: string) {
      calls.push(`batch:${id}`);
      return { ok: true };
    }

    @Post("batches/:id/enrichment")
    @RequirePermission("enrichment:start", "route-batch")
    startEnrichment(@Param("id") id: string) {
      calls.push(`enrichment:${id}`);
      return { ok: true };
    }

    @Get("runs/:id")
    @RequirePermission("run:read", "route-run")
    readRun(@Param("id") id: string) {
      calls.push(`run-read:${id}`);
      return { ok: true };
    }

    @Post("runs/:id/cancel")
    @RequirePermission("run:cancel", "route-run")
    cancelRun(@Param("id") id: string) {
      calls.push(`run-cancel:${id}`);
      return { ok: true };
    }

    @Post("sms")
    @RequirePermission("sms:submit", "body-run")
    submitSms(@Req() request: Request) {
      calls.push(`sms:${(request.body as { runId: string }).runId}`);
      return { ok: true };
    }

    @Post("interventions/:id/read")
    @RequirePermission("intervention:mark_read", "route-intervention")
    markIntervention(@Param("id") id: string) {
      calls.push(`intervention:${id}`);
      return { ok: true };
    }

    @Post("corrections/:id/review")
    @RequirePermission("correction:review", "route-correction")
    reviewCorrection(@Param("id") id: string) {
      calls.push(`correction:${id}`);
      return { ok: true };
    }

    @Get("submissions/:id")
    @RequirePermission("submission:read", "route-submission")
    readSubmission(@Param("id") id: string) {
      calls.push(`submission:${id}`);
      return { ok: true };
    }

    @Get("runs/:id/download")
    @RequirePermission("artifact:download", "route-run")
    downloadArtifact(@Param("id") id: string) {
      calls.push(`download:${id}`);
      return { ok: true };
    }
  }

  try {
    const { Tool, ToolGrant } = await import("../../infrastructure/database/db");
    const originalToolFindByPk = Tool.findByPk;
    const originalGrantFindOne = ToolGrant.findOne;
    restoreModels = () => {
      Tool.findByPk = originalToolFindByPk;
      ToolGrant.findOne = originalGrantFindOne;
    };
    Tool.findByPk = (async () => ({ toolId, status: "available" })) as typeof Tool.findByPk;
    ToolGrant.findOne = (async () => ({ ...grant })) as typeof ToolGrant.findOne;

    @Module({
      controllers: [ProbeController],
      providers: [
        SessionGuard,
        PermissionGuard,
        { provide: APP_GUARD, useClass: RequestProtectionGuard },
        {
          provide: SESSION_ROLE_RESOLVER,
          useValue: async (userId: string, requestedTenantId: string) =>
            userId === managerId && requestedTenantId === tenantId ? "manager" : null,
        },
        { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: async () => false },
        {
          provide: PERMISSION_RESOURCE_RESOLVER,
          useValue: async (
            selector: string,
            request: { params?: { id?: string }; body?: { runId?: string } },
            principal: { tenantId: string },
          ) => {
            const id = selector === "body-run" ? request.body?.runId : request.params?.id;
            const allowedIds = new Set([batchId, runId, interventionId, correctionId, submissionId]);
            if (!id || !allowedIds.has(id)) return null;
            return {
              resourceTenantId: principal.tenantId,
              resourceOwnerId: "77777777-7777-4777-8777-777777777777",
              resourceToolId: toolId,
              resourceInterventionKind: selector === "route-intervention" ? "sms" : null,
              resourceToolStatus: "available",
            };
          },
        },
      ],
    })
    class ManagerGrantRevocationTestModule {}

    app = await createHttpApplication(ManagerGrantRevocationTestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const cookie = signedCookie();
    const base = `http://127.0.0.1:${address.port}/api/manager-revocation-probe`;
    const request = (path: string, method = "GET", body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          cookie,
          ...(method === "POST"
            ? {
                origin: process.env.PUBLIC_APP_ORIGIN!,
                "x-csrf-token": csrfToken,
                "content-type": "application/json",
              }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const grantedRequests: Array<[string, string, unknown?]> = [
      [`/batches/${batchId}`, "GET"],
      [`/batches/${batchId}/enrichment`, "POST", {}],
      [`/runs/${runId}`, "GET"],
      [`/runs/${runId}/cancel`, "POST", {}],
      ["/sms", "POST", { runId }],
      [`/interventions/${interventionId}/read`, "POST", {}],
      [`/corrections/${correctionId}/review`, "POST", {}],
      [`/submissions/${submissionId}`, "GET"],
      [`/runs/${runId}/download`, "GET"],
    ];
    for (const [path, method, body] of grantedRequests)
      assert.equal((await request(path, method, body)).status, method === "GET" ? 200 : 201, path);
    assert.equal(calls.length, grantedRequests.length);

    grant.canViewResults = false;
    for (const path of [
      `/batches/${batchId}`,
      `/runs/${runId}`,
      `/corrections/${correctionId}/review`,
      `/submissions/${submissionId}`,
    ]) {
      const method = path.includes("review") ? "POST" : "GET";
      assert.equal(
        (await request(path, method, method === "POST" ? {} : undefined)).status,
        method === "GET" ? 200 : 201,
        `wspólny odczyt OC niezależny od indywidualnego grantu: ${path}`,
      );
    }
    assert.equal(
      calls.length,
      grantedRequests.length + 4,
      "wspólny odczyt umożliwia odczyt danych OC i właściwych działań menedżerskich",
    );
    assert.equal(
      (await request(`/interventions/${interventionId}/read`, "POST", {})).status,
      201,
      "wspólny odczyt pozwala odczytać metadane aktywnego SMS",
    );

    grant.canViewResults = true;
    grant.canExecute = false;
    for (const [path, method, body] of [
      [`/batches/${batchId}/enrichment`, "POST", {}],
      [`/runs/${runId}/cancel`, "POST", {}],
      ["/sms", "POST", { runId }],
    ] as Array<[string, string, unknown]>) {
      assert.equal((await request(path, method, body)).status, 404, `execute grant revoked: ${path}`);
    }
    assert.equal(
      calls.length,
      grantedRequests.length + 5,
      "cofnięcie execute blokuje akcje wykonawcze przed handlerem",
    );
    assert.equal(
      (await request(`/interventions/${interventionId}/read`, "POST", {})).status,
      201,
      "wspólny odczyt pozwala oznaczyć widoczną interwencję jako przeczytaną",
    );
    grant.canViewResults = false;
    assert.equal(
      (await request(`/interventions/${interventionId}/read`, "POST", {})).status,
      201,
      "metadane OC pozostają czytelne przy wspólnym dostępie do wyników",
    );
    assert.equal(calls.length, grantedRequests.length + 7, "odmowy uruchamiania nie wywołują handlera");

    grant.canExecute = true;
    grant.canDownloadResults = false;
    assert.equal((await request(`/runs/${runId}/download`)).status, 200, "wspólny dostęp obejmuje pobranie wyników OC");
    assert.equal(
      calls.length,
      grantedRequests.length + 8,
      "dostęp do plików OC pozostaje niezależny od grantu uruchamiania",
    );
  } finally {
    if (app) await app.close();
    restoreModels?.();
    if (prior.secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prior.secret;
    if (prior.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior.databaseUrl;
    if (prior.origin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = prior.origin;
  }
});
