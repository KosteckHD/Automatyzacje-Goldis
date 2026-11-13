import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { PrivilegedActionController } from "./privileged-actions.controller";
import { PRIVILEGED_ACTION_PERSISTENCE } from "./privileged-actions.persistence";
import { PrivilegedActionRepository } from "./privileged-actions.repository";
import { PrivilegedActionService } from "./privileged-actions.service";

@Module({
  imports: [AuthModule, AuditModule, DatabaseModule],
  controllers: [PrivilegedActionController],
  providers: [
    PrivilegedActionService,
    PrivilegedActionRepository,
    { provide: PRIVILEGED_ACTION_PERSISTENCE, useExisting: PrivilegedActionRepository },
  ],
  exports: [PRIVILEGED_ACTION_PERSISTENCE],
})
export class PrivilegedActionsModule {}
