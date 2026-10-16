import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { LoginRateLimiter, readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth";
import type { DeletionStepUpRequestDto, DeletionStepUpResponseDto } from "./deletion-step-up.dto";
import { DeletionStepUpService } from "./deletion-step-up.service";

const previewUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keeps the historical /auth/deletion-step-up HTTP contract at the deletion feature boundary. */
@Controller("auth")
export class DeletionStepUpController {
  constructor(
    @Inject(LoginRateLimiter) private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(DeletionStepUpService) private readonly service: DeletionStepUpService,
  ) {}

  @Post("deletion-step-up")
  @UseGuards(SessionGuard)
  async requestStepUp(
    @Body() body: DeletionStepUpRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeletionStepUpResponseDto> {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(req);
    if (!actor?.sessionId) throw new UnauthorizedException();
    const previewId = this.parseRequest(body);
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const attempt = await this.loginRateLimiter.consumeReauthAttempt(actor.userId, actor.sessionId, clientIp);
    if (!attempt.allowed) {
      res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      throw new HttpException(
        "Za dużo prób ponownego uwierzytelnienia. Spróbuj ponownie później.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const result = await this.service.request({ actor, previewId, currentPassword: body.currentPassword as string });
      await this.loginRateLimiter.clearReauth(actor.userId, actor.sessionId, attempt);
      return result;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.loginRateLimiter.recordReauthFailure(actor.userId, attempt);
      } else {
        await this.loginRateLimiter.clearReauth(actor.userId, actor.sessionId, attempt);
      }
      throw error;
    }
  }

  private parseRequest(body: DeletionStepUpRequestDto): string {
    if (!body || Object.keys(body).some((key) => key !== "currentPassword" && key !== "previewId")) {
      throw new BadRequestException("Nieprawidłowe dane potwierdzenia");
    }
    const previewId =
      typeof body.previewId === "string" && previewUuidPattern.test(body.previewId)
        ? body.previewId.toLowerCase()
        : null;
    if (
      !previewId ||
      typeof body.currentPassword !== "string" ||
      body.currentPassword.length > 1024 ||
      Buffer.byteLength(body.currentPassword, "utf8") > 4096
    ) {
      throw new BadRequestException("Wymagane jest hasło i identyfikator podglądu usuwania");
    }
    return previewId;
  }
}
