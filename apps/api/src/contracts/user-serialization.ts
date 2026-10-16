import type { Transaction } from "sequelize";

/** Serialize authentication changes by user across tenants and API replicas. */
export async function lockUsersInTransaction(userIds: readonly string[], transaction: Transaction): Promise<void> {
  // Sequelize exposes the owning instance at runtime; v6's public type omits it.
  const database = (transaction as Transaction & {
    sequelize: {
      query(sql: string, options: { replacements: { lockKey: string }; transaction: Transaction }): Promise<unknown>;
    };
  }).sequelize;
  for (const userId of [...new Set(userIds)].sort()) {
    await database.query(
      "SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 1))",
      { replacements: { lockKey: `goldis:user:${userId}` }, transaction },
    );
  }
}
