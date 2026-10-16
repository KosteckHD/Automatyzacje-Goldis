import type { GoldisRole } from "../../contracts/identity";

export const IDENTITY_SESSION_REPOSITORY = Symbol.for("goldis.identity.session-repository");

export type IdentitySessionSummary = Readonly<{
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  browserLabel: string | null;
}>;

export type IdentityCurrentAccount = Readonly<{
  username: string;
  mustChangePassword: boolean;
  canDeleteData: boolean;
}>;

/** Minimal persistence contract consumed by authentication/session use cases. */
export interface IdentitySessionRepository {
  findActiveMembershipRole(userId: string, tenantId: string): Promise<GoldisRole | null>;
  findPasswordChangeRequired(userId: string): Promise<boolean>;
  findCurrentAccount(userId: string, tenantId: string): Promise<IdentityCurrentAccount | null>;
  resolveCurrentSessionRole(
    userId: string,
    tenantId: string,
    sessionId?: string,
    userActivity?: boolean,
  ): Promise<GoldisRole | null>;
  logoutSession(input: Readonly<{ userId: string; tenantId: string; sessionId: string; now: Date }>): Promise<boolean>;
  listUserSessions(userId: string, tenantId: string): Promise<IdentitySessionSummary[]>;
  revokeOwnedSession(
    input: Readonly<{
      userId: string;
      tenantId: string;
      sessionId: string;
      now: Date;
    }>,
  ): Promise<boolean>;
}
