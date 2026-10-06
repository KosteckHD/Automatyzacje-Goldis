import { Body, CanActivate, Controller, ExecutionContext, Get, HttpException, Inject, Injectable, Optional, Post, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards, ForbiddenException, Delete, BadRequestException, Param } from "@nestjs/common";
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { GoldisRole } from "./authorization-policy";
import { verifyPassword } from "./password-hash";
import { LoginRateLimiter } from "./login-rate-limiter";
import { OriginOnly } from "./request-metadata";
import { recordAuditEvent } from "./audit";
import { listToolAccess } from "./tool-access";

const cookieName = "goldis_session";
const csrfCookieName = "goldis_csrf";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SESSION_ROLE_RESOLVER = "GOLDIS_SESSION_ROLE_RESOLVER";
export const SESSION_PASSWORD_CHANGE_RESOLVER = "GOLDIS_SESSION_PASSWORD_CHANGE_RESOLVER";
export type SessionClaims = Readonly<{
  exp: number;
  csrf: string;
  userId: string;
  tenantId: string;
  /** Compatibility for audit writers; always derived from userId, never accepted from the cookie. */
  actorRef: string;
  sessionId?: string;
  version?: 2;
}>;
export type SessionPrincipal = SessionClaims & Readonly<{ role: GoldisRole }>;
export type SessionRoleResolver = (userId: string, tenantId: string, sessionId?: string) => Promise<GoldisRole | null>;

type AuthenticatedRequest = Request & { goldisPrincipal?: SessionPrincipal };

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET must have at least 32 characters");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function issueSession(userId: string, tenantId: string, sessionId: string): Readonly<{ sessionToken: string; csrfToken: string }> {
  const csrfToken = randomBytes(32).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    v: 2, sessionId, exp: Date.now() + sessionLifetimeMs, userId, tenantId, csrf: csrfToken,
  })).toString("base64url");
  return { sessionToken: `${payload}.${sign(payload)}`, csrfToken };
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.cookie?.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : null;
}

export function readSessionClaims(req: Request): SessionClaims | null {
  const token = cookieValue(req, cookieName);
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(payload));
  } catch {
    return null;
  }
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!Number.isFinite(data.exp) || (data.exp as number) <= Date.now()
      || typeof data.userId !== "string" || !uuidPattern.test(data.userId)
      || typeof data.tenantId !== "string" || !uuidPattern.test(data.tenantId)
      || typeof data.csrf !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(data.csrf)
      || (data.sessionId !== undefined && (typeof data.sessionId !== "string" || !uuidPattern.test(data.sessionId)))
      || (data.v !== undefined && data.v !== 2)
      || (data.v === 2 && typeof data.sessionId !== "string")) return null;
    return {
      exp: data.exp as number,
      csrf: data.csrf,
      userId: data.userId,
      tenantId: data.tenantId,
      actorRef: data.userId,
      ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId, version: 2 as const } : {}),
    };
  } catch {
    return null;
  }
}

export function readSessionPrincipal(req: Request): SessionPrincipal | null {
  return (req as AuthenticatedRequest).goldisPrincipal ?? null;
}

export async function resolveActiveSessionRole(userId: string, tenantId: string): Promise<GoldisRole | null> {
  const { User, TenantMembership } = await import("./db");
  const membership = await TenantMembership.findOne({
    where: { userId, tenantId, status: "active" },
    include: [{ model: User, required: true, where: { status: "active" }, attributes: ["userId"] }],
    attributes: ["role"],
  });
  const role = membership?.role;
  return role === "admin" || role === "operator" || role === "reviewer" || role === "auditor" ? role : null;
}

export type SessionPasswordChangeResolver = (userId: string) => Promise<boolean>;

export async function resolveMustChangePassword(userId: string): Promise<boolean> {
  const { User } = await import("./db");
  const user = await User.findByPk(userId, { attributes: ["mustChangePassword"] });
  return Boolean(user?.mustChangePassword);
}

export async function resolveCurrentSessionRole(userId: string, tenantId: string, sessionId?: string): Promise<GoldisRole | null> {
  if (!sessionId || !uuidPattern.test(sessionId)) return null;
  const { UserSession } = await import("./db");
  const session = await UserSession.findOne({
    where: { sessionId, userId, tenantId, revokedAt: null },
    attributes: ["sessionId", "expiresAt", "lastSeenAt"],
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  const role = await resolveActiveSessionRole(userId, tenantId);
  if (!role) return null;
  if (Date.now() - session.lastSeenAt.getTime() >= 60_000) {
    await session.update({ lastSeenAt: new Date() }, { fields: ["lastSeenAt"] });
  }
  return role;
}

export function verifyCsrfRequest(req: Request): boolean {
  const claims = readSessionClaims(req);
  const csrfCookie = cookieValue(req, csrfCookieName);
  const csrfHeader = req.headers["x-csrf-token"];
  return Boolean(claims && csrfCookie && typeof csrfHeader === "string"
    && equalSecret(claims.csrf, csrfCookie) && equalSecret(claims.csrf, csrfHeader));
}

function equalSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function browserLabel(userAgent: string | undefined): string {
  const value = userAgent ?? "";
  const browser = /Edg\//.test(value) ? "Edge" : /Firefox\//.test(value) ? "Firefox" : /Chrome\//.test(value) ? "Chrome" : /Safari\//.test(value) ? "Safari" : "Przeglądarka";
  const os = /Windows/.test(value) ? "Windows" : /Mac OS/.test(value) ? "macOS" : /Android/.test(value) ? "Android" : /iPhone|iPad/.test(value) ? "iOS" : /Linux/.test(value) ? "Linux" : "inne";
  return `${browser} · ${os}`.slice(0, 80);
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Optional() @Inject(SESSION_ROLE_RESOLVER) private readonly roleResolver?: SessionRoleResolver,
    @Optional() @Inject(SESSION_PASSWORD_CHANGE_RESOLVER) private readonly passwordChangeResolver?: SessionPasswordChangeResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const claims = readSessionClaims(request);
    if (!claims) throw new UnauthorizedException();
    let role: GoldisRole | null;
    try {
      role = await (this.roleResolver ?? resolveCurrentSessionRole)(claims.userId, claims.tenantId, claims.sessionId);
    } catch {
      throw new ServiceUnavailableException();
    }
    if (!role) throw new UnauthorizedException();
    const path = request.path ?? "";
    if (!path.endsWith("/auth/me") && !path.endsWith("/auth/change-password")
      && !path.endsWith("/auth/logout") && !path.endsWith("/auth/sessions")
      && !path.match(/\/auth\/sessions\/[^/]+$/)) {
      try {
        if (await (this.passwordChangeResolver ?? resolveMustChangePassword)(claims.userId)) {
          throw new ForbiddenException("PASSWORD_CHANGE_REQUIRED");
        }
      } catch (error) {
        if (error instanceof UnauthorizedException || error instanceof ForbiddenException) throw error;
        throw new ServiceUnavailableException();
      }
    }
    request.goldisPrincipal = { ...claims, role };
    return true;
  }
}

@Controller("auth")
export class AuthController {
  constructor(private readonly loginRateLimiter: LoginRateLimiter) {}

  @Post("login")
  async login(
    @Body() body: { username?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (typeof body?.username !== "string" || typeof body?.password !== "string"
      || body.username.length > 128 || body.password.length > 1024) {
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
    const usernameNormalized = username.toLowerCase();
    const { Tenant, TenantMembership, User, UserSession, sequelize } = await import("./db");
    const user = await User.findOne({ where: { usernameNormalized, status: "active" } });
    if (!user || !await verifyPassword(body.password, user.passwordHash)) {
      throw new UnauthorizedException("Nieprawidłowy login lub hasło");
    }
    const tenant = await Tenant.findOne({ where: { slug: "goldis" } });
    if (!tenant) throw new UnauthorizedException("Nieprawidłowy login lub hasło");
    const membership = await TenantMembership.findOne({
      where: { userId: user.userId, tenantId: tenant.tenantId, status: "active" },
      attributes: ["role"],
    });
    if (!membership || !["admin", "operator", "reviewer", "auditor"].includes(membership.role)) {
      throw new UnauthorizedException("Nieprawidłowy login lub hasło");
    }

    await this.loginRateLimiter.clearPair(username, clientIp);
    const sessionId = randomUUID();
    const now = new Date();
    await sequelize.transaction(async (transaction) => {
      user.lastLoginAt = now;
      await user.save({ fields: ["lastLoginAt"], transaction });
      await UserSession.create({
        sessionId, tenantId: tenant.tenantId, userId: user.userId, createdAt: now, lastSeenAt: now,
        expiresAt: new Date(now.getTime() + sessionLifetimeMs), revokedAt: null, revokedBy: null, revokeReason: null,
        ipHash: null, browserLabel: browserLabel(req.headers["user-agent"]),
      }, { transaction });
      await recordAuditEvent({
        tenantId: tenant.tenantId, actorUserId: user.userId, action: "login.succeeded",
        resourceType: "session", resourceId: sessionId, outcome: "succeeded", metadata: { role: membership.role },
      }, transaction);
    });
    const { sessionToken, csrfToken } = issueSession(user.userId, tenant.tenantId, sessionId);
    const cookieOptions = { secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/", maxAge: sessionLifetimeMs };
    res.cookie(cookieName, sessionToken, { ...cookieOptions, httpOnly: true });
    res.cookie(csrfCookieName, csrfToken, { ...cookieOptions, httpOnly: false });
    return { role: membership.role, csrfToken, mustChangePassword: Boolean(user.mustChangePassword) };
  }

  @Post("logout")
  @OriginOnly()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const claims = readSessionClaims(req);
    const sessionId = claims?.sessionId;
    if (claims && sessionId) {
      const { UserSession, sequelize } = await import("./db");
      const now = new Date();
      await sequelize.transaction(async (transaction) => {
        const [count] = await UserSession.update({ revokedAt: now, revokeReason: "logout" }, {
          where: { sessionId, userId: claims.userId, tenantId: claims.tenantId, revokedAt: null }, transaction,
        });
        if (count) await recordAuditEvent({
          tenantId: claims.tenantId, actorUserId: claims.userId, action: "logout.succeeded",
          resourceType: "session", resourceId: sessionId, outcome: "succeeded",
        }, transaction);
      });
    }
    res.clearCookie(cookieName, { path: "/" });
    res.clearCookie(csrfCookieName, { path: "/" });
    return { ok: true };
  }

  @Get("me")
  @UseGuards(SessionGuard)
  async me(@Req() req: Request) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new UnauthorizedException();
    const { User } = await import("./db");
    const user = await User.findByPk(principal.userId, { attributes: ["username", "mustChangePassword"] });
    if (!user) throw new UnauthorizedException();
    return {
      role: principal.role, csrfToken: principal.csrf, username: user.username,
      mustChangePassword: user.mustChangePassword, tools: await listToolAccess(principal),
    };
  }

  @Post("change-password")
  @UseGuards(SessionGuard)
  async changePassword(@Body() body: { currentPassword?: string; newPassword?: string }, @Req() req: Request,
    @Res({ passthrough: true }) res: Response) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    if (typeof body?.currentPassword !== "string" || typeof body?.newPassword !== "string"
      || body.newPassword.length < 14 || body.newPassword.length > 1024) throw new BadRequestException("Nowe hasło musi mieć co najmniej 14 znaków");
    const actor = readSessionPrincipal(req);
    if (!actor) throw new UnauthorizedException();
    const { User, UserSession, sequelize } = await import("./db");
    const user = await User.findByPk(actor.userId);
    if (!user || !await verifyPassword(body.currentPassword, user.passwordHash)) throw new UnauthorizedException("Nieprawidłowe obecne hasło");
    const passwordHash = await (await import("./password-hash")).hashPassword(body.newPassword);
    const now = new Date();
    const nextSessionId = randomUUID();
    const { sessionToken, csrfToken } = issueSession(actor.userId, actor.tenantId, nextSessionId);
    await sequelize.transaction(async (transaction) => {
      user.passwordHash = passwordHash; user.mustChangePassword = false; user.updatedAt = now;
      await user.save({ transaction, fields: ["passwordHash", "mustChangePassword", "updatedAt"] });
      const [revokedSessions] = await UserSession.update({ revokedAt: now, revokedBy: actor.userId, revokeReason: "password_change" }, {
        where: { userId: actor.userId, tenantId: actor.tenantId, revokedAt: null }, transaction,
      });
      if (revokedSessions) await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "session.revoked",
        resourceType: "user", resourceId: actor.userId, outcome: "succeeded", metadata: { count: revokedSessions, reason: "password_change" },
      }, transaction);
      await UserSession.create({
        sessionId: nextSessionId, tenantId: actor.tenantId, userId: actor.userId, createdAt: now, lastSeenAt: now,
        expiresAt: new Date(now.getTime() + sessionLifetimeMs), revokedAt: null, revokedBy: null, revokeReason: null,
        ipHash: null, browserLabel: browserLabel(req.headers["user-agent"]),
      }, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "password.changed",
        resourceType: "user", resourceId: actor.userId, outcome: "succeeded",
      }, transaction);
    });
    const cookieOptions = { secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/", maxAge: sessionLifetimeMs };
    res.cookie(cookieName, sessionToken, { ...cookieOptions, httpOnly: true });
    res.cookie(csrfCookieName, csrfToken, { ...cookieOptions, httpOnly: false });
    return { csrfToken, mustChangePassword: false };
  }

  @Get("sessions")
  @UseGuards(SessionGuard)
  async sessions(@Req() req: Request) {
    const actor = readSessionPrincipal(req);
    if (!actor) throw new UnauthorizedException();
    const { UserSession } = await import("./db");
    const items = await UserSession.findAll({
      where: { userId: actor.userId, tenantId: actor.tenantId }, attributes: ["sessionId", "createdAt", "lastSeenAt", "expiresAt", "revokedAt", "browserLabel"],
      order: [["createdAt", "DESC"]], limit: 100,
    });
    return { items: items.map((item) => ({ ...item.toJSON(), isCurrent: item.sessionId === actor.sessionId })) };
  }

  @Delete("sessions/:sessionId")
  @UseGuards(SessionGuard)
  async revokeSession(@Param("sessionId") sessionId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(req);
    if (!actor) throw new UnauthorizedException();
    if (!uuidPattern.test(sessionId)) throw new BadRequestException("Nieprawidłowa sesja");
    const { UserSession, sequelize } = await import("./db");
    const now = new Date();
    await sequelize.transaction(async (transaction) => {
      const [count] = await UserSession.update({ revokedAt: now, revokedBy: actor.userId, revokeReason: "admin" }, {
        where: { sessionId, tenantId: actor.tenantId, userId: actor.userId, revokedAt: null }, transaction,
      });
      if (!count) throw new UnauthorizedException("Sesja wygasła lub została cofnięta");
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.userId, action: "session.revoked",
        resourceType: "session", resourceId: sessionId, outcome: "succeeded",
      }, transaction);
    });
    if (sessionId === actor.sessionId) {
      res.clearCookie(cookieName, { path: "/" });
      res.clearCookie(csrfCookieName, { path: "/" });
    }
    return { revoked: true, currentSession: sessionId === actor.sessionId };
  }
}
