import { DataTypes, type QueryInterface } from "sequelize";

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.addColumn("users", "must_change_password", {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
    }, { transaction });
    await context.createTable("user_sessions", {
      session_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      last_seen_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      revoked_by: { type: DataTypes.UUID, allowNull: true },
      revoke_reason: { type: DataTypes.STRING(32), allowNull: true },
      ip_hash: { type: DataTypes.STRING(64), allowNull: true },
      browser_label: { type: DataTypes.STRING(80), allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE user_sessions
         ADD CONSTRAINT user_sessions_membership_fk FOREIGN KEY (tenant_id, user_id)
           REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
         ADD CONSTRAINT user_sessions_revoker_fk FOREIGN KEY (revoked_by)
           REFERENCES users(user_id) ON DELETE SET NULL,
         ADD CONSTRAINT user_sessions_reason_valid CHECK
           (revoke_reason IS NULL OR revoke_reason IN ('logout', 'admin', 'password_change', 'account_change', 'expired')),
         ADD CONSTRAINT user_sessions_expiry_valid CHECK (expires_at > created_at),
         ADD CONSTRAINT user_sessions_revocation_pair CHECK
           ((revoked_at IS NULL) = (revoke_reason IS NULL)),
         ADD CONSTRAINT user_sessions_ip_hash_valid CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$');
       CREATE INDEX user_sessions_user_active_idx ON user_sessions (tenant_id, user_id, expires_at DESC)
         WHERE revoked_at IS NULL;
       CREATE INDEX user_sessions_expiry_idx ON user_sessions (expires_at);`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("user_sessions", { transaction });
    await context.removeColumn("users", "must_change_password", { transaction });
  });
}
