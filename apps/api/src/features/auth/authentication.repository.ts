import { ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { sequelize, Tenant, TenantMembership, User, UserSession } from "../../infrastructure/database/db";
import { AuditService } from "../audit/public";
import { applyPasswordChange } from "./password-change";

type LoginSessionInput = Readonly<{
  userId: string;
  tenantId: string;
  expectedPasswordHash: string;
  expectedCredentialRevision: number;
  upgradedPasswordHash: string | null;
  sessionId: string;
  now: Date;
  expiresAt: Date;
  browserLabel: string;
}>;

/** Authentication persistence, including the credential and membership recheck at commit time. */
@Injectable()
export class AuthenticationRepository {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  findLoginUser(usernameNormalized: string) {
    return User.findOne({ where: { usernameNormalized } });
  }

  findGoldisTenant() {
    return Tenant.findOne({ where: { slug: "goldis" } });
  }

  findPasswordUser(userId: string) {
    return User.findByPk(userId);
  }

  async recordSampledLoginFailure(tenantId?: string): Promise<void> {
    const resolvedTenantId = tenantId ?? (await Tenant.findOne({ where: { slug: "goldis" } }))?.tenantId;
    if (!resolvedTenantId) return;
    await this.audit.record({
      tenantId: resolvedTenantId,
      actorUserId: null,
      action: "login.failed",
      resourceType: "user",
      resourceId: null,
      outcome: "denied",
      metadata: { stage: "credential_check" },
    });
  }

  async persistLoginSession(input: LoginSessionInput): Promise<{ role: string; mustChangePassword: boolean }> {
    let role: string | null = null;
    let mustChangePassword = false;
    await sequelize.transaction(async (transaction) => {
      await lockUsersInTransaction([input.userId], transaction);
      const currentUser = await User.findByPk(input.userId, { transaction, lock: transaction.LOCK.UPDATE });
      if (
        currentUser?.status !== "active" ||
        currentUser.passwordHash !== input.expectedPasswordHash ||
        currentUser.credentialRevision !== input.expectedCredentialRevision
      ) {
        throw new UnauthorizedException("Nieprawidłowy login lub hasło");
      }
      const membership = await TenantMembership.findOne({
        where: { userId: currentUser.userId, tenantId: input.tenantId, status: "active" },
        attributes: ["role"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!membership || !["admin", "manager", "operator", "reviewer", "auditor"].includes(membership.role)) {
        throw new UnauthorizedException("Nieprawidłowy login lub hasło");
      }
      role = membership.role;
      mustChangePassword = Boolean(currentUser.mustChangePassword);
      currentUser.lastLoginAt = input.now;
      if (input.upgradedPasswordHash) currentUser.passwordHash = input.upgradedPasswordHash;
      await currentUser.save({
        fields: input.upgradedPasswordHash ? ["lastLoginAt", "passwordHash"] : ["lastLoginAt"],
        transaction,
      });
      await UserSession.create(
        {
          sessionId: input.sessionId,
          tenantId: input.tenantId,
          userId: currentUser.userId,
          credentialRevision: currentUser.credentialRevision,
          createdAt: input.now,
          lastSeenAt: input.now,
          lastActivityAt: input.now,
          expiresAt: input.expiresAt,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          ipHash: null,
          browserLabel: input.browserLabel,
        },
        { transaction },
      );
      await this.audit.record(
        {
          tenantId: input.tenantId,
          actorUserId: currentUser.userId,
          action: "login.succeeded",
          resourceType: "session",
          resourceId: input.sessionId,
          outcome: "succeeded",
          metadata: { role: membership.role },
        },
        transaction,
      );
    });
    if (!role) throw new UnauthorizedException("Nieprawidłowy login lub hasło");
    return { role, mustChangePassword };
  }

  async persistPasswordChange(
    input: Readonly<{
      userId: string;
      tenantId: string;
      currentSessionId: string;
      expectedPasswordHash: string;
      expectedCredentialRevision: number;
      passwordHash: string;
      nextSessionId: string;
      now: Date;
      expiresAt: Date;
      browserLabel: string;
    }>,
  ): Promise<void> {
    await sequelize.transaction(async (transaction) => {
      await lockUsersInTransaction([input.userId], transaction);
      const currentUser = await User.findByPk(input.userId, { transaction, lock: transaction.LOCK.UPDATE });
      const membership = await TenantMembership.findOne({
        where: { tenantId: input.tenantId, userId: input.userId, status: "active" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const currentSession = await UserSession.findOne({
        where: {
          sessionId: input.currentSessionId,
          tenantId: input.tenantId,
          userId: input.userId,
          revokedAt: null,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        currentUser?.status !== "active" ||
        !membership ||
        !currentSession ||
        currentSession.expiresAt.getTime() <= input.now.getTime() ||
        currentSession.credentialRevision !== currentUser.credentialRevision ||
        currentUser.passwordHash !== input.expectedPasswordHash ||
        currentUser.credentialRevision !== input.expectedCredentialRevision
      ) {
        throw new ConflictException("Poświadczenia lub sesja zmieniły się; zaloguj się ponownie");
      }
      const passwordChange = await applyPasswordChange({
        user: currentUser,
        tenantId: input.tenantId,
        actorUserId: input.userId,
        passwordHash: input.passwordHash,
        mustChangePassword: false,
        reason: "self_service",
        transaction,
        audit: this.audit,
      });
      await UserSession.create(
        {
          sessionId: input.nextSessionId,
          tenantId: input.tenantId,
          userId: input.userId,
          credentialRevision: passwordChange.credentialRevision,
          createdAt: input.now,
          lastSeenAt: input.now,
          lastActivityAt: input.now,
          expiresAt: input.expiresAt,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          ipHash: null,
          browserLabel: input.browserLabel,
        },
        { transaction },
      );
    });
  }
}
