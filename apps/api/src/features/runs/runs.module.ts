import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { GroupingModule } from "../grouping/public";
import { InterventionsModule } from "../interventions/public";
import { ResultsModule } from "../results/public";
import { CanonicalRunService } from "./canonical-run-service";
import { RunAdmissionService } from "./run-admission.service";
import { RunCancellationRepository } from "./run-cancellation.repository";
import { RunCancellationService } from "./run-cancellation.service";
import { RunControlRepository } from "./run-control.repository";
import { RunControlService } from "./run-control.service";
import { RunDispatchService } from "./run-dispatch.service";
import { RunRecoveryRepository } from "./run-recovery.repository";
import { RunRecoveryService } from "./run-recovery.service";
import { RunResumeRepository } from "./run-resume.repository";
import { RunResumeService } from "./run-resume.service";
import { RunController } from "./runs.controller";
import { RunService } from "./runs.service";
import { RunsReadRepository } from "./runs-read.repository";
import { RunsReadService } from "./runs-read.service";

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GroupingModule,
    InterventionsModule,
    ResultsModule,
  ],
  controllers: [RunController],
  providers: [
    RunService,
    RunAdmissionService,
    RunCancellationService,
    RunCancellationRepository,
    RunControlService,
    RunControlRepository,
    RunRecoveryService,
    RunRecoveryRepository,
    RunResumeService,
    RunResumeRepository,
    RunDispatchService,
    RunsReadService,
    RunsReadRepository,
    CanonicalRunService,
  ],
  exports: [RunService, RunDispatchService, CanonicalRunService],
})
export class RunsModule {}
