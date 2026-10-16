import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { AuthChallengeController } from "./auth-challenge.controller";
import { AuthChallengeRepository } from "./auth-challenge.repository";
import { AuthChallengeService } from "./auth-challenge.service";
import { InterventionController } from "./interventions.controller";
import { InterventionsModule } from "./interventions.module";
import { InterventionRepository } from "./interventions.repository";
import { InterventionService } from "./interventions.service";
import { ManualDataController } from "./manual-data.controller";
import { ManualDataRepository } from "./manual-data.repository";
import { ManualDataService } from "./manual-data.service";
import { WorkerCodeForwarder } from "./worker-code-forwarder";

test("InterventionsModule owns SMS, manual-data, and intervention routes", () => {
  assert.deepEqual(Reflect.getMetadata("imports", InterventionsModule), [
    DatabaseModule,
    AuthModule,
    AuthorizationModule,
  ]);
  assert.deepEqual(Reflect.getMetadata("controllers", InterventionsModule), [
    AuthChallengeController,
    InterventionController,
    ManualDataController,
  ]);
  assert.deepEqual(Reflect.getMetadata("providers", InterventionsModule), [
    AuthChallengeService,
    AuthChallengeRepository,
    InterventionService,
    InterventionRepository,
    ManualDataRepository,
    ManualDataService,
    WorkerCodeForwarder,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", InterventionsModule), [
    AuthChallengeService,
    AuthChallengeRepository,
    InterventionService,
    InterventionRepository,
    ManualDataService,
    WorkerCodeForwarder,
  ]);
  assert.equal(Reflect.getMetadata("path", AuthChallengeController), "auth-challenges");
  assert.equal(Reflect.getMetadata("path", InterventionController), "interventions");
  assert.equal(Reflect.getMetadata("path", ManualDataController), "runs");
});
