import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { AuthenticatedRequest, SessionClaims, SessionPrincipal } from "../../contracts/identity";

export type { AuthenticatedRequest, SessionClaims, SessionPrincipal } from "../../contracts/identity";

import { loadApiSecretConfig } from "../../infrastructure/config";
export const cookieName = "goldis_session";
export const csrfCookieName = "goldis_csrf";
export const sessionLifetimeMs = 8 * 60 * 60 * 1000;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function secret(): string {
  const value = loadApiSecretConfig().sessionSecret;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET must have at least 32 characters");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueSession(
  userId: string,
  tenantId: string,
  sessionId: string,
): Readonly<{ sessionToken: string; csrfToken: string }> {
  const csrfToken = randomBytes(32).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      sessionId,
      exp: Date.now() + sessionLifetimeMs,
      userId,
      tenantId,
      csrf: csrfToken,
    }),
  ).toString("base64url");
  return { sessionToken: `${payload}.${sign(payload)}`, csrfToken };
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`));
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
    if (
      !Number.isFinite(data.exp) ||
      (data.exp as number) <= Date.now() ||
      typeof data.userId !== "string" ||
      !uuidPattern.test(data.userId) ||
      typeof data.tenantId !== "string" ||
      !uuidPattern.test(data.tenantId) ||
      typeof data.csrf !== "string" ||
      !/^[A-Za-z0-9_-]{40,}$/.test(data.csrf) ||
      (data.sessionId !== undefined && (typeof data.sessionId !== "string" || !uuidPattern.test(data.sessionId))) ||
      (data.v !== undefined && data.v !== 2) ||
      (data.v === 2 && typeof data.sessionId !== "string")
    )
      return null;
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

export function verifyCsrfRequest(req: Request): boolean {
  const claims = readSessionClaims(req);
  const csrfCookie = cookieValue(req, csrfCookieName);
  const csrfHeader = req.headers["x-csrf-token"];
  return Boolean(
    claims &&
      csrfCookie &&
      typeof csrfHeader === "string" &&
      equalSecret(claims.csrf, csrfCookie) &&
      equalSecret(claims.csrf, csrfHeader),
  );
}

function equalSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function browserLabel(userAgent: string | undefined): string {
  const value = userAgent ?? "";
  const browser = /Edg\//.test(value)
    ? "Edge"
    : /Firefox\//.test(value)
      ? "Firefox"
      : /Chrome\//.test(value)
        ? "Chrome"
        : /Safari\//.test(value)
          ? "Safari"
          : "Przeglądarka";
  const os = /Windows/.test(value)
    ? "Windows"
    : /Mac OS/.test(value)
      ? "macOS"
      : /Android/.test(value)
        ? "Android"
        : /iPhone|iPad/.test(value)
          ? "iOS"
          : /Linux/.test(value)
            ? "Linux"
            : "inne";
  return `${browser} · ${os}`.slice(0, 80);
}
