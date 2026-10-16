import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { OriginOnly } from "../../infrastructure/http/public";
import { readSessionPrincipal, SessionGuard } from "../auth";
import { clientIp, requireCsrf, strictBody } from "./account-recovery.request";
import { PasswordRecoveryService } from "./account-recovery.service";
import { readAuthMailConfig } from "./auth-mail-config";

@Controller("auth")
export class PasswordRecoveryController {
  constructor(@Inject(PasswordRecoveryService) private readonly recovery: PasswordRecoveryService) {}

  @Get("recovery-status")
  recoveryStatus() {
    return { enabled: readAuthMailConfig().enabled };
  }

  @OriginOnly()
  @HttpCode(HttpStatus.ACCEPTED)
  @Post("forgot-password")
  async forgotPassword(@Body() input: unknown, @Req() request: Request) {
    const body = strictBody(input, ["email"]);
    return this.recovery.requestPasswordReset(body.email, clientIp(request));
  }

  @OriginOnly()
  @HttpCode(HttpStatus.OK)
  @Post("reset-password")
  async resetPassword(@Body() input: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const body = strictBody(input, ["token", "newPassword"]);
    await this.recovery.resetPassword(body.token, body.newPassword, clientIp(request));
    response.clearCookie("goldis_session", { path: "/" });
    response.clearCookie("goldis_csrf", { path: "/" });
    return { ok: true };
  }

  @UseGuards(SessionGuard)
  @Get("recovery-email")
  recoveryEmail(@Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new UnauthorizedException();
    return this.recovery.getRecoveryEmail(actor.userId, actor.tenantId);
  }

  @UseGuards(SessionGuard)
  @Put("recovery-email")
  @HttpCode(HttpStatus.ACCEPTED)
  async setRecoveryEmail(@Body() input: unknown, @Req() request: Request) {
    requireCsrf(request);
    const actor = readSessionPrincipal(request);
    if (!actor?.sessionId) throw new UnauthorizedException();
    const body = strictBody(input, ["email", "currentPassword"]);
    await this.recovery.setRecoveryEmail(
      {
        userId: actor.userId,
        tenantId: actor.tenantId,
        sessionId: actor.sessionId,
        email: body.email,
        currentPassword: body.currentPassword,
      },
      clientIp(request),
    );
    return { status: "pending_verification" };
  }

  @OriginOnly()
  @HttpCode(HttpStatus.OK)
  @Post("verify-recovery-email")
  async verifyRecoveryEmail(@Body() input: unknown, @Req() request: Request) {
    const body = strictBody(input, ["token"]);
    await this.recovery.verifyRecoveryEmail(body.token, clientIp(request));
    return { ok: true };
  }
}
