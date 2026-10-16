import { Module } from "@nestjs/common";
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

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GroupingModule,
    RunsModule,
    PreparationsModule,
    LeadsModule,
    NotificationsModule,
  ],
  controllers: [RunSubmissionController, PreparedSetExecutionController],
  providers: [
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
  ],
  exports: [RunSubmissionService, PreparedSetExecutionService],
})
export class SubmissionsModule {}
