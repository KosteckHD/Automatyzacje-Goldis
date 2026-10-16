import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { EnrichmentModule } from "../enrichment/public";
import { ImportPreparationWorkflowController } from "./preparation-workflows.controller";
import { ImportPreparationWorkflowsRepository } from "./preparation-workflows.repository";
import { ImportPreparationWorkflowService } from "./preparation-workflows.service";
import { ImportPreparationController } from "./preparations.controller";
import { ImportPreparationsRepository } from "./preparations.repository";
import { ImportPreparationService } from "./preparations.service";

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, AuthorizationModule, EnrichmentModule],
  controllers: [ImportPreparationController, ImportPreparationWorkflowController],
  providers: [
    ImportPreparationService,
    ImportPreparationsRepository,
    ImportPreparationWorkflowsRepository,
    ImportPreparationWorkflowService,
  ],
  exports: [ImportPreparationService, ImportPreparationWorkflowService],
})
export class PreparationsModule {}
