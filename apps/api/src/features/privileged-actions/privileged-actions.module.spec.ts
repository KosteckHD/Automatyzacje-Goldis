import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { PrivilegedActionController } from "./privileged-actions.controller";
import { PrivilegedActionsModule } from "./privileged-actions.module";
import { PRIVILEGED_ACTION_PERSISTENCE } from "./privileged-actions.persistence";
import { PrivilegedActionRepository } from "./privileged-actions.repository";
import { PrivilegedActionService } from "./privileged-actions.service";

test("PrivilegedActionsModule owns the confirmation route, auth limiter and audit service", () => {
  assert.deepEqual(Reflect.getMetadata("imports", PrivilegedActionsModule), [AuthModule, AuditModule, DatabaseModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", PrivilegedActionsModule), [PrivilegedActionController]);
  const providers = Reflect.getMetadata("providers", PrivilegedActionsModule) as Array<unknown>;
  assert.ok(providers.includes(PrivilegedActionService));
  assert.ok(providers.includes(PrivilegedActionRepository));
  assert.ok(
    providers.some(
      (provider) =>
        typeof provider === "object" &&
        provider !== null &&
        "provide" in provider &&
        provider.provide === PRIVILEGED_ACTION_PERSISTENCE &&
        "useExisting" in provider &&
        provider.useExisting === PrivilegedActionRepository,
    ),
  );
  assert.equal(Reflect.getMetadata("path", PrivilegedActionController), "admin/privileged-confirmations");
});
