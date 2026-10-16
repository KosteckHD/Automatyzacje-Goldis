import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, type SessionPrincipal } from "../auth/public";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { AdminReportsService } from "./admin-reports.service";

function actor(request: Request): SessionPrincipal {
  const current = readSessionPrincipal(request);
  if (!current) throw new ForbiddenException();
  return current;
}
@Controller("audit")
@UseGuards(SessionGuard, PermissionGuard)
export class AuditSearchController {
  constructor(@Inject(AdminReportsService) private readonly reports: AdminReportsService) {}

  @Get("events")
  @RequirePermission("audit:read", "collection")
  async search(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const current = actor(request);
    return this.reports.searchAudit({
      principal: current,
      from: query.from,
      to: query.to,
      actorId: query.actorId,
      action: query.action,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      outcome: query.outcome,
      toolId: query.toolId,
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}

@Injectable()
export class OperationalReportsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const current = readSessionPrincipal(request);
    if (!current || (current.role !== "manager" && current.role !== "admin")) {
      throw new ForbiddenException("Raporty operacyjne są dostępne dla menedżerów i administratorów");
    }
    return true;
  }
}

@Controller("admin/reports")
@UseGuards(SessionGuard, OperationalReportsGuard)
export class AdminReportsController {
  constructor(@Inject(AdminReportsService) private readonly reports: AdminReportsService) {}

  @Get("overview")
  overview(
    @Req() request: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("toolId") toolId?: string,
  ) {
    return this.reports.overview(actor(request), from, to, toolId);
  }

  @Get("failures")
  failures(
    @Req() request: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("toolId") toolId?: string,
  ) {
    return this.reports.failures(actor(request), from, to, toolId);
  }

  @Get("interventions")
  interventions(
    @Req() request: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("toolId") toolId?: string,
  ) {
    return this.reports.interventions(actor(request), from, to, toolId);
  }

  @Get("throughput")
  throughput(
    @Req() request: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("toolId") toolId?: string,
  ) {
    return this.reports.throughput(actor(request), from, to, toolId);
  }
}
