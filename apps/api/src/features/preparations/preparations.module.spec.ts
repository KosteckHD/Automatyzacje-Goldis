import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { EnrichmentModule } from "../enrichment/public";
import { ImportPreparationWorkflowController } from "./preparation-workflows.controller";
import { ImportPreparationWorkflowsRepository } from "./preparation-workflows.repository";
import { ImportPreparationWorkflowService } from "./preparation-workflows.service";
import { ImportPreparationController } from "./preparations.controller";
import { PreparationsModule } from "./preparations.module";
import { ImportPreparationsRepository } from "./preparations.repository";
import { ImportPreparationService } from "./preparations.service";

test("PreparationsModule owns preparation HTTP routes and exports its use case", () => {
  assert.deepEqual(Reflect.getMetadata("imports", PreparationsModule), [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    EnrichmentModule,
  ]);
  assert.deepEqual(Reflect.getMetadata("controllers", PreparationsModule), [
    ImportPreparationController,
    ImportPreparationWorkflowController,
  ]);
  assert.deepEqual(Reflect.getMetadata("providers", PreparationsModule), [
    ImportPreparationService,
    ImportPreparationsRepository,
    ImportPreparationWorkflowsRepository,
    ImportPreparationWorkflowService,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", PreparationsModule), [
    ImportPreparationService,
    ImportPreparationWorkflowService,
  ]);
});
