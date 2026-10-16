import { DataTypes, type QueryInterface } from "sequelize";

/** Stores personal, idempotent status notifications for logical operations. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("user_notifications", {
      notification_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      recipient_user_id: { type: DataTypes.UUID, allowNull: false },
      result_set_id: { type: DataTypes.UUID, allowNull: false },
      event_type: { type: DataTypes.STRING(24), allowNull: false },
      event_key: { type: DataTypes.STRING(180), allowNull: false },
      title: { type: DataTypes.STRING(120), allowNull: false },
      message: { type: DataTypes.STRING(320), allowNull: false },
      href: { type: DataTypes.STRING(500), allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      read_at: { type: DataTypes.DATE, allowNull: true },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE user_notifications
         ADD CONSTRAINT user_notifications_recipient_fk FOREIGN KEY (tenant_id, recipient_user_id)
           REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE,
         ADD CONSTRAINT user_notifications_result_set_fk FOREIGN KEY (result_set_id, tenant_id)
           REFERENCES result_sets (result_set_id, tenant_id) ON DELETE CASCADE,
         ADD CONSTRAINT user_notifications_type_valid CHECK (event_type IN ('result_ready', 'action_required')),
         ADD CONSTRAINT user_notifications_event_uidx UNIQUE (tenant_id, recipient_user_id, event_key);
       CREATE INDEX user_notifications_unread_idx
         ON user_notifications (tenant_id, recipient_user_id, created_at DESC, notification_id DESC)
         WHERE read_at IS NULL;`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.dropTable("user_notifications", { transaction });
  });
}
