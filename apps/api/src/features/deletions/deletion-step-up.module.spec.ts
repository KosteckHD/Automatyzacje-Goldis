import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { DeletionStepUpController } from "./deletion-step-up.controller";
import { DeletionStepUpModule } from "./deletion-step-up.module";
import { DeletionStepUpRepository } from "./deletion-step-up.repository";
import { DeletionStepUpService } from "./deletion-step-up.service";

test("DeletionStepUpModule owns the historical auth route and its use case/repository", () => {
  assert.deepEqual(Reflect.getMetadata("imports", DeletionStepUpModule), [AuthModule, AuditModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", DeletionStepUpModule), [DeletionStepUpController]);
  assert.deepEqual(Reflect.getMetadata("providers", DeletionStepUpModule), [
    DeletionStepUpRepository,
    DeletionStepUpService,
  ]);
  assert.equal(Reflect.getMetadata("path", DeletionStepUpController), "auth");
  assert.equal(Reflect.getMetadata("path", DeletionStepUpController.prototype.requestStepUp), "deletion-step-up");
});
