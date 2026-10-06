import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AuthController, SessionGuard } from "./session";
import { HealthController } from "./health";
import { ImportController, ImportService } from "./imports";
import { RunController, RunService } from "./runs";
import { AuthChallengeController, AuthChallengeService, WorkerCodeForwarder } from "./auth-challenges";
import { RegistryEnrichmentService } from "./registry-enrichment";
import { EntityGroupingService } from "./entity-grouping-service";
import { CanonicalRunService } from "./canonical-run-service";
import { BootstrapAdminService } from "./bootstrap-admin";
import { SESSION_PASSWORD_CHANGE_RESOLVER, SESSION_ROLE_RESOLVER, resolveMustChangePassword } from "./session";
import { PERMISSION_RESOURCE_RESOLVER, PermissionGuard, resolvePermissionResource } from "./authorization-guard";
import { LoginRateLimiter } from "./login-rate-limiter";
import { RequestProtectionGuard } from "./request-protection";
import { PublicExceptionFilter, PublicOutputInterceptor } from "./public-output";
import { WorkerResultController, WorkerResultGuard } from "./worker-results";
import { InterventionController, InterventionService } from "./interventions";
import { ManualDataController, ManualDataService } from "./manual-data";
import { AdminController, AdminOnlyGuard, ToolCatalogController } from "./admin";
import { resolveCurrentSessionRole } from "./session";
import { AdminReportsController, AuditSearchController } from "./admin-reports";
import { HistoryController, HistoryService } from "./history";
import { ReviewController } from "./review";
import { ReviewService } from "./review-service";
import { EnrichmentJobController, EnrichmentJobService } from "./enrichment-jobs";
import { RunSubmissionController, RunSubmissionService } from "./run-submissions";

@Module({
  controllers: [AuthController, HealthController, ImportController, RunController, RunSubmissionController, HistoryController, ReviewController, EnrichmentJobController, AuthChallengeController, WorkerResultController, InterventionController, ManualDataController, AdminController, ToolCatalogController, AdminReportsController, AuditSearchController],
  providers: [
    SessionGuard, PermissionGuard, WorkerResultGuard, AdminOnlyGuard, ImportService, RunService, HistoryService, AuthChallengeService, WorkerCodeForwarder, InterventionService, ManualDataService,
    RegistryEnrichmentService, EntityGroupingService, CanonicalRunService, ReviewService, EnrichmentJobService, RunSubmissionService, BootstrapAdminService,
    LoginRateLimiter,
    { provide: APP_GUARD, useClass: RequestProtectionGuard },
    { provide: APP_INTERCEPTOR, useClass: PublicOutputInterceptor },
    { provide: APP_FILTER, useClass: PublicExceptionFilter },
    { provide: SESSION_ROLE_RESOLVER, useValue: resolveCurrentSessionRole },
    { provide: SESSION_PASSWORD_CHANGE_RESOLVER, useValue: resolveMustChangePassword },
    { provide: PERMISSION_RESOURCE_RESOLVER, useValue: resolvePermissionResource },
  ],
})
export class AppModule {}
