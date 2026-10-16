import type { Request } from "express";

export type GoldisRole = "admin" | "manager" | "operator" | "reviewer" | "auditor";

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
export type AuthenticatedRequest = Request & { goldisPrincipal?: SessionPrincipal };
