import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { AuthorizationModule } from "../authorization";
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
import { ReportsModule } from "./reports.module";

test("ReportsModule owns reporting routes and exports only the cross-feature history service", () => {
  assert.deepEqual(Reflect.getMetadata("imports", ReportsModule), [AuthModule, AuthorizationModule, AuditModule]);
  assert.deepEqual(Reflect.getMetadata("controllers", ReportsModule), [
    AdminReportsController,
    AuditSearchController,
    DashboardController,
    ContactReportController,
    HistoryController,
  ]);
  assert.deepEqual(Reflect.getMetadata("providers", ReportsModule), [
    OperationalReportsGuard,
    AdminReportsService,
    AdminReportsRepository,
    DashboardService,
    DashboardRepository,
    ContactReportService,
    ContactReportRepository,
    HistoryService,
    HistoryRepository,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", ReportsModule), [HistoryService]);
});
