import {
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { PrivilegedActionService, ReauthRateLimitError } from "./privileged-actions.service";

@Controller("admin/privileged-confirmations")
@UseGuards(SessionGuard)
export class PrivilegedActionController {
  constructor(@Inject(PrivilegedActionService) private readonly privilegedActions: PrivilegedActionService) {}

  @Post()
  async create(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() input: unknown) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(request);
    if (!actor) throw new UnauthorizedException();
    const clientIp = request.ip || request.socket.remoteAddress || "unknown";
    try {
      return await this.privilegedActions.create(actor, input, clientIp);
    } catch (error) {
      if (!(error instanceof ReauthRateLimitError)) throw error;
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw new HttpException(error.message, 429);
    }
  }
}
