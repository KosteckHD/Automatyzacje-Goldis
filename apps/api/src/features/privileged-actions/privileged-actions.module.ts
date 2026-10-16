import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { PrivilegedActionController, PrivilegedActionService } from "./privileged-actions.service";

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [PrivilegedActionController],
  providers: [PrivilegedActionService],
})
export class PrivilegedActionsModule {}
