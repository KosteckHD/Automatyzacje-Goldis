import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, type SessionPrincipal, verifyCsrfRequest } from "../auth";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { ImportPreparationWorkflowService } from "./preparation-workflows.service";

@Controller()
@UseGuards(SessionGuard, PermissionGuard)
export class ImportPreparationWorkflowController {
  constructor(@Inject(ImportPreparationWorkflowService) private readonly workflows: ImportPreparationWorkflowService) {}

  private actor(request: Request): SessionPrincipal {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return actor;
  }

  @Post("imports/:batchId/preparations/:preparationId/workflow")
  @RequirePermission("enrichment:start", "route-batch")
  start(
    @Param("batchId") batchId: string,
    @Param("preparationId") preparationId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.workflows.start(batchId, preparationId, body, this.actor(request));
  }

  @Get("imports/:batchId/preparation-workflows")
  @RequirePermission("enrichment:read", "route-batch")
  list(@Param("batchId") batchId: string, @Req() request: Request) {
    return this.workflows.listForBatch(batchId, this.actor(request));
  }

  @Get("imports/:batchId/preparation-workflows/:workflowId")
  @RequirePermission("enrichment:read", "route-batch")
  get(@Param("batchId") batchId: string, @Param("workflowId") workflowId: string, @Req() request: Request) {
    return this.workflows.get(batchId, workflowId, this.actor(request));
  }

  @Post("imports/:batchId/preparation-workflows/:workflowId/cancel")
  @RequirePermission("enrichment:cancel", "route-batch")
  cancel(
    @Param("batchId") batchId: string,
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.workflows.cancel(batchId, workflowId, body, this.actor(request));
  }
}
