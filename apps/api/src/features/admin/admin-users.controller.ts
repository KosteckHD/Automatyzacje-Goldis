import {
  BadRequestException,
  Body,
  Controller,
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
import { SessionGuard } from "../auth";
import {
  AdminOnlyGuard,
  principal,
  requireCsrf,
  roles,
  safePage,
  strictObject,
  toolIdPattern,
  uuidPattern,
} from "./admin.support";
import {
  parseAdminCreateUserInput,
  parseAdminRevokeToolGrantInput,
  parseAdminSetDeletionGrantInput,
  parseAdminSetToolGrantInput,
} from "./admin-users.dto";
import { AdminUsersService } from "./admin-users.service";

@Controller("admin")
@UseGuards(SessionGuard, AdminOnlyGuard)
export class AdminUsersController {
  constructor(
    @Inject(PasswordRecoveryService) private readonly recovery: PasswordRecoveryService,
    @Inject(AdminUsersService) private readonly usersService: AdminUsersService,
  ) {}
  @Get("users")
  async users(
    @Req() request: Request,
    @Query("limit") rawLimit?: string,
    @Query("cursor") cursor?: string,
    @Query("q") rawQuery?: string,
  ) {
    return this.usersService.list(principal(request), { limit: safePage(rawLimit), cursor, query: rawQuery });
  }
  @Post("users")
  async createUser(@Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    return this.usersService.createUser(principal(request), parseAdminCreateUserInput(input));
  }

  @Get("users/:userId/grants")
  async grants(@Param("userId") userId: string, @Req() request: Request) {
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    return this.usersService.grants(actor, userId);
  }

  @Put("users/:userId/grants/:toolId")
  async setGrant(
    @Param("userId") userId: string,
    @Param("toolId") toolId: string,
    @Body() input: unknown,
    @Req() request: Request,
  ) {
    requireCsrf(request);
    if (!uuidPattern.test(userId) || !toolIdPattern.test(toolId))
      throw new BadRequestException("Nieprawidłowy użytkownik lub narzędzie");
    return this.usersService.setToolGrant(principal(request), userId, toolId, parseAdminSetToolGrantInput(input));
  }
  @Put("users/:userId/deletion-grant")
  async setDeletionGrant(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    return this.usersService.setDeletionGrant(principal(request), userId, parseAdminSetDeletionGrantInput(input));
  }
  @Post("users/:userId/grants/:toolId/revoke")
  async revokeGrant(
    @Param("userId") userId: string,
    @Param("toolId") toolId: string,
    @Body() input: unknown,
    @Req() request: Request,
  ) {
    requireCsrf(request);
    if (!uuidPattern.test(userId) || !toolIdPattern.test(toolId))
      throw new BadRequestException("Nieprawidłowy użytkownik lub narzędzie");
    return this.usersService.revokeToolGrant(principal(request), userId, toolId, parseAdminRevokeToolGrantInput(input));
  }
  @Get("users/:userId/sessions")
  async userSessions(@Param("userId") userId: string, @Req() request: Request) {
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    return this.usersService.sessions(actor, userId);
  }

  @Post("users/:userId/sessions/:sessionId/revoke")
  async revokeUserSession(
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Body() input: unknown,
    @Req() request: Request,
  ) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId) || !uuidPattern.test(sessionId)) throw new BadRequestException("Nieprawidłowa sesja");
    const body = strictObject(input, ["confirmationToken", "idempotencyKey"]);
    return this.usersService.revokeSession(actor, {
      userId,
      sessionId,
      confirmationToken: body.confirmationToken,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post("users/:userId/revoke-sessions")
  async revokeUserSessions(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    const body = strictObject(input, ["confirmationToken", "idempotencyKey"]);
    return this.usersService.revokeSessions(actor, {
      userId,
      confirmationToken: body.confirmationToken,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post("users/:userId/disable")
  async disableUser(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    const body = strictObject(input, ["status", "confirmationToken", "idempotencyKey"]);
    if (body.status !== "disabled") throw new BadRequestException("Nieprawidłowy status konta");
    return this.usersService.setUserStatus(actor, {
      userId,
      status: "disabled",
      confirmationToken: body.confirmationToken,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post("users/:userId/enable")
  async enableUser(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    if (!uuidPattern.test(userId)) throw new BadRequestException("Nieprawidłowy identyfikator użytkownika");
    const body = strictObject(input, ["status", "confirmationToken", "idempotencyKey"]);
    if (body.status !== "active") throw new BadRequestException("Nieprawidłowy status konta");
    return this.usersService.setUserStatus(actor, {
      userId,
      status: "active",
      confirmationToken: body.confirmationToken,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Patch("users/:userId/role")
  async updateRole(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    const body = strictObject(input, ["role", "confirmationToken", "idempotencyKey"]);
    if (!uuidPattern.test(userId) || typeof body.role !== "string" || !roles.has(body.role))
      throw new BadRequestException("Nieprawidłowy identyfikator lub rola");
    return this.usersService.updateRole(actor, {
      userId,
      role: body.role as "admin" | "manager" | "operator" | "reviewer" | "auditor",
      confirmationToken: body.confirmationToken,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post("users/:userId/password")
  async resetPassword(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = principal(request);
    const body = strictObject(input, ["temporaryPassword", "confirmationToken", "idempotencyKey"]);
    if (!uuidPattern.test(userId) || typeof body.temporaryPassword !== "string") {
      throw new BadRequestException("Hasło tymczasowe nie spełnia wymagań");
    }
    return this.usersService.resetPassword(actor, {
      userId,
      temporaryPassword: body.temporaryPassword,
      confirmationToken: body.confirmationToken,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post("users/:userId/password-reset-link")
  @HttpCode(HttpStatus.ACCEPTED)
  requestPasswordResetLink(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    return this.recovery.enqueuePrivilegedResetLink(principal(request), userId, input, false);
  }

  @Post("users/:userId/recovery-email")
  @HttpCode(HttpStatus.ACCEPTED)
  requestUserRecoveryEmail(@Param("userId") userId: string, @Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    return this.recovery.setTargetRecoveryEmail(principal(request), userId, input, false);
  }
}
