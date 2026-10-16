import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditModule } from "../audit/public";
import { AuthModule } from "../auth";
import { AuthorizationModule } from "../authorization";
import { AdminReportsController, AuditSearchController, OperationalReportsGuard } from "./admin-reports.controller";
import { AdminReportsService } from "./admin-reports.service";
import { ContactReportController } from "./contact-report.controller";
import { ContactReportService } from "./contact-report.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { HistoryController } from "./history.controller";
import { HistoryService } from "./history.service";
import { ReportsModule } from "./reports.module";

test("ReportsModule owns operational/reporting routes and exports history for importing", () => {
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
    DashboardService,
    ContactReportService,
    HistoryService,
  ]);
  assert.deepEqual(Reflect.getMetadata("exports", ReportsModule), [HistoryService]);
});
