import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { PasswordRecoveryService } from "../account-recovery";
import { readSessionPrincipal, SessionGuard, type SessionPrincipal, verifyCsrfRequest } from "../auth";
import { TeamService } from "./team.service";

function actor(request: Request): SessionPrincipal {
  const principal = readSessionPrincipal(request);
  if (!principal || (principal.role !== "manager" && principal.role !== "admin")) {
    throw new ForbiddenException("Dostęp do zarządzania zespołem wymaga roli menedżera");
  }
  return principal;
}
function csrf(request: Request): void {
  if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
}

@Controller("team")
@UseGuards(SessionGuard)
export class TeamController {
  constructor(
    @Inject(TeamService) private readonly team: TeamService,
    @Inject(PasswordRecoveryService) private readonly recovery: PasswordRecoveryService,
  ) {}

  @Get("users")
  list(@Req() request: Request, @Query("q") query?: string) {
    return this.team.list(actor(request), query);
  }

  @Post("users")
  create(@Req() request: Request, @Body() input: unknown) {
    csrf(request);
    return this.team.create(actor(request), input);
  }

  @Patch("users/:userId/status")
  setStatus(@Req() request: Request, @Param("userId") userId: string, @Body() input: unknown) {
    csrf(request);
    return this.team.setStatus(actor(request), userId, input);
  }

  @Post("users/:userId/password")
  resetPassword(@Req() request: Request, @Param("userId") userId: string, @Body() input: unknown) {
    csrf(request);
    return this.team.resetPassword(actor(request), userId, input);
  }

  @Post("users/:userId/password-reset-link")
  @HttpCode(HttpStatus.ACCEPTED)
  requestPasswordResetLink(@Req() request: Request, @Param("userId") userId: string, @Body() input: unknown) {
    csrf(request);
    return this.recovery.enqueuePrivilegedResetLink(actor(request), userId, input, true);
  }

  @Post("users/:userId/recovery-email")
  @HttpCode(HttpStatus.ACCEPTED)
  requestRecoveryEmail(@Req() request: Request, @Param("userId") userId: string, @Body() input: unknown) {
    csrf(request);
    return this.recovery.setTargetRecoveryEmail(actor(request), userId, input, true);
  }

  @Get("users/:userId/access")
  access(@Req() request: Request, @Param("userId") userId: string) {
    return this.team.access(actor(request), userId);
  }

  @Put("users/:userId/access")
  setAccess(@Req() request: Request, @Param("userId") userId: string, @Body() input: unknown) {
    csrf(request);
    return this.team.setAccess(actor(request), userId, input);
  }
}
