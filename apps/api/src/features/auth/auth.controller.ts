import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { loadApiRuntimeConfig } from "../../infrastructure/config";
import { OriginOnly } from "../../infrastructure/http/public";
import { AuthService } from "./auth.service";
import { LoginRateLimiter } from "./login-rate-limiter";
import { passwordPolicyFailure } from "./password-policy";
import { SessionGuard } from "./session.guard";
import { SessionService } from "./session.service";
import {
  cookieName,
  csrfCookieName,
  issueSession,
  readSessionClaims,
  readSessionPrincipal,
  sessionLifetimeMs,
  uuidPattern,
  verifyCsrfRequest,
} from "./session-principal";
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(LoginRateLimiter) private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(SessionService) private readonly sessionService: SessionService,
  ) {}

  @OriginOnly()
  @Post("login")
  async login(
    @Body() body: { username?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (
      typeof body?.username !== "string" ||
      typeof body?.password !== "string" ||
      body.username.length > 128 ||
      body.password.length > 1024
    ) {
      throw new UnauthorizedException("Nieprawidłowy login lub hasło");
    }
    const username = body.username.trim();
    if (!username) throw new UnauthorizedException("Nieprawidłowy login lub hasło");
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const rateLimit = await this.loginRateLimiter.consumeAttempt(username, clientIp);
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      throw new HttpException("Za dużo prób logowania. Spróbuj ponownie później.", 429);
    }
    const auditSampledFailure = async () => {
      try {
        if (!(await this.loginRateLimiter.shouldSampleLoginFailure())) return;
        await this.authService.recordSampledLoginFailure();
      } catch {
        // Anonymous telemetry is best-effort and can never turn a denial into a success.
      }
    };
    let login: Awaited<ReturnType<AuthService["login"]>>;
    try {
      login = await this.authService.login(username, body.password, req.headers["user-agent"]);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.loginRateLimiter.recordFailure(username, rateLimit);
        await auditSampledFailure();
      }
      throw error;
    }
    await this.loginRateLimiter.clearPair(username, clientIp, rateLimit);
    const { sessionToken, csrfToken } = issueSession(login.userId, login.tenantId, login.sessionId);
    const cookieOptions = {
      secure: loadApiRuntimeConfig().nodeEnvironment === "production",
      sameSite: "strict" as const,
      path: "/",
      maxAge: sessionLifetimeMs,
    };
    res.cookie(cookieName, sessionToken, { ...cookieOptions, httpOnly: true });
    res.cookie(csrfCookieName, csrfToken, { ...cookieOptions, httpOnly: false });
    return { role: login.role, csrfToken, mustChangePassword: login.mustChangePassword };
  }

  @Post("logout")
  @OriginOnly()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const claims = readSessionClaims(req);
    const sessionId = claims?.sessionId;
    if (claims && sessionId) await this.sessionService.logout(claims);
    res.clearCookie(cookieName, { path: "/" });
    res.clearCookie(csrfCookieName, { path: "/" });
    return { ok: true };
  }

  @Get("me")
  @UseGuards(SessionGuard)
  async me(@Req() req: Request) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new UnauthorizedException();
    const account = await this.sessionService.currentAccount(principal);
    if (!account) throw new UnauthorizedException();
    return account;
  }

  @Post("change-password")
  @UseGuards(SessionGuard)
  async changePassword(
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    if (
      typeof body?.currentPassword !== "string" ||
      typeof body?.newPassword !== "string" ||
      body.currentPassword.length > 1024 ||
      Buffer.byteLength(body.currentPassword, "utf8") > 4096 ||
      passwordPolicyFailure(body.newPassword)
    ) {
      throw new BadRequestException("Nowe hasło nie spełnia wymagań polityki haseł");
    }
    const actor = readSessionPrincipal(req);
    if (!actor?.sessionId) throw new UnauthorizedException();
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const reauthAttempt = await this.loginRateLimiter.consumeReauthAttempt(actor.userId, actor.sessionId, clientIp);
    if (!reauthAttempt.allowed) {
      res.setHeader("Retry-After", String(reauthAttempt.retryAfterSeconds));
      throw new HttpException("Za dużo prób ponownego uwierzytelnienia. Spróbuj ponownie później.", 429);
    }
    let passwordChange: Awaited<ReturnType<AuthService["changePassword"]>>;
    try {
      passwordChange = await this.authService.changePassword(
        actor,
        body.currentPassword,
        body.newPassword,
        req.headers["user-agent"],
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.loginRateLimiter.recordReauthFailure(actor.userId, reauthAttempt);
      }
      throw error;
    }
    await this.loginRateLimiter.clearReauth(actor.userId, actor.sessionId, reauthAttempt);
    const cookieOptions = {
      secure: loadApiRuntimeConfig().nodeEnvironment === "production",
      sameSite: "strict" as const,
      path: "/",
      maxAge: sessionLifetimeMs,
    };
    res.cookie(cookieName, passwordChange.sessionToken, { ...cookieOptions, httpOnly: true });
    res.cookie(csrfCookieName, passwordChange.csrfToken, { ...cookieOptions, httpOnly: false });
    return { csrfToken: passwordChange.csrfToken, mustChangePassword: false };
  }

  @Get("sessions")
  @UseGuards(SessionGuard)
  async sessions(@Req() req: Request) {
    const actor = readSessionPrincipal(req);
    if (!actor) throw new UnauthorizedException();
    return this.sessionService.listSessions(actor.userId, actor.tenantId, actor.sessionId);
  }

  @Delete("sessions/:sessionId")
  @UseGuards(SessionGuard)
  async revokeSession(
    @Param("sessionId") sessionId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(req);
    if (!actor) throw new UnauthorizedException();
    if (!uuidPattern.test(sessionId)) throw new BadRequestException("Nieprawidłowa sesja");
    const revoked = await this.sessionService.revokeSession({
      userId: actor.userId,
      tenantId: actor.tenantId,
      sessionId,
    });
    if (!revoked) throw new UnauthorizedException("Sesja wygasła lub została cofnięta");
    if (sessionId === actor.sessionId) {
      res.clearCookie(cookieName, { path: "/" });
      res.clearCookie(csrfCookieName, { path: "/" });
    }
    return { revoked: true, currentSession: sessionId === actor.sessionId };
  }
}
