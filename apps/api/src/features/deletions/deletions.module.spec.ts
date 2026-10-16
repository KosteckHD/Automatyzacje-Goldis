import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthModule } from "../auth/public";
import { DeletionJobRunner } from "./deletion-job-runner";
import { DeletionJobController } from "./deletion-jobs";
import { DeletionJobsRepository } from "./deletion-jobs.repository";
import { DeletionJobsService } from "./deletion-jobs.service";
import { DeletionStepUpModule } from "./deletion-step-up.module";
import { DeletionController } from "./deletions.controller";
import { DeletionsModule } from "./deletions.module";
import { DeletionsPreviewRepository } from "./deletions.repository";
import { DeletionsService } from "./deletions.service";

test("DeletionsModule owns preview, job, and runner lifecycle", () => {
  assert.deepEqual(Reflect.getMetadata("imports", DeletionsModule), [DatabaseModule, AuthModule, DeletionStepUpModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", DeletionsModule), [DeletionController, DeletionJobController]);
  assert.deepEqual(Reflect.getMetadata("providers", DeletionsModule), [
    DeletionJobRunner,
    DeletionJobsRepository,
    DeletionJobsService,
    DeletionsPreviewRepository,
    DeletionsService,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", DeletionsModule), [DeletionJobRunner]);
  assert.equal(Reflect.getMetadata("path", DeletionController), "deletions");
  assert.equal(Reflect.getMetadata("path", DeletionJobController), "deletions");
});
