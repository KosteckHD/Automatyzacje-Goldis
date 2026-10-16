import { Inject, Injectable } from "@nestjs/common";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { API_DATABASE } from "../../infrastructure/database";
import { TenantMembership, User, UserSession } from "../../infrastructure/database/db";
import type { SessionPrincipal } from "../auth";

export type RecoveryAccount = Readonly<{
  tenantId: string;
  userId: string;
  credentialRevision: number;
  recoveryEmailRevision: number;
  email: string;
  normalizedEmail: string;
}>;

@Injectable()
export class AccountRecoveryRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return this.database.transaction(work);
  }

  lockUsers(userIds: readonly string[], transaction: Transaction) {
    return lockUsersInTransaction(userIds, transaction);
  }

  async lockRecoveryActor(actor: SessionPrincipal, transaction: Transaction, targetUserId: string) {
    await this.database.query("SELECT pg_advisory_xact_lock(hashtextextended(:tenantId, 0))", {
      replacements: { tenantId: actor.tenantId },
      transaction,
    });
    await this.lockUsers([actor.userId, targetUserId], transaction);
    const [user, membership, session] = await Promise.all([
      User.findByPk(actor.userId, { transaction, lock: transaction.LOCK.UPDATE }),
      TenantMembership.findOne({
        where: { tenantId: actor.tenantId, userId: actor.userId, role: actor.role, status: "active" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
      actor.sessionId
        ? UserSession.findOne({
            where: { sessionId: actor.sessionId, tenantId: actor.tenantId, userId: actor.userId, revokedAt: null },
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        : Promise.resolve(null),
    ]);
    return { user, membership, session };
  }

  findUser(userId: string, transaction?: Transaction, lock = false) {
    return User.findByPk(userId, {
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findActiveMembership(tenantId: string, userId: string, transaction: Transaction) {
    return TenantMembership.findOne({
      where: { userId, tenantId, status: "active" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findActiveSession(sessionId: string, tenantId: string, userId: string, transaction: Transaction) {
    return UserSession.findOne({
      where: { sessionId, userId, tenantId, revokedAt: null },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findAccountsByVerifiedEmail(normalizedEmail: string) {
    return this.database.query<RecoveryAccount>(
      `SELECT u.user_id AS "userId", m.tenant_id AS "tenantId", u.credential_revision AS "credentialRevision",
              u.recovery_email_revision AS "recoveryEmailRevision", u.recovery_email AS email,
              u.recovery_email_normalized AS "normalizedEmail"
         FROM users u
         JOIN tenant_memberships m ON m.user_id = u.user_id AND m.status = 'active'
         JOIN tenants tenant ON tenant.tenant_id = m.tenant_id AND tenant.slug = 'goldis'
        WHERE u.status = 'active' AND u.recovery_email_verified_at IS NOT NULL
          AND u.recovery_email_normalized = :normalizedEmail
        LIMIT 1`,
      { replacements: { normalizedEmail }, type: QueryTypes.SELECT },
    );
  }

  lockVerifiedRecoveryAccount(userId: string, tenantId: string, normalizedEmail: string, transaction: Transaction) {
    return this.database.query<RecoveryAccount>(
      `SELECT u.user_id AS "userId", m.tenant_id AS "tenantId", u.credential_revision AS "credentialRevision",
              u.recovery_email_revision AS "recoveryEmailRevision", u.recovery_email AS email,
              u.recovery_email_normalized AS "normalizedEmail"
         FROM users u JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
        WHERE u.user_id = :userId AND u.status = 'active' AND m.status = 'active'
          AND u.recovery_email_verified_at IS NOT NULL AND u.recovery_email_normalized = :normalizedEmail
        FOR UPDATE OF u, m`,
      { replacements: { userId, tenantId, normalizedEmail }, type: QueryTypes.SELECT, transaction },
    );
  }

  findVerifiedRecoveryEmail(userId: string, transaction: Transaction) {
    return this.database.query<{ email: string }>(
      `SELECT recovery_email AS email FROM users
        WHERE user_id = :userId AND recovery_email_verified_at IS NOT NULL`,
      { replacements: { userId }, type: QueryTypes.SELECT, transaction },
    );
  }

  getRecoveryEmail(userId: string, tenantId: string) {
    return this.database.query<{
      recoveryEmail: string | null;
      recoveryEmailVerifiedAt: Date | null;
      pendingRecoveryEmail: string | null;
    }>(
      `SELECT u.recovery_email AS "recoveryEmail", u.recovery_email_verified_at AS "recoveryEmailVerifiedAt",
              u.pending_recovery_email AS "pendingRecoveryEmail"
         FROM users u JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
        WHERE u.user_id = :userId AND m.status = 'active'`,
      { replacements: { userId, tenantId }, type: QueryTypes.SELECT },
    );
  }

  lockRecoveryEmailProfile(userId: string, transaction: Transaction) {
    return this.database.query<{
      recoveryEmail: string | null;
      normalized: string | null;
      revision: number;
      pendingRevision: number;
    }>(
      `SELECT recovery_email AS "recoveryEmail", recovery_email_normalized AS normalized,
              recovery_email_revision AS revision, pending_recovery_email_revision AS "pendingRevision"
         FROM users WHERE user_id = :userId FOR UPDATE`,
      { replacements: { userId }, type: QueryTypes.SELECT, transaction },
    );
  }

  updatePendingRecoveryEmail(
    userId: string,
    address: string,
    normalized: string,
    pendingRevision: number,
    transaction: Transaction,
  ) {
    return this.database.query(
      `UPDATE users SET pending_recovery_email = :address, pending_recovery_email_normalized = :normalized,
                        pending_recovery_email_revision = :pendingRevision WHERE user_id = :userId`,
      { replacements: { address, normalized, pendingRevision, userId }, transaction },
    );
  }

  findActiveVerificationTokenIds(userId: string, transaction: Transaction) {
    return this.database.query<{ tokenId: string }>(
      `SELECT token_id AS "tokenId" FROM account_recovery_tokens
        WHERE user_id = :userId AND purpose = 'email_verify' AND consumed_at IS NULL AND revoked_at IS NULL`,
      { replacements: { userId }, type: QueryTypes.SELECT, transaction },
    );
  }

  revokeActiveVerificationTokens(userId: string, now: Date, transaction: Transaction) {
    return this.database.query(
      `UPDATE account_recovery_tokens SET revoked_at = :now
        WHERE user_id = :userId AND purpose = 'email_verify' AND consumed_at IS NULL AND revoked_at IS NULL`,
      { replacements: { now, userId }, transaction },
    );
  }

  findPrivilegedResetTarget(userId: string, tenantId: string, transaction: Transaction) {
    return this.database.query<RecoveryAccount & { role: string; status: string; verifiedAt: Date | null }>(
      `SELECT u.user_id AS "userId", m.tenant_id AS "tenantId", m.role, u.status,
              u.credential_revision AS "credentialRevision", u.recovery_email_revision AS "recoveryEmailRevision",
              u.recovery_email AS email, u.recovery_email_normalized AS "normalizedEmail",
              u.recovery_email_verified_at AS "verifiedAt"
         FROM users u JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
        WHERE u.user_id = :userId AND m.status = 'active' FOR UPDATE OF u, m`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT, transaction },
    );
  }

  findPrivilegedEmailTarget(userId: string, tenantId: string, transaction: Transaction) {
    return this.database.query<{
      role: string;
      status: string;
      credentialRevision: number;
      revision: number;
      pendingRevision: number;
      currentNormalized: string | null;
    }>(
      `SELECT m.role, m.status AS "membershipStatus", u.status, u.credential_revision AS "credentialRevision",
              u.recovery_email_revision AS revision, u.pending_recovery_email_revision AS "pendingRevision",
              u.recovery_email_normalized AS "currentNormalized"
         FROM users u JOIN tenant_memberships m ON m.user_id = u.user_id AND m.tenant_id = :tenantId
        WHERE u.user_id = :userId AND m.status = 'active' FOR UPDATE OF u, m`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT, transaction },
    );
  }

  lockPendingRecoveryEmail(userId: string, transaction: Transaction) {
    return this.database.query<{
      oldEmail: string | null;
      newEmail: string;
      normalized: string;
      revision: number;
    }>(
      `SELECT recovery_email AS "oldEmail", pending_recovery_email AS "newEmail",
              pending_recovery_email_normalized AS normalized, recovery_email_revision AS revision
         FROM users WHERE user_id = :userId FOR UPDATE`,
      { replacements: { userId }, type: QueryTypes.SELECT, transaction },
    );
  }

  confirmPendingRecoveryEmail(userId: string, now: Date, transaction: Transaction) {
    return this.database.query(
      `UPDATE users SET recovery_email = pending_recovery_email,
                        recovery_email_normalized = pending_recovery_email_normalized,
                        recovery_email_verified_at = :now, recovery_email_revision = recovery_email_revision + 1,
                        pending_recovery_email = NULL, pending_recovery_email_normalized = NULL
        WHERE user_id = :userId`,
      { replacements: { now, userId }, transaction },
    );
  }
}
