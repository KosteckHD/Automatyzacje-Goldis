import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuthModule } from "../auth/public";
import { DeletionJobRunner } from "./deletion-job-runner";
import { DeletionJobController } from "./deletion-jobs";
import { DeletionJobsRepository } from "./deletion-jobs.repository";
import { DeletionJobsService } from "./deletion-jobs.service";
import { DeletionStepUpModule } from "./deletion-step-up.module";
import { DeletionController } from "./deletions.controller";
import { DeletionsPreviewRepository } from "./deletions.repository";
import { DeletionsService } from "./deletions.service";

@Module({
  imports: [DatabaseModule, AuthModule, DeletionStepUpModule],
  controllers: [DeletionController, DeletionJobController],
  providers: [
    DeletionJobRunner,
    DeletionJobsRepository,
    DeletionJobsService,
    DeletionsPreviewRepository,
    DeletionsService,
  ],
  exports: [DeletionJobRunner],
})
export class DeletionsModule {}
