import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("user_sessions", "last_activity_at", {
      type: DataTypes.DATE, allowNull: true,
    }, { transaction });
    await context.sequelize.query(
      `UPDATE user_sessions SET last_activity_at = last_seen_at WHERE last_activity_at IS NULL;
       ALTER TABLE user_sessions ALTER COLUMN last_activity_at SET NOT NULL;
       ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_reason_valid;
       ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_reason_valid
         CHECK (revoke_reason IS NULL OR revoke_reason IN ('logout', 'admin', 'password_change', 'account_change', 'expired', 'idle'));
       ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_last_activity_valid
         CHECK (last_activity_at >= created_at AND last_activity_at <= last_seen_at);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.removeConstraint("user_sessions", "user_sessions_last_activity_valid", { transaction });
    await context.sequelize.query(
      `UPDATE user_sessions SET revoke_reason = 'expired' WHERE revoke_reason = 'idle';
       ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_reason_valid;
       ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_reason_valid
         CHECK (revoke_reason IS NULL OR revoke_reason IN ('logout', 'admin', 'password_change', 'account_change', 'expired'));`,
      { transaction },
    );
    await context.removeColumn("user_sessions", "last_activity_at", { transaction });
  });
}
