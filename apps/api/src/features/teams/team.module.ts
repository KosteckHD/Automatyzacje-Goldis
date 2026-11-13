import { Module } from "@nestjs/common";
import { AccountRecoveryModule } from "../account-recovery";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { PrivilegedActionsModule } from "../privileged-actions/public";
import { TeamController } from "./team.controller";
import { TeamRepository } from "./team.repository";
import { TeamService } from "./team.service";

@Module({
  imports: [AuthModule, AccountRecoveryModule, AuditModule, PrivilegedActionsModule],
  controllers: [TeamController],
  providers: [TeamRepository, TeamService],
  exports: [TeamService],
})
export class TeamModule {}
