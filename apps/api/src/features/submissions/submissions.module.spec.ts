import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { GroupingModule } from "../grouping/public";
import { LeadsModule } from "../leads/public";
import { NotificationsModule } from "../notifications/public";
import { PreparationsModule } from "../preparations/public";
import { RunsModule } from "../runs/public";
import { PreparedSetExecutionRepository } from "./prepared-set-execution.repository";
import { PreparedSetExecutionControlRepository } from "./prepared-set-execution-control.repository";
import { PreparedSetExecutionController } from "./prepared-set-executions.controller";
import { PreparedSetExecutionService } from "./prepared-set-executions.service";
import { RunSubmissionAccessRepository } from "./run-submission-access.repository";
import { RunSubmissionAdmissionRepository } from "./run-submission-admission.repository";
import { RunSubmissionAdmissionService } from "./run-submission-admission.service";
import { RunSubmissionCancellationRepository } from "./run-submission-cancellation.repository";
import { RunSubmissionCreateRepository } from "./run-submission-create.repository";
import { RunSubmissionPreviewRepository } from "./run-submission-preview.repository";
import { RunSubmissionReadRepository } from "./run-submission-read.repository";
import { RunSubmissionController } from "./run-submissions.controller";
import { RunSubmissionService } from "./run-submissions.service";
import { SubmissionsModule } from "./submissions.module";

test("SubmissionsModule owns submission and prepared-set HTTP routes and dispatch services", () => {
  assert.deepEqual(Reflect.getMetadata("imports", SubmissionsModule), [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GroupingModule,
    RunsModule,
    PreparationsModule,
    LeadsModule,
    NotificationsModule,
  ]);
  assert.deepEqual(Reflect.getMetadata("controllers", SubmissionsModule), [
    RunSubmissionController,
    PreparedSetExecutionController,
  ]);
  assert.deepEqual(Reflect.getMetadata("providers", SubmissionsModule), [
    RunSubmissionService,
    RunSubmissionAdmissionService,
    RunSubmissionAdmissionRepository,
    RunSubmissionCancellationRepository,
    RunSubmissionReadRepository,
    RunSubmissionPreviewRepository,
    RunSubmissionAccessRepository,
    RunSubmissionCreateRepository,
    PreparedSetExecutionRepository,
    PreparedSetExecutionControlRepository,
    PreparedSetExecutionService,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", SubmissionsModule), [
    RunSubmissionService,
    PreparedSetExecutionService,
  ]);
});
