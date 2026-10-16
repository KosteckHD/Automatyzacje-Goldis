import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth";
import { PermissionGuard, RequirePermission } from "../authorization";
import { PreparedSetExecutionService } from "./prepared-set-executions.service";

@Controller()
@UseGuards(SessionGuard, PermissionGuard)
export class PreparedSetExecutionController {
  constructor(@Inject(PreparedSetExecutionService) private readonly executions: PreparedSetExecutionService) {}

  @Get("imports/:batchId/prepared-set-executions/preview")
  @RequirePermission("run:create", "route-batch")
  preview(@Param("batchId") batchId: string, @Req() request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.executions.preview(batchId, principal);
  }

  @Post("imports/:batchId/prepared-set-executions")
  @RequirePermission("run:create", "route-batch")
  start(@Param("batchId") batchId: string, @Body() body: unknown, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.executions.start(batchId, body, principal);
  }

  @Get("imports/:batchId/prepared-set-executions/:executionId")
  @RequirePermission("run:create", "route-batch")
  get(
    @Param("batchId") batchId: string,
    @Param("executionId") executionId: string,
    @Query("afterOrdinal") afterOrdinal: string | undefined,
    @Req() request: Request,
  ) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.executions.get(batchId, executionId, principal, afterOrdinal);
  }

  @Post("imports/:batchId/prepared-set-executions/:executionId/cancel")
  @RequirePermission("run:create", "route-batch")
  cancel(
    @Param("batchId") batchId: string,
    @Param("executionId") executionId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.executions.cancel(batchId, executionId, body, principal);
  }
}
