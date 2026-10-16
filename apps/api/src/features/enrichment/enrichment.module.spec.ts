import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { GroupingModule } from "../grouping/public";
import { EnrichmentModule } from "./enrichment.module";
import { EnrichmentJobController } from "./enrichment-job.controller";
import { EnrichmentJobsRepository } from "./enrichment-jobs.repository";
import { EnrichmentJobService } from "./enrichment-jobs.service";
import { RegistryEnrichmentRepository } from "./registry-enrichment.repository";
import { RegistryEnrichmentService } from "./registry-enrichment.service";

test("EnrichmentModule owns the job HTTP route and exports its scheduling use case", () => {
  assert.deepEqual(Reflect.getMetadata("imports", EnrichmentModule), [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GroupingModule,
  ]);
  assert.deepEqual(Reflect.getMetadata("controllers", EnrichmentModule), [EnrichmentJobController]);
  assert.deepEqual(Reflect.getMetadata("providers", EnrichmentModule), [
    EnrichmentJobService,
    EnrichmentJobsRepository,
    RegistryEnrichmentRepository,
    RegistryEnrichmentService,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", EnrichmentModule), [EnrichmentJobService]);
});
