import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { DeletionStepUpController } from "./deletion-step-up.controller";
import { DeletionStepUpRepository } from "./deletion-step-up.repository";
import { DeletionStepUpService } from "./deletion-step-up.service";

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [DeletionStepUpController],
  providers: [DeletionStepUpRepository, DeletionStepUpService],
  exports: [DeletionStepUpService],
})
export class DeletionStepUpModule {}
