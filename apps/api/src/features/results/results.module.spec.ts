import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { ArtifactDownloadRepository } from "./artifact-download.repository";
import { ArtifactDownloadService } from "./artifact-download.service";
import { ResultsModule } from "./results.module";
import { ResultsRepository } from "./results.repository";
import { ResultsService } from "./results.service";
import { WorkerResultController, WorkerResultGuard } from "./worker-result.controller";

test("ResultsModule owns the private worker checkpoint route", () => {
  assert.deepEqual(Reflect.getMetadata("imports", ResultsModule), [DatabaseModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", ResultsModule), [WorkerResultController]);
  assert.deepEqual(Reflect.getMetadata("providers", ResultsModule), [
    WorkerResultGuard,
    ArtifactDownloadRepository,
    ArtifactDownloadService,
    ResultsRepository,
    ResultsService,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", ResultsModule), [
    WorkerResultGuard,
    ArtifactDownloadService,
    ResultsService,
  ]);
  assert.equal(Reflect.getMetadata("path", WorkerResultController), "internal/worker-runs");
});
