import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { PrivilegedActionsModule } from "./privileged-actions.module";
import { PrivilegedActionController, PrivilegedActionService } from "./privileged-actions.service";

test("PrivilegedActionsModule owns the confirmation route, auth limiter and audit service", () => {
  assert.deepEqual(Reflect.getMetadata("imports", PrivilegedActionsModule), [AuthModule, AuditModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", PrivilegedActionsModule), [PrivilegedActionController]);
  assert.deepEqual(Reflect.getMetadata("providers", PrivilegedActionsModule), [PrivilegedActionService]);
  assert.equal(Reflect.getMetadata("path", PrivilegedActionController), "admin/privileged-confirmations");
});
