import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Request } from "express";
import type { SessionPrincipal } from "../auth";
import { AuthorizationRepository } from "./authorization.repository";

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ??= "postgres://synthetic:unused@127.0.0.1:5432/goldis_authorization_repository_test";
let modelsPromise: Promise<typeof import("../../infrastructure/database/db")> | undefined;

function models() {
  modelsPromise ??= import("../../infrastructure/database/db");
  return modelsPromise;
}

after(async () => {
  const importedModels = await modelsPromise;
  if (importedModels) await importedModels.sequelize.close();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

function principal(): SessionPrincipal {
  const userId = "11111111-1111-4111-8111-111111111111";
  return {
    exp: Date.now() + 60_000,
    csrf: "synthetic-authorization-csrf-token-123456",
    userId,
    tenantId: "99999999-9999-4999-8999-999999999999",
    actorRef: userId,
    role: "operator",
  };
}

test("AuthorizationRepository derives collection scope from the authenticated principal", async () => {
  const actor = principal();
  const resource = await new AuthorizationRepository().resolveResource(
    "session-list",
    { params: {}, query: {}, body: { tenantId: "88888888-8888-4888-8888-888888888888" } } as Request,
    actor,
  );
  assert.deepEqual(resource, {
    resourceTenantId: actor.tenantId,
    resourceOwnerId: actor.userId,
    resourceToolId: null,
  });
});

test("AuthorizationRepository resolves a new-batch tool without accepting a tenant from request data", async () => {
  const database = await models();
  const previousFindTool = database.Tool.findByPk;
  const actor = principal();
  try {
    (database.Tool as unknown as { findByPk: (...args: unknown[]) => Promise<unknown> }).findByPk = async (
      ...args: unknown[]
    ) => {
      assert.deepEqual(args, ["oc-policy-verification", { attributes: ["toolId"] }]);
      return { toolId: "oc-policy-verification" };
    };
    const resource = await new AuthorizationRepository().resolveResource(
      "new-batch",
      {
        params: { toolId: "oc-policy-verification" },
        query: {},
        body: { tenantId: "88888888-8888-4888-8888-888888888888" },
      } as unknown as Request,
      actor,
    );
    assert.deepEqual(resource, {
      resourceTenantId: actor.tenantId,
      resourceOwnerId: actor.userId,
      resourceToolId: "oc-policy-verification",
    });
  } finally {
    (database.Tool as unknown as { findByPk: unknown }).findByPk = previousFindTool;
  }
});

test("AuthorizationRepository refuses malformed route identifiers before database lookup", async () => {
  const resource = await new AuthorizationRepository().resolveResource(
    "route-batch",
    { params: { id: "not-a-uuid" }, query: {}, body: {} } as unknown as Request,
    principal(),
  );
  assert.equal(resource, null);
});
