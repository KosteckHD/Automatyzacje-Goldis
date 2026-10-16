import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth";
import { BusinessLeadService } from "./business-leads.service";

type Actor = Readonly<{ tenantId: string; userId: string; role: string }>;

@Controller("leads")
@UseGuards(SessionGuard)
export class BusinessLeadController {
  constructor(@Inject(BusinessLeadService) private readonly leads: BusinessLeadService) {}

  private actor(request: Request): Actor {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak aktywnej sesji");
    return { tenantId: principal.tenantId, userId: principal.userId, role: principal.role };
  }

  @Get("recipients")
  recipients(@Req() request: Request) {
    return this.leads.recipients(this.actor(request));
  }

  @Get("allocation-summary")
  allocationSummary(@Req() request: Request, @Query("resultSetId") resultSetId?: string) {
    return this.leads.allocationSummary(this.actor(request), resultSetId);
  }

  @Get("export")
  async export(@Req() request: Request, @Res() response: Response) {
    const file = await this.leads.exportWorkbook(this.actor(request));
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    response.send(file.buffer);
  }

  @Get()
  list(
    @Req() request: Request,
    @Query()
    query: {
      scope?: string;
      contactStatus?: string;
      resultSetId?: string;
      search?: string;
      cursor?: string;
      limit?: string;
    },
  ) {
    return this.leads.list(this.actor(request), { ...query, query: query.search });
  }

  @Post("allocations")
  allocate(@Req() request: Request, @Body() body: unknown) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.leads.allocate(this.actor(request), body);
  }

  @Get(":id/snapshots/:runId/workbook")
  async downloadSnapshot(
    @Req() request: Request,
    @Param("id") id: string,
    @Param("runId") runId: string,
    @Res() response: Response,
  ) {
    const file = await this.leads.downloadSnapshot(this.actor(request), id, runId);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    response.send(file.bytes);
  }

  @Get(":id")
  get(@Req() request: Request, @Param("id") id: string) {
    return this.leads.get(this.actor(request), id);
  }

  @Patch(":id/contact-status")
  updateContactStatus(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.leads.updateContactStatus(this.actor(request), id, body);
  }

  @Post(":id/release-assignment")
  releaseAssignment(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.leads.releaseAssignment(this.actor(request), id, body);
  }
}
