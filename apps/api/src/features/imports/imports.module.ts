import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { ReportsModule } from "../reports/public";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { ImportsRepository } from "./imports.repository";

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, AuthorizationModule, ReportsModule],
  controllers: [ImportController],
  providers: [ImportService, ImportsRepository],
  exports: [ImportService],
})
export class ImportsModule {}
