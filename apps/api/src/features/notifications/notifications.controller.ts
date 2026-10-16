import { Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { NotificationService } from "./notifications.service";

function actor(request: Request) {
  const principal = readSessionPrincipal(request);
  if (!principal) throw new ForbiddenException("Brak aktywnej sesji");
  return { tenantId: principal.tenantId, userId: principal.userId };
}

@Controller("notifications")
@UseGuards(SessionGuard)
export class NotificationController {
  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  @Get()
  list(@Req() request: Request, @Query() query: { limit?: string; unreadOnly?: string }) {
    return this.notifications.list(actor(request), query.limit, query.unreadOnly);
  }

  @Post(":id/read")
  markRead(@Req() request: Request, @Param("id") id: string) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    return this.notifications.markRead(actor(request), id);
  }
}
