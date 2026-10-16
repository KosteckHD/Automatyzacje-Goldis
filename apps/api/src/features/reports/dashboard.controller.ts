import { Controller, ForbiddenException, Get, Inject, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard } from "../auth/public";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get()
  get(@Req() request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak aktywnej sesji");
    return this.dashboard.get({ tenantId: principal.tenantId, userId: principal.userId, role: principal.role });
  }
}
