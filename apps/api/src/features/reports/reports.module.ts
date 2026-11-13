import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth/public";
import { AuthorizationModule } from "../authorization/public";
import { AdminReportsController, AuditSearchController, OperationalReportsGuard } from "./admin-reports.controller";
import { AdminReportsRepository } from "./admin-reports.repository";
import { AdminReportsService } from "./admin-reports.service";
import { ContactReportController } from "./contact-report.controller";
import { ContactReportRepository } from "./contact-report.repository";
import { ContactReportService } from "./contact-report.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardRepository } from "./dashboard.repository";
import { DashboardService } from "./dashboard.service";
import { HistoryController } from "./history.controller";
import { HistoryRepository } from "./history.repository";
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
  providers: [
    OperationalReportsGuard,
    AdminReportsService,
    AdminReportsRepository,
    DashboardService,
    DashboardRepository,
    ContactReportService,
    ContactReportRepository,
    HistoryService,
    HistoryRepository,
  ],
  exports: [HistoryService],
})
export class ReportsModule {}
