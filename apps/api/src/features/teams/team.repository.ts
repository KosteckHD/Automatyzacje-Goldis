import { Inject, Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { API_DATABASE } from "../../infrastructure/database";
import { TenantMembership, Tool, ToolGrant, User, UserSession } from "../../infrastructure/database/db";

@Injectable()
export class TeamRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return this.database.transaction(work);
  }

  async lockManagerChanges(
    current: { userId: string; tenantId: string; sessionId?: string },
    transaction: Transaction,
    targetUserIds: readonly string[] = [],
  ) {
    await this.database.query("SELECT pg_advisory_xact_lock(hashtextextended(:tenantId, 0))", {
      replacements: { tenantId: current.tenantId },
      transaction,
    });
    await lockUsersInTransaction([current.userId, ...targetUserIds], transaction);
    const [user, membership, session] = await Promise.all([
      User.findByPk(current.userId, { transaction, lock: transaction.LOCK.UPDATE }),
      TenantMembership.findOne({
        where: {
          tenantId: current.tenantId,
          userId: current.userId,
          role: { [Op.in]: ["manager", "admin"] },
          status: "active",
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
      current.sessionId
        ? UserSession.findOne({
            where: {
              sessionId: current.sessionId,
              tenantId: current.tenantId,
              userId: current.userId,
              revokedAt: null,
            },
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        : Promise.resolve(null),
    ]);
    return { user, membership, session };
  }

  findEmployeeMembership(tenantId: string, userId: string, transaction?: Transaction) {
    return TenantMembership.findOne({ where: { tenantId, userId, role: "operator" }, transaction });
  }

  listMembers(tenantId: string, toolId: string, query: string) {
    return this.database.query<{
      userId: string;
      username: string;
      status: string;
      membershipStatus: string;
      createdAt: Date;
      lastLoginAt: Date | null;
      activeSessionCount: number;
      leadCount: number;
      canExecuteOc: boolean;
      hasVerifiedRecoveryEmail: boolean;
    }>(
      `SELECT u.user_id AS "userId", u.username, u.status, m.status AS "membershipStatus", u.created_at AS "createdAt",
              u.last_login_at AS "lastLoginAt",
              (SELECT count(*)::int FROM user_sessions s WHERE s.user_id = u.user_id AND s.tenant_id = m.tenant_id
                AND s.revoked_at IS NULL AND s.expires_at > now()) AS "activeSessionCount",
              (SELECT count(*)::int FROM business_leads l JOIN result_sets rs ON rs.result_set_id = l.result_set_id AND rs.tenant_id = l.tenant_id
                WHERE l.tenant_id = m.tenant_id AND l.assigned_to_user_id = u.user_id
                  AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = rs.tenant_id
                    AND deletion.resource_type = 'import' AND deletion.resource_id = rs.batch_id AND deletion.state <> 'completed')) AS "leadCount",
              (u.recovery_email_verified_at IS NOT NULL AND u.recovery_email_normalized IS NOT NULL) AS "hasVerifiedRecoveryEmail",
              COALESCE(g.can_execute, FALSE) AS "canExecuteOc"
         FROM tenant_memberships m JOIN users u ON u.user_id = m.user_id
         LEFT JOIN tool_grants g ON g.tenant_id = m.tenant_id AND g.user_id = m.user_id AND g.tool_id = :toolId
        WHERE m.tenant_id = :tenantId AND m.role = 'operator'
          AND (:query = '' OR position(:query in u.username_normalized) > 0)
        ORDER BY u.created_at DESC, u.user_id DESC LIMIT 200`,
      { replacements: { tenantId, toolId, query }, type: QueryTypes.SELECT },
    );
  }

  createUser(input: Parameters<typeof User.create>[0], transaction: Transaction) {
    return User.create(input, { transaction });
  }

  createMembership(input: Parameters<typeof TenantMembership.create>[0], transaction: Transaction) {
    return TenantMembership.create(input, { transaction });
  }

  findUserForUpdate(userId: string, transaction: Transaction) {
    return User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  saveMembership(membership: TenantMembership, transaction: Transaction) {
    return membership.save({ transaction });
  }

  saveUserStatus(user: User, transaction: Transaction) {
    return user.save({ transaction, fields: ["status", "updatedAt"] });
  }

  async revokeSessions(tenantId: string, userId: string, actorUserId: string, transaction: Transaction) {
    const [count] = await UserSession.update(
      { revokedAt: new Date(), revokedBy: actorUserId, revokeReason: "account_change" },
      { where: { tenantId, userId, revokedAt: null }, transaction },
    );
    return count;
  }

  findTool(toolId: string, transaction?: Transaction) {
    return Tool.findByPk(toolId, { transaction });
  }

  findGrant(tenantId: string, userId: string, toolId: string, transaction?: Transaction, forUpdate = false) {
    return ToolGrant.findOne({
      where: { tenantId, userId, toolId },
      transaction,
      ...(forUpdate && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  buildGrant(input: Parameters<typeof ToolGrant.build>[0]) {
    return ToolGrant.build(input);
  }

  saveGrant(grant: ToolGrant, transaction: Transaction) {
    return grant.save({ transaction });
  }
}
