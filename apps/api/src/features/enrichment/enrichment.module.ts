import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { GroupingModule } from "../grouping/public";
import { EnrichmentJobController } from "./enrichment-job.controller";
import { EnrichmentJobsRepository } from "./enrichment-jobs.repository";
import { EnrichmentJobService } from "./enrichment-jobs.service";
import { RegistryEnrichmentRepository } from "./registry-enrichment.repository";
import { RegistryEnrichmentService } from "./registry-enrichment.service";

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, AuthorizationModule, GroupingModule],
  controllers: [EnrichmentJobController],
  providers: [EnrichmentJobService, EnrichmentJobsRepository, RegistryEnrichmentRepository, RegistryEnrichmentService],
  exports: [EnrichmentJobService],
})
export class EnrichmentModule {}
