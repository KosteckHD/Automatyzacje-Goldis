import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import type { SessionPrincipal } from "../auth";
import { PermissionGuard, RequirePermission } from "./authorization-guard";

const tenantId = "99999999-9999-4999-8999-999999999999";
const ownerId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const otherTenantId = "88888888-8888-4888-8888-888888888888";
const batchId = "33333333-3333-4333-8333-333333333333";

class TestController {
  readBatch() {}
  proposeCorrection() {}
  createBatch() {}
  readRun() {}
  submitRunBody() {}
  readIntervention() {}
  markInterventionRead() {}
  downloadArtifact() {}
  readCollection() {}
}

for (const [method, action, selector] of [
  ["readBatch", "batch:read", "route-batch"],
  ["proposeCorrection", "correction:propose", "route-batch"],
  ["createBatch", "batch:create", "new-batch"],
  ["readRun", "run:read", "route-run"],
  ["submitRunBody", "sms:submit", "body-run"],
  ["readIntervention", "intervention:read", "route-intervention"],
  ["markInterventionRead", "intervention:mark_read", "route-intervention"],
  ["downloadArtifact", "artifact:download", "route-run"],
  ["readCollection", "batch:read", "collection"],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(TestController.prototype, method);
  assert.ok(descriptor);
  RequirePermission(action, selector)(TestController.prototype, method, descriptor);
}

function principal(role: SessionPrincipal["role"], userId = ownerId, actorTenantId = tenantId): SessionPrincipal {
  return {
    exp: Date.now() + 60_000,
    csrf: "synthetic-csrf-token-for-authz-tests-123456",
    userId,
    tenantId: actorTenantId,
    actorRef: userId,
    role,
  };
}

function executionContext(
  role: SessionPrincipal["role"],
  handlerName: keyof TestController,
  request: Record<string, unknown> = {},
) {
  const requestWithPrincipal = { params: { id: batchId }, ...request, goldisPrincipal: principal(role) };
  const context = {
    switchToHttp: () => ({ getRequest: () => requestWithPrincipal }),
    getHandler: () => TestController.prototype[handlerName],
  } as unknown as ExecutionContext;
  return { context, request: requestWithPrincipal as Record<string, unknown> & { goldisPrincipal?: SessionPrincipal } };
}

function resource(owner = ownerId, tenant = tenantId) {
  return async () => ({ resourceOwnerId: owner, resourceTenantId: tenant });
}

test("operator czyta i zmienia tylko własny batch; reviewer czyta batch tenanta", async () => {
  const operatorOwn = executionContext("operator", "readBatch");
  assert.equal(await new PermissionGuard(resource()).canActivate(operatorOwn.context), true);

  const operatorOther = executionContext("operator", "proposeCorrection");
  const otherOwnerGuard = new PermissionGuard(resource(ownerId));
  operatorOther.request.goldisPrincipal = principal("operator", otherUserId);
  await assert.rejects(
    otherOwnerGuard.canActivate(operatorOther.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
  );

  const reviewer = executionContext("reviewer", "readBatch");
  const reviewerGuard = new PermissionGuard(resource(ownerId));
  reviewer.request.goldisPrincipal = principal("reviewer", otherUserId);
  assert.equal(await reviewerGuard.canActivate(reviewer.context), true);

  const reviewerWrite = executionContext("reviewer", "proposeCorrection");
  await assert.rejects(
    reviewerGuard.canActivate(reviewerWrite.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 403,
  );
});

test("wspólny dostęp do wyników OC nie udostępnia cudzego importu", async () => {
  const request = executionContext("operator", "readBatch");
  const guard = new PermissionGuard(async () => ({
    resourceTenantId: tenantId,
    resourceOwnerId: otherUserId,
    resourceToolId: "oc-policy-verification",
  }));
  await assert.rejects(
    guard.canActivate(request.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
  );
});

test("auditor nie czyta operacyjnych zasobów, operator nie tworzy poza swoim tenantem", async () => {
  const auditor = executionContext("auditor", "readBatch");
  await assert.rejects(
    new PermissionGuard(resource()).canActivate(auditor.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 403,
  );
  const auditorCollection = executionContext("auditor", "readCollection");
  await assert.rejects(
    new PermissionGuard(async (_selector, _request, actor) => ({
      resourceTenantId: actor.tenantId,
      resourceOwnerId: actor.userId,
    })).canActivate(auditorCollection.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 403,
  );
  const reviewerCollection = executionContext("reviewer", "readCollection");
  assert.equal(
    await new PermissionGuard(async (_selector, _request, actor) => ({
      resourceTenantId: actor.tenantId,
      resourceOwnerId: actor.userId,
    })).canActivate(reviewerCollection.context),
    true,
  );

  const newBatch = executionContext("operator", "createBatch");
  const wrongTenantPrincipal = principal("operator", ownerId, otherTenantId);
  newBatch.request.goldisPrincipal = wrongTenantPrincipal;
  assert.equal(
    await new PermissionGuard(async (_selector, _request, actor) => ({
      resourceTenantId: actor.tenantId,
      resourceOwnerId: actor.userId,
    })).canActivate(newBatch.context),
    true,
  );

  const crossTenant = executionContext("reviewer", "readBatch");
  crossTenant.request.goldisPrincipal = principal("reviewer", ownerId, otherTenantId);
  await assert.rejects(
    new PermissionGuard(resource(ownerId, tenantId)).canActivate(crossTenant.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
  );
});

test("brak zasobu i brak principal kończą się odmową, a resolver dostaje wybrany identyfikator", async () => {
  const runContext = executionContext("reviewer", "readRun", { params: { id: batchId } });
  let receivedSelector = "";
  const guard = new PermissionGuard(async (selector, request) => {
    receivedSelector = `${selector}:${(request.params as { id: string }).id}`;
    return { resourceTenantId: tenantId, resourceOwnerId: otherUserId };
  });
  assert.equal(await guard.canActivate(runContext.context), true);
  assert.equal(receivedSelector, `route-run:${batchId}`);

  const bodyRun = executionContext("operator", "submitRunBody", { body: { runId: ownerId } });
  const bodyGuard = new PermissionGuard(async (selector, request) => {
    receivedSelector = `${selector}:${(request.body as { runId: string }).runId}`;
    return { resourceTenantId: tenantId, resourceOwnerId: ownerId };
  });
  assert.equal(await bodyGuard.canActivate(bodyRun.context), true);
  assert.equal(receivedSelector, `body-run:${ownerId}`);

  const missingResource = new PermissionGuard(async () => null);
  await assert.rejects(
    missingResource.canActivate(runContext.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
  );

  runContext.request.goldisPrincipal = undefined;
  await assert.rejects(
    guard.canActivate(runContext.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 403,
  );
});

test("operator may read and mark only an intervention assigned to them", async () => {
  const assignedRead = executionContext("operator", "readIntervention", { params: { id: batchId } });
  const assigned = new PermissionGuard(async () => ({
    resourceTenantId: tenantId,
    resourceOwnerId: otherUserId,
    resourceAssigneeId: ownerId,
  }));
  assert.equal(await assigned.canActivate(assignedRead.context), true);

  const assignedMark = executionContext("operator", "markInterventionRead", { params: { id: batchId } });
  assert.equal(await assigned.canActivate(assignedMark.context), true);

  const unassigned = executionContext("operator", "readIntervention", { params: { id: batchId } });
  const otherAssignment = new PermissionGuard(async () => ({
    resourceTenantId: tenantId,
    resourceOwnerId: otherUserId,
    resourceAssigneeId: otherUserId,
  }));
  await assert.rejects(
    otherAssignment.canActivate(unassigned.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
  );
});

test("operator receives only the read and SMS scope needed for an assigned run", async () => {
  const assignedSms = executionContext("operator", "submitRunBody", { body: { runId: batchId } });
  const assigned = new PermissionGuard(async () => ({
    resourceTenantId: tenantId,
    resourceOwnerId: otherUserId,
    resourceAssigneeId: ownerId,
  }));
  assert.equal(await assigned.canActivate(assignedSms.context), true);

  const directRunRead = executionContext("operator", "readRun", { params: { id: batchId } });
  const runResource = new PermissionGuard(async () => ({
    resourceTenantId: tenantId,
    resourceOwnerId: otherUserId,
    resourceAssigneeId: ownerId,
  }));
  assert.equal(await runResource.canActivate(directRunRead.context), true);

  const artifact = executionContext("operator", "downloadArtifact", { params: { id: batchId } });
  await assert.rejects(
    runResource.canActivate(artifact.context),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
  );
});

test("manager keeps shared OC task visibility when execution grant is absent; task-kind restrictions remain", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= "postgres://goldis_guard_test:unused@127.0.0.1:1/goldis_guard_test";
  let restoreModels: (() => void) | null = null;
  try {
    const { Tool, ToolGrant } = await import("../../infrastructure/database/db");
    const originalToolFindByPk = Tool.findByPk;
    const originalGrantFindOne = ToolGrant.findOne;
    restoreModels = () => {
      Tool.findByPk = originalToolFindByPk;
      ToolGrant.findOne = originalGrantFindOne;
    };
    let grantEnabled = true;
    Tool.findByPk = (async () => ({ toolId: "oc-policy-verification", status: "available" })) as typeof Tool.findByPk;
    ToolGrant.findOne = (async () =>
      grantEnabled
        ? { canDiscover: true, canExecute: true, canViewResults: false, canDownloadResults: false }
        : null) as typeof ToolGrant.findOne;
    const managerSms = executionContext("manager", "markInterventionRead");
    const resolveSms = new PermissionGuard(async () => ({
      resourceTenantId: tenantId,
      resourceOwnerId: otherUserId,
      resourceToolId: "oc-policy-verification",
      resourceInterventionKind: "sms",
      resourceToolStatus: "available",
    }));
    assert.equal(await resolveSms.canActivate(managerSms.context), true);

    const managerOtherIntervention = executionContext("manager", "markInterventionRead");
    const resolveOther = new PermissionGuard(async () => ({
      resourceTenantId: tenantId,
      resourceOwnerId: otherUserId,
      resourceToolId: "oc-policy-verification",
      resourceInterventionKind: "portal_error",
      resourceToolStatus: "available",
    }));
    assert.equal(
      await resolveOther.canActivate(managerOtherIntervention.context),
      true,
      "menedżer może odczytać działania OC w swojej organizacji",
    );

    grantEnabled = false;
    const managerWithoutGrant = executionContext("manager", "markInterventionRead");
    assert.equal(
      await resolveSms.canActivate(managerWithoutGrant.context),
      true,
      "wspólny dostęp menedżera do OC nie zależy od prawa uruchamiania",
    );
  } finally {
    restoreModels?.();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("tenant boundary applies before every owner and assignment exception", async () => {
  const assignedForeignResource = async () => ({
    resourceTenantId: otherTenantId,
    resourceOwnerId: otherUserId,
    resourceAssigneeId: ownerId,
  });
  const guard = new PermissionGuard(assignedForeignResource);

  for (const handler of ["readRun", "readIntervention", "markInterventionRead", "submitRunBody"] as const) {
    const ctx = executionContext("operator", handler, { params: { id: batchId }, body: { runId: batchId } });
    await assert.rejects(
      guard.canActivate(ctx.context),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 404,
    );
  }
});
