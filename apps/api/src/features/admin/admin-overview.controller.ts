import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { SessionGuard } from "../auth";
import { AdminOnlyGuard, principal } from "./admin.support";
import { AdminOverviewService } from "./admin-overview.service";

@Controller("admin")
@UseGuards(SessionGuard, AdminOnlyGuard)
export class AdminOverviewController {
  constructor(@Inject(AdminOverviewService) private readonly overviewService: AdminOverviewService) {}

  @Get("overview")
  overview(@Req() request: Request) {
    return this.overviewService.overview(principal(request));
  }

  @Get("runtime")
  runtime(@Req() request: Request) {
    return this.overviewService.runtime(principal(request));
  }
}
