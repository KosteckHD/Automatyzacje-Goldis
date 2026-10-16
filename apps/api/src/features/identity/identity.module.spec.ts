import assert from "node:assert/strict";
import "reflect-metadata";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { IdentityModule } from "./identity.module";
import { IdentityRepository } from "./identity.repository";
import { IDENTITY_SESSION_REPOSITORY } from "./identity.tokens";

test("IdentityModule owns and exports its database repository", () => {
  assert.deepEqual(Reflect.getMetadata("imports", IdentityModule), [DatabaseModule, AuditModule]);
  const providers = Reflect.getMetadata("providers", IdentityModule) as unknown[];
  assert.ok(providers.includes(IdentityRepository));
  assert.deepEqual(Reflect.getMetadata("exports", IdentityModule), [IDENTITY_SESSION_REPOSITORY]);
});
