import { Body, Controller, ForbiddenException, Inject, Param, Patch, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { ManualDataService } from "./manual-data.service";

@Controller("runs")
@UseGuards(SessionGuard, PermissionGuard)
export class ManualDataController {
  constructor(@Inject(ManualDataService) private readonly manualData: ManualDataService) {}

  @Patch(":id/manual-data")
  @RequirePermission("run:manual_data", "route-run")
  patch(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.manualData.patch(id, { tenantId: principal.tenantId, actorUserId: principal.userId }, body);
  }
}
