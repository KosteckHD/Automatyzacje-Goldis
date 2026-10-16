import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthorizationModule } from "./authorization.module";
import { AuthorizationRepository } from "./authorization.repository";
import { PERMISSION_RESOURCE_RESOLVER, PermissionGuard } from "./authorization-guard";

test("AuthorizationModule owns the resource guard and resolver", () => {
  assert.deepEqual(Reflect.getMetadata("imports", AuthorizationModule), [DatabaseModule]);
  const providers = Reflect.getMetadata("providers", AuthorizationModule) as Array<unknown>;
  assert.ok(providers.includes(PermissionGuard));
  assert.ok(providers.includes(AuthorizationRepository));
  const resolver = providers.find(
    (provider) => typeof provider === "object" && provider !== null && "provide" in provider,
  ) as
    | { inject?: unknown[]; provide?: unknown; useFactory?: (repository: AuthorizationRepository) => unknown }
    | undefined;
  assert.deepEqual(resolver?.provide, PERMISSION_RESOURCE_RESOLVER);
  assert.deepEqual(resolver?.inject, [AuthorizationRepository]);
  assert.equal(typeof resolver?.useFactory, "function");
  assert.deepEqual(Reflect.getMetadata("exports", AuthorizationModule), [
    PermissionGuard,
    PERMISSION_RESOURCE_RESOLVER,
  ]);
});
