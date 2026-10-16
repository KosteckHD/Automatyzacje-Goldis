import { Inject, Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import { TenantMembership, Tool, ToolGrant, User, UserSession } from "../../infrastructure/database/db";
import type { AdminUserRole } from "./admin-users.dto";

export type AdminUserListRow = Readonly<{
  userId: string;
  username: string;
  status: string;
  role: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  activeSessionCount: number;
  hasVerifiedRecoveryEmail: boolean;
}>;

export type AdminUserGrantMeta = Readonly<{
  role: string;
  canDeleteData: boolean;
  deletionGrantVersion: number;
}>;

export type AdminToolGrantRow = Readonly<{
  toolId: string;
  displayName: string;
  status: string;
  canDiscover: boolean | null;
  canExecute: boolean | null;
  canViewResults: boolean | null;
  canDownloadResults: boolean | null;
  version: number | null;
}>;

export type AdminUserSessionRow = Readonly<{
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  browserLabel: string | null;
}>;

export type AdminDeletionGrantRow = Readonly<{
  role: string;
  status: string;
  canDeleteData: boolean;
  deletionGrantVersion: number;
}>;

@Injectable()
export class AdminUsersRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return this.database.transaction(work);
  }

  findTool(toolId: string, transaction: Transaction) {
    return Tool.findByPk(toolId, { transaction });
  }

  findToolGrantForUpdate(tenantId: string, userId: string, toolId: string, transaction: Transaction) {
    return ToolGrant.findOne({ where: { tenantId, userId, toolId }, transaction, lock: transaction.LOCK.UPDATE });
  }

  async saveToolGrant(input: {
    existing: NonNullable<Awaited<ReturnType<AdminUsersRepository["findToolGrantForUpdate"]>>> | null;
    tenantId: string;
    userId: string;
    toolId: string;
    actorUserId: string;
    canDiscover: boolean;
    canExecute: boolean;
    canViewResults: boolean;
    canDownloadResults: boolean;
    version: number;
    now: Date;
    transaction: Transaction;
  }): Promise<{ version: number }> {
    const grant =
      input.existing ??
      ToolGrant.build({
        tenantId: input.tenantId,
        userId: input.userId,
        toolId: input.toolId,
        grantedBy: input.actorUserId,
        createdAt: input.now,
        version: 0,
      });
    Object.assign(grant, {
      canDiscover: input.canDiscover,
      canExecute: input.canExecute,
      canViewResults: input.canViewResults,
      canDownloadResults: input.canDownloadResults,
      grantedBy: input.actorUserId,
      updatedAt: input.now,
      version: input.version,
    });
    await grant.save({ transaction: input.transaction });
    return { version: grant.version };
  }

  async deleteToolGrant(tenantId: string, userId: string, toolId: string, transaction: Transaction): Promise<void> {
    await ToolGrant.destroy({ where: { tenantId, userId, toolId }, transaction });
  }

  async findDeletionGrantForUpdate(
    tenantId: string,
    userId: string,
    transaction: Transaction,
  ): Promise<AdminDeletionGrantRow | null> {
    const rows = await this.database.query<AdminDeletionGrantRow>(
      `SELECT role, status, can_delete_data AS "canDeleteData", deletion_grant_version AS "deletionGrantVersion"
         FROM tenant_memberships WHERE tenant_id = :tenantId AND user_id = :userId FOR UPDATE`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT, transaction },
    );
    return rows[0] ?? null;
  }

  async updateDeletionGrant(
    tenantId: string,
    userId: string,
    canDeleteData: boolean,
    version: number,
    now: Date,
    transaction: Transaction,
  ): Promise<void> {
    await this.database.query(
      `UPDATE tenant_memberships SET can_delete_data = :canDeleteData, deletion_grant_version = :version, updated_at = :now
         WHERE tenant_id = :tenantId AND user_id = :userId`,
      { replacements: { canDeleteData, version, now, tenantId, userId }, transaction },
    );
  }

  findMembershipForUpdate(tenantId: string, userId: string, transaction: Transaction) {
    return TenantMembership.findOne({
      where: { tenantId, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findUserForUpdate(userId: string, transaction: Transaction) {
    return User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  countOtherActiveAdmins(tenantId: string, exceptUserId: string, transaction: Transaction) {
    return TenantMembership.count({
      where: { tenantId, role: "admin", status: "active", userId: { [Op.ne]: exceptUserId } },
      transaction,
    });
  }

  async saveMembershipStatus(
    member: NonNullable<Awaited<ReturnType<AdminUsersRepository["findMembershipForUpdate"]>>>,
    status: "active" | "disabled",
    now: Date,
    transaction: Transaction,
  ): Promise<void> {
    member.status = status;
    member.updatedAt = now;
    await member.save({ transaction });
  }

  async saveUserStatus(
    user: NonNullable<Awaited<ReturnType<AdminUsersRepository["findUserForUpdate"]>>>,
    status: "active" | "disabled",
    now: Date,
    transaction: Transaction,
  ): Promise<void> {
    user.status = status;
    user.updatedAt = now;
    await user.save({ transaction, fields: ["status", "updatedAt"] });
  }

  async saveMembershipRole(
    member: NonNullable<Awaited<ReturnType<AdminUsersRepository["findMembershipForUpdate"]>>>,
    role: AdminUserRole,
    now: Date,
    transaction: Transaction,
  ): Promise<void> {
    member.role = role;
    member.updatedAt = now;
    await member.save({ transaction });
  }

  async revokeAccountSessions(
    userId: string,
    actorUserId: string,
    now: Date,
    transaction: Transaction,
  ): Promise<number> {
    const [count] = await UserSession.update(
      { revokedAt: now, revokedBy: actorUserId, revokeReason: "account_change" },
      { where: { userId, revokedAt: null }, transaction },
    );
    return count;
  }

  async revokeTenantSessions(
    tenantId: string,
    userId: string,
    actorUserId: string,
    now: Date,
    transaction: Transaction,
  ): Promise<number> {
    const [count] = await UserSession.update(
      { revokedAt: now, revokedBy: actorUserId, revokeReason: "account_change" },
      { where: { tenantId, userId, revokedAt: null }, transaction },
    );
    return count;
  }

  findMembership(tenantId: string, userId: string, transaction: Transaction, lock = false) {
    return TenantMembership.findOne({
      where: { tenantId, userId },
      attributes: ["userId"],
      transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  async revokeSession(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    actorUserId: string;
    now: Date;
    transaction: Transaction;
  }): Promise<number> {
    const [count] = await UserSession.update(
      { revokedAt: input.now, revokedBy: input.actorUserId, revokeReason: "admin" },
      {
        where: {
          tenantId: input.tenantId,
          userId: input.userId,
          sessionId: input.sessionId,
          revokedAt: null,
        },
        transaction: input.transaction,
      },
    );
    return count;
  }

  async revokeActiveSessions(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
    now: Date;
    transaction: Transaction;
  }): Promise<number> {
    const [count] = await UserSession.update(
      { revokedAt: input.now, revokedBy: input.actorUserId, revokeReason: "admin" },
      {
        where: {
          tenantId: input.tenantId,
          userId: input.userId,
          revokedAt: null,
          expiresAt: { [Op.gt]: input.now },
        },
        transaction: input.transaction,
      },
    );
    return count;
  }

  async createUser(input: {
    userId: string;
    tenantId: string;
    username: string;
    usernameNormalized: string;
    passwordHash: string;
    role: AdminUserRole;
    now: Date;
    transaction: Transaction;
  }) {
    const user = await User.create(
      {
        userId: input.userId,
        username: input.username,
        usernameNormalized: input.usernameNormalized,
        passwordHash: input.passwordHash,
        status: "active",
        createdAt: input.now,
        updatedAt: input.now,
        lastLoginAt: null,
        mustChangePassword: true,
      },
      { transaction: input.transaction },
    );
    await TenantMembership.create(
      {
        tenantId: input.tenantId,
        userId: user.userId,
        role: input.role,
        status: "active",
        createdAt: input.now,
        updatedAt: input.now,
      },
      { transaction: input.transaction },
    );
    return {
      userId: user.userId,
      username: user.username,
      status: user.status,
      mustChangePassword: true as const,
    };
  }

  async findGrantMeta(tenantId: string, userId: string): Promise<AdminUserGrantMeta | null> {
    const rows = await this.database.query<AdminUserGrantMeta>(
      `SELECT role, can_delete_data AS "canDeleteData", deletion_grant_version AS "deletionGrantVersion"
         FROM tenant_memberships WHERE tenant_id = :tenantId AND user_id = :userId`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
    );
    return rows[0] ?? null;
  }

  listToolGrants(tenantId: string, userId: string): Promise<AdminToolGrantRow[]> {
    return this.database.query<AdminToolGrantRow>(
      `SELECT t.tool_id AS "toolId", t.display_name AS "displayName", t.status,
                g.can_discover AS "canDiscover", g.can_execute AS "canExecute",
                g.can_view_results AS "canViewResults", g.can_download_results AS "canDownloadResults", g.version
         FROM tools t LEFT JOIN tool_grants g ON g.tool_id = t.tool_id AND g.tenant_id = :tenantId AND g.user_id = :userId
         ORDER BY t.sort_order, t.tool_id`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
    );
  }

  async userExistsInTenant(tenantId: string, userId: string): Promise<boolean> {
    return Boolean(
      await TenantMembership.findOne({
        where: { tenantId, userId },
        attributes: ["userId"],
      }),
    );
  }

  async listSessions(tenantId: string, userId: string): Promise<AdminUserSessionRow[]> {
    const sessions = await UserSession.findAll({
      where: { tenantId, userId },
      attributes: ["sessionId", "createdAt", "lastSeenAt", "expiresAt", "revokedAt", "browserLabel"],
      order: [["createdAt", "DESC"]],
      limit: 100,
    });
    return sessions.map((session) => session.toJSON() as AdminUserSessionRow);
  }

  listPage(input: {
    tenantId: string;
    query: string;
    before: { createdAt: Date; userId: string } | null;
    fetchLimit: number;
  }): Promise<AdminUserListRow[]> {
    return this.database.query<AdminUserListRow>(
      `SELECT u.user_id AS "userId", u.username, u.status, m.role,
                u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
                (SELECT count(*)::int FROM user_sessions s WHERE s.user_id = u.user_id
                  AND s.tenant_id = m.tenant_id AND s.revoked_at IS NULL AND s.expires_at > now()) AS "activeSessionCount",
                (u.recovery_email_verified_at IS NOT NULL AND u.recovery_email_normalized IS NOT NULL) AS "hasVerifiedRecoveryEmail"
         FROM tenant_memberships m JOIN users u ON u.user_id = m.user_id
         WHERE m.tenant_id = :tenantId AND (:query = '' OR position(:query in u.username_normalized) > 0)
           AND (:beforeCreated IS NULL OR (u.created_at, u.user_id) < (:beforeCreated, :beforeId))
         ORDER BY u.created_at DESC, u.user_id DESC LIMIT :fetchLimit`,
      {
        replacements: {
          tenantId: input.tenantId,
          query: input.query,
          beforeCreated: input.before?.createdAt ?? null,
          beforeId: input.before?.userId ?? null,
          fetchLimit: input.fetchLimit,
        },
        type: QueryTypes.SELECT,
      },
    );
  }
}
