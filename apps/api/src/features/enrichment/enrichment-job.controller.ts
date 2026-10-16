import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard } from "../auth";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import type { EnrichmentJobStartDto } from "./enrichment-job.dto";
import { EnrichmentJobService } from "./enrichment-jobs.service";

@Controller()
@UseGuards(SessionGuard, PermissionGuard)
export class EnrichmentJobController {
  constructor(@Inject(EnrichmentJobService) private readonly jobs: EnrichmentJobService) {}

  @Post("imports/:batchId/enrichment-jobs")
  @RequirePermission("enrichment:start", "route-batch")
  start(@Param("batchId") batchId: string, @Body() body: EnrichmentJobStartDto, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.start(batchId, body, actor);
  }

  @Get("imports/:batchId/enrichment-jobs")
  @RequirePermission("enrichment:read", "route-batch")
  listForBatch(@Param("batchId") batchId: string, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.listForBatch(batchId, actor);
  }

  @Get("enrichment-jobs/:id")
  @RequirePermission("enrichment:read", "route-enrichment-job")
  get(@Param("id") id: string, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.get(id, actor);
  }

  @Get("enrichment-jobs/:id/items")
  @RequirePermission("enrichment:read", "route-enrichment-job")
  listItems(@Param("id") id: string, @Query("cursor") cursor: string | undefined, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.listItems(id, cursor, actor);
  }

  @Post("enrichment-jobs/:id/cancel")
  @RequirePermission("enrichment:cancel", "route-enrichment-job")
  cancel(@Param("id") id: string, @Body() body: unknown, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new NotFoundException();
    return this.jobs.cancel(id, body, actor);
  }
}
