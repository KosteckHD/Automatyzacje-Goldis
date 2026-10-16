import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { SessionGuard } from "../auth";
import { AdminOnlyGuard, principal, requireCsrf } from "./admin.support";
import { AdminOperationsService } from "./admin-operations.service";

@Controller("admin")
@UseGuards(SessionGuard, AdminOnlyGuard)
export class AdminOperationsController {
  constructor(@Inject(AdminOperationsService) private readonly operations: AdminOperationsService) {}

  @Get("operations/summary")
  operationsSummary(@Req() request: Request) {
    return this.operations.operationsSummary(principal(request));
  }

  @Get("operations/runs")
  operationsRuns(
    @Req() request: Request,
    @Query("toolId") toolId?: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
  ) {
    return this.operations.operationsRuns(principal(request), toolId, status, page);
  }

  @Get("interventions")
  adminInterventions(
    @Req() request: Request,
    @Query("status") status = "open",
    @Query("assigneeUserId") assigneeUserId?: string,
    @Query("toolId") toolId?: string,
    @Query("priority") priority?: string,
    @Query("page") page?: string,
  ) {
    return this.operations.adminInterventions(principal(request), status, assigneeUserId, toolId, priority, page);
  }

  @Patch("interventions/:id/assignment")
  assignIntervention(@Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    return this.operations.assignIntervention(id, input, principal(request));
  }

  @Patch("interventions/:id/priority")
  setInterventionPriority(@Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    return this.operations.setInterventionPriority(id, input, principal(request));
  }

  @Get("interventions/:id/activity")
  interventionActivity(@Param("id") id: string, @Req() request: Request) {
    return this.operations.interventionActivity(id, principal(request));
  }
}
