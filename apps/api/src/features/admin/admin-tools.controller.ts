import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { SessionGuard } from "../auth";
import { AdminOnlyGuard, principal, requireCsrf, toolIdPattern } from "./admin.support";
import { parseAdminToolSettingsUpdate } from "./admin-tools.dto";
import { AdminToolsService } from "./admin-tools.service";

@Controller("admin")
@UseGuards(SessionGuard, AdminOnlyGuard)
export class AdminToolsController {
  constructor(@Inject(AdminToolsService) private readonly tools: AdminToolsService) {}

  @Get("tools")
  async adminTools(@Req() request: Request) {
    principal(request);
    return this.tools.listTools();
  }

  @Get("tools/:toolId/settings")
  async getSettings(@Param("toolId") toolId: string, @Req() request: Request) {
    const actor = principal(request);
    if (!toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowe narzędzie");
    return this.tools.getSettings(actor.tenantId, toolId);
  }

  @Patch("tools/:toolId/settings")
  async updateSettings(@Param("toolId") toolId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!toolIdPattern.test(toolId)) throw new BadRequestException("Nieprawidłowe narzędzie");
    return this.tools.updateSettings(actor, toolId, parseAdminToolSettingsUpdate(input));
  }
}
