import { Inject, Injectable } from "@nestjs/common";
import { Op, QueryTypes } from "sequelize";
import type { GoldisRole } from "../../contracts/identity";
import { sequelize, TenantMembership, User, UserSession } from "../../infrastructure/database/db";
import { AuditService } from "../audit/public";
import type { IdentityCurrentAccount, IdentitySessionRepository, IdentitySessionSummary } from "./identity.tokens";
import {
  isIdleSessionExpired,
  isSupportedGoldisRole,
  SESSION_ACTIVITY_TOUCH_INTERVAL_MS,
  SESSION_IDLE_LIFETIME_MS,
} from "./identity-session-policy";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Database access for accounts, tenant memberships and persistent sessions. */
@Injectable()
export class IdentityRepository implements IdentitySessionRepository {
  constructor(@Inject(AuditService) private readonly audit: Pick<AuditService, "record">) {}

  async findCurrentAccount(userId: string, tenantId: string): Promise<IdentityCurrentAccount | null> {
    const user = await User.findByPk(userId, { attributes: ["username", "mustChangePassword"] });
    if (!user) return null;
    const memberships = await sequelize.query<{ canDeleteData: boolean }>(
      `SELECT can_delete_data AS "canDeleteData" FROM tenant_memberships
        WHERE tenant_id = :tenantId AND user_id = :userId AND status = 'active'`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
    );
    return {
      username: user.username,
      mustChangePassword: user.mustChangePassword,
      canDeleteData: memberships[0]?.canDeleteData === true,
    };
  }

  async logoutSession(input: { userId: string; tenantId: string; sessionId: string; now: Date }): Promise<boolean> {
    return sequelize.transaction(async (transaction) => {
      const [count] = await UserSession.update(
        { revokedAt: input.now, revokeReason: "logout" },
        {
          where: {
            sessionId: input.sessionId,
            userId: input.userId,
            tenantId: input.tenantId,
            revokedAt: null,
          },
          transaction,
        },
      );
      if (count) {
        await this.audit.record(
          {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: "logout.succeeded",
            resourceType: "session",
            resourceId: input.sessionId,
            outcome: "succeeded",
          },
          transaction,
        );
      }
      return count > 0;
    });
  }

  async listUserSessions(userId: string, tenantId: string): Promise<IdentitySessionSummary[]> {
    const items = await UserSession.findAll({
      where: { userId, tenantId },
      attributes: ["sessionId", "createdAt", "lastSeenAt", "expiresAt", "revokedAt", "browserLabel"],
      order: [["createdAt", "DESC"]],
      limit: 100,
    });
    return items.map((item) => item.toJSON() as IdentitySessionSummary);
  }

  async revokeOwnedSession(input: {
    userId: string;
    tenantId: string;
    sessionId: string;
    now: Date;
  }): Promise<boolean> {
    return sequelize.transaction(async (transaction) => {
      const [count] = await UserSession.update(
        { revokedAt: input.now, revokedBy: input.userId, revokeReason: "admin" },
        {
          where: {
            sessionId: input.sessionId,
            tenantId: input.tenantId,
            userId: input.userId,
            revokedAt: null,
          },
          transaction,
        },
      );
      if (!count) return false;
      await this.audit.record(
        {
          tenantId: input.tenantId,
          actorUserId: input.userId,
          action: "session.revoked",
          resourceType: "session",
          resourceId: input.sessionId,
          outcome: "succeeded",
        },
        transaction,
      );
      return true;
    });
  }

  async findActiveMembershipRole(userId: string, tenantId: string): Promise<GoldisRole | null> {
    const membership = await TenantMembership.findOne({
      where: { userId, tenantId, status: "active" },
      include: [{ model: User, required: true, where: { status: "active" }, attributes: ["userId"] }],
      attributes: ["role"],
    });
    return isSupportedGoldisRole(membership?.role) ? membership.role : null;
  }

  async findPasswordChangeRequired(userId: string): Promise<boolean> {
    const user = await User.findByPk(userId, { attributes: ["mustChangePassword"] });
    return Boolean(user?.mustChangePassword);
  }

  async resolveCurrentSessionRole(
    userId: string,
    tenantId: string,
    sessionId?: string,
    userActivity = false,
  ): Promise<GoldisRole | null> {
    if (!sessionId || !uuidPattern.test(sessionId)) return null;
    const now = new Date();
    let session = await UserSession.findOne({
      where: { sessionId, userId, tenantId, revokedAt: null },
      attributes: ["sessionId", "expiresAt", "lastSeenAt", "lastActivityAt", "credentialRevision"],
    });
    if (!session || session.expiresAt.getTime() <= now.getTime()) return null;
    const idleCutoff = new Date(now.getTime() - SESSION_IDLE_LIFETIME_MS);
    if (isIdleSessionExpired(session.lastActivityAt, now.getTime())) {
      await sequelize.transaction(async (transaction) => {
        const [revoked] = await UserSession.update(
          { revokedAt: now, revokeReason: "idle" },
          {
            where: {
              sessionId,
              userId,
              tenantId,
              revokedAt: null,
              expiresAt: { [Op.gt]: now },
              lastActivityAt: { [Op.lte]: idleCutoff },
            },
            transaction,
          },
        );
        if (revoked)
          await this.audit.record(
            {
              tenantId,
              actorUserId: userId,
              action: "session.revoked",
              resourceType: "session",
              resourceId: sessionId,
              outcome: "succeeded",
              metadata: { reason: "idle" },
            },
            transaction,
          );
      });
      session = await UserSession.findOne({
        where: { sessionId, userId, tenantId, revokedAt: null },
        attributes: ["sessionId", "expiresAt", "lastSeenAt", "lastActivityAt", "credentialRevision"],
      });
      if (
        !session ||
        session.expiresAt.getTime() <= now.getTime() ||
        session.lastActivityAt.getTime() <= idleCutoff.getTime()
      )
        return null;
    }
    if (userActivity && now.getTime() - session.lastActivityAt.getTime() >= SESSION_ACTIVITY_TOUCH_INTERVAL_MS) {
      const [touched] = await UserSession.update(
        { lastActivityAt: now, lastSeenAt: now },
        {
          where: {
            sessionId,
            userId,
            tenantId,
            revokedAt: null,
            expiresAt: { [Op.gt]: now },
            lastActivityAt: { [Op.gt]: idleCutoff },
          },
        },
      );
      if (!touched) return null;
      session.lastActivityAt = now;
      session.lastSeenAt = now;
    } else if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_ACTIVITY_TOUCH_INTERVAL_MS) {
      const [seen] = await UserSession.update(
        { lastSeenAt: now },
        {
          where: { sessionId, userId, tenantId, revokedAt: null, expiresAt: { [Op.gt]: now } },
        },
      );
      if (!seen) return null;
    }
    const user = await User.findByPk(userId, { attributes: ["status", "credentialRevision"] });
    if (user?.status !== "active" || user.credentialRevision !== session.credentialRevision) return null;
    const membership = await TenantMembership.findOne({
      where: { userId, tenantId, status: "active" },
      attributes: ["role"],
    });
    return isSupportedGoldisRole(membership?.role) ? membership.role : null;
  }
}
