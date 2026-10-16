import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuditService } from "../audit/public";
import { readSessionPrincipal, SessionGuard, type SessionPrincipal, verifyCsrfRequest } from "../auth/public";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { artifactDownloadHeaders } from "../results/public";
import type { StartPreparationRequest } from "./preparations.dto";
import { ImportPreparationService } from "./preparations.service";

@Controller()
@UseGuards(SessionGuard, PermissionGuard)
export class ImportPreparationController {
  constructor(
    @Inject(ImportPreparationService) private readonly preparations: ImportPreparationService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private actor(request: Request): SessionPrincipal {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return actor;
  }

  @Post("imports/:batchId/preparations")
  @RequirePermission("enrichment:start", "route-batch")
  start(@Param("batchId") batchId: string, @Body() body: StartPreparationRequest, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.preparations.start(batchId, body, this.actor(request));
  }

  @Get("imports/:batchId/preparations")
  @RequirePermission("enrichment:read", "route-batch")
  list(@Param("batchId") batchId: string, @Req() request: Request) {
    return this.preparations.listForBatch(batchId, this.actor(request));
  }

  @Get("imports/:batchId/preparations/:preparationId")
  @RequirePermission("enrichment:read", "route-batch")
  get(@Param("batchId") batchId: string, @Param("preparationId") preparationId: string, @Req() request: Request) {
    return this.preparations.get(batchId, preparationId, this.actor(request));
  }

  @Get("imports/:batchId/preparations/:preparationId/rows")
  @RequirePermission("enrichment:read", "route-batch")
  rows(
    @Param("batchId") batchId: string,
    @Param("preparationId") preparationId: string,
    @Query("page") rawPage: string | undefined,
    @Query("state") state: string | undefined,
    @Req() request: Request,
  ) {
    const page = rawPage ? Number(rawPage) : 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
      throw new BadRequestException("Nieprawidłowa strona przygotowania");
    return this.preparations.rows(batchId, preparationId, page, state, this.actor(request));
  }

  @Get("imports/:batchId/preparations/:preparationId/export")
  @RequirePermission("artifact:download", "route-batch")
  async export(
    @Param("batchId") batchId: string,
    @Param("preparationId") preparationId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const principal = this.actor(request);
    const artifact = await this.preparations.exportWorkbook(batchId, preparationId, principal);
    try {
      await this.audit.record({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action: "artifact.downloaded",
        resourceType: "artifact",
        resourceId: preparationId,
        outcome: "succeeded",
        metadata: {
          batchId,
          preparationId,
          revision: artifact.revision,
          rowCount: artifact.rowCount,
          purpose: "prepared_dataset",
        },
      });
    } catch {
      throw new ServiceUnavailableException("Nie można zapisać zdarzenia audytu pobrania");
    }
    for (const [name, value] of Object.entries(artifactDownloadHeaders(artifact.fileName, artifact.bytes.byteLength))) {
      response.setHeader(name, value);
    }
    response.status(200).send(artifact.bytes);
  }

  @Post("imports/:batchId/preparations/:preparationId/cancel")
  @RequirePermission("enrichment:cancel", "route-batch")
  cancel(
    @Param("batchId") batchId: string,
    @Param("preparationId") preparationId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.preparations.cancel(batchId, preparationId, body, this.actor(request));
  }
}
