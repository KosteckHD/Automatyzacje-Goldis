import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { InterventionService } from "./interventions.service";

@Controller("interventions")
@UseGuards(SessionGuard, PermissionGuard)
export class InterventionController {
  constructor(@Inject(InterventionService) private readonly interventions: InterventionService) {}

  @Get()
  @RequirePermission("intervention:read", "session-list")
  list(@Req() req: Request, @Query() query: Record<string, string | undefined>) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new BadRequestException("Brak sesji");
    return this.interventions.list(principal, query);
  }

  @Get("summary")
  @RequirePermission("intervention:read", "session-list")
  summary(@Req() req: Request) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new BadRequestException("Brak sesji");
    return this.interventions.summary(principal);
  }

  @Post(":id/read")
  @HttpCode(200)
  @RequirePermission("intervention:mark_read", "route-intervention")
  markRead(@Param("id") id: string, @Req() req: Request, @Body() body: unknown) {
    if (!verifyCsrfRequest(req)) throw new BadRequestException("Wymagany jest poprawny token CSRF");
    if (body && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)) {
      throw new BadRequestException("Nieprawidłowe dane odczytu zgłoszenia");
    }
    const principal = readSessionPrincipal(req);
    if (!principal) throw new BadRequestException("Brak sesji");
    return this.interventions.markRead(id, principal.userId);
  }
}
