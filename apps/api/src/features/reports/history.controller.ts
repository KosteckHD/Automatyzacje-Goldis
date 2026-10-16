import { Controller, ForbiddenException, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, type SessionPrincipal } from "../auth/public";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { type HistoryQuery, HistoryService } from "./history.service";

type Principal = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;

function principal(request: Request): Principal {
  const actor = readSessionPrincipal(request);
  if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
  return actor;
}

@Controller("history")
@UseGuards(SessionGuard, PermissionGuard)
export class HistoryController {
  constructor(@Inject(HistoryService) private readonly history: HistoryService) {}

  @Get("runs")
  @RequirePermission("run:read", "collection")
  runs(@Req() request: Request, @Query() query: HistoryQuery) {
    return this.history.runs(principal(request), query);
  }

  @Get("results")
  @RequirePermission("batch:read", "collection")
  results(@Req() request: Request, @Query() query: HistoryQuery) {
    return this.history.results(principal(request), query);
  }
}
