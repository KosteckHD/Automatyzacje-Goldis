import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { ArtifactDownloadRepository } from "./artifact-download.repository";
import { ArtifactDownloadService } from "./artifact-download.service";
import { ResultsRepository } from "./results.repository";
import { ResultsService } from "./results.service";
import { WorkerResultController, WorkerResultGuard } from "./worker-result.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [WorkerResultController],
  providers: [
    WorkerResultGuard,
    ArtifactDownloadRepository,
    ArtifactDownloadService,
    ResultsRepository,
    ResultsService,
  ],
  exports: [WorkerResultGuard, ArtifactDownloadService, ResultsService],
})
export class ResultsModule {}
