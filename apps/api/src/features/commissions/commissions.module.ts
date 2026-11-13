import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { CommissionsController } from "./commissions.controller";
import { CommissionsRepository } from "./commissions.repository";
import { CommissionsService } from "./commissions.service";

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, AuthorizationModule],
  controllers: [CommissionsController],
  providers: [CommissionsRepository, CommissionsService],
  exports: [CommissionsService],
})
export class CommissionsModule {}
