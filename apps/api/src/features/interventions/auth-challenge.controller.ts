import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
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
import { AuthChallengeService } from "./auth-challenge.service";

@Controller("auth-challenges")
@UseGuards(SessionGuard, PermissionGuard)
export class AuthChallengeController {
  constructor(@Inject(AuthChallengeService) private readonly challenges: AuthChallengeService) {}

  @Get()
  @RequirePermission("sms:submit", "query-run")
  @Header("Cache-Control", "private, no-store")
  getForRun(@Query("runId") runId: string, @Req() req: Request) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.challenges.getForRun(runId ?? "", principal.userId);
  }

  @Post(":id/code")
  @RequirePermission("sms:submit", "body-run")
  @HttpCode(202)
  @Header("Cache-Control", "private, no-store")
  @Header("Pragma", "no-cache")
  submitCode(@Param("id") challengeId: string, @Body() body: { runId?: unknown; code?: unknown }, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    if (
      !body ||
      Object.keys(body).some((key) => key !== "runId" && key !== "code") ||
      typeof body.runId !== "string" ||
      typeof body.code !== "string"
    ) {
      throw new BadRequestException("Nieprawidłowe dane kodu weryfikacyjnego");
    }
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.challenges.submitCode(challengeId, body.runId, body.code, {
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
    });
  }
}
