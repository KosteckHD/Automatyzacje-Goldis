import { Inject, Injectable } from "@nestjs/common";
import type { GoldisRole } from "../../contracts/identity";
import { listToolAccess } from "../authorization/public";
import {
  hasRecentUserActivitySignal,
  IDENTITY_SESSION_REPOSITORY,
  type IdentitySessionRepository,
  type IdentitySessionSummary,
  isIdleSessionExpired,
  isSupportedGoldisRole,
} from "../identity";
import type { SessionPrincipal } from "./session-principal";

export type SessionRoleResolver = (
  userId: string,
  tenantId: string,
  sessionId?: string,
  userActivity?: boolean,
) => Promise<GoldisRole | null>;
export type SessionPasswordChangeResolver = (userId: string) => Promise<boolean>;

/** Auth use cases consume identity and session persistence through its feature repository. */
@Injectable()
export class SessionService {
  constructor(@Inject(IDENTITY_SESSION_REPOSITORY) private readonly identity: IdentitySessionRepository) {}

  resolveActiveSessionRole(userId: string, tenantId: string): Promise<GoldisRole | null> {
    return this.identity.findActiveMembershipRole(userId, tenantId);
  }

  resolveMustChangePassword(userId: string): Promise<boolean> {
    return this.identity.findPasswordChangeRequired(userId);
  }

  resolveCurrentSessionRole: SessionRoleResolver = (userId, tenantId, sessionId, userActivity) =>
    this.identity.resolveCurrentSessionRole(userId, tenantId, sessionId, userActivity);

  async currentAccount(principal: SessionPrincipal) {
    const account = await this.identity.findCurrentAccount(principal.userId, principal.tenantId);
    if (!account) return null;
    return {
      role: principal.role,
      csrfToken: principal.csrf,
      username: account.username,
      userId: principal.userId,
      tenantId: principal.tenantId,
      mustChangePassword: account.mustChangePassword,
      canDeleteData: principal.role === "admin" || (principal.role === "manager" && account.canDeleteData),
      tools: await listToolAccess(principal),
    };
  }

  async logout(claims: Readonly<{ userId: string; tenantId: string; sessionId?: string }>): Promise<void> {
    if (!claims.sessionId) return;
    await this.identity.logoutSession({
      userId: claims.userId,
      tenantId: claims.tenantId,
      sessionId: claims.sessionId,
      now: new Date(),
    });
  }

  async listSessions(userId: string, tenantId: string, currentSessionId?: string) {
    const items: IdentitySessionSummary[] = await this.identity.listUserSessions(userId, tenantId);
    return { items: items.map((item) => ({ ...item, isCurrent: item.sessionId === currentSessionId })) };
  }

  revokeSession(input: Readonly<{ userId: string; tenantId: string; sessionId: string }>): Promise<boolean> {
    return this.identity.revokeOwnedSession({ ...input, now: new Date() });
  }
}

export { hasRecentUserActivitySignal, isIdleSessionExpired, isSupportedGoldisRole };
