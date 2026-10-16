import { Controller, ForbiddenException, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard } from "../auth/public";
import { ContactReportService } from "./contact-report.service";

@Controller("contact-reports")
@UseGuards(SessionGuard)
export class ContactReportController {
  constructor(@Inject(ContactReportService) private readonly reports: ContactReportService) {}

  @Get("overview")
  overview(
    @Req() request: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("resultSetId") resultSetId?: string,
  ) {
    const current = readSessionPrincipal(request);
    if (!current) throw new ForbiddenException("Brak aktywnej sesji");
    return this.reports.overview(current, from, to, resultSetId);
  }
}
