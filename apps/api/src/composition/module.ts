import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "../features/auth";
import { AccountRecoveryModule } from "../features/account-recovery";
import { TeamModule } from "../features/teams";
import { ToolsModule } from "../features/tools";
import { AuditModule } from "../features/audit";
import { AdminModule } from "../features/admin";
import { ReportsModule } from "../features/reports";
import { AuthorizationModule } from "../features/authorization";
import { DeletionsModule } from "../features/deletions/public";
import { HealthModule } from "../features/health";
import { DatabaseModule } from "../infrastructure/database";
import { ImportsModule } from "../features/imports/imports.module";
import { PreparationsModule } from "../features/preparations/public";
import { GroupingModule } from "../features/grouping/public";
import { ReviewModule } from "../features/review/public";
import { RunsModule } from "../features/runs/public";
import { SubmissionsModule } from "../features/submissions/public";
import { LeadsModule } from "../features/leads/public";
import { NotificationsModule } from "../features/notifications/public";
import { PrivilegedActionsModule } from "../features/privileged-actions/public";
import { InterventionsModule } from "../features/interventions/public";
import { ResultsModule } from "../features/results/public";
import { PublicExceptionFilter, PublicOutputInterceptor, RequestProtectionGuard } from "../infrastructure/http";

@Module({
  imports: [DatabaseModule, HealthModule, AuthModule, AccountRecoveryModule, AuthorizationModule, DeletionsModule, InterventionsModule, ResultsModule, TeamModule, ToolsModule, AuditModule, AdminModule, ReportsModule, ImportsModule, PreparationsModule, GroupingModule, ReviewModule, PrivilegedActionsModule, RunsModule, SubmissionsModule, LeadsModule, NotificationsModule],
  providers: [
    { provide: APP_GUARD, useClass: RequestProtectionGuard },
    { provide: APP_INTERCEPTOR, useClass: PublicOutputInterceptor },
    { provide: APP_FILTER, useClass: PublicExceptionFilter },
  ],
})
export class AppModule {}
