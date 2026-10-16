import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { AdminReportsController, AuditSearchController, OperationalReportsGuard } from "./admin-reports.controller";
import { AdminReportsService } from "./admin-reports.service";
import { ContactReportController } from "./contact-report.controller";
import { ContactReportService } from "./contact-report.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { HistoryController } from "./history.controller";
import { HistoryService } from "./history.service";

@Module({
  imports: [AuthModule, AuthorizationModule, AuditModule],
  controllers: [
    AdminReportsController,
    AuditSearchController,
    DashboardController,
    ContactReportController,
    HistoryController,
  ],
  providers: [OperationalReportsGuard, AdminReportsService, DashboardService, ContactReportService, HistoryService],
  exports: [HistoryService],
})
export class ReportsModule {}
