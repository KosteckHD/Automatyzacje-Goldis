import { DataTypes, Model } from "sequelize";
import { registerModel } from "../../infrastructure/database/model-registry";

export type NotificationEventType = "result_ready" | "action_required";

export class UserNotificationModel extends Model {
  declare notificationId: string;
  declare tenantId: string;
  declare recipientUserId: string;
  declare resultSetId: string;
  declare eventType: NotificationEventType;
  declare eventKey: string;
  declare title: string;
  declare message: string;
  declare href: string;
  declare createdAt: Date;
  declare readAt: Date | null;
}

registerModel(
  UserNotificationModel,
  {
    notificationId: { type: DataTypes.UUID, primaryKey: true, field: "notification_id" },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    recipientUserId: { type: DataTypes.UUID, allowNull: false, field: "recipient_user_id" },
    resultSetId: { type: DataTypes.UUID, allowNull: false, field: "result_set_id" },
    eventType: { type: DataTypes.STRING(24), allowNull: false, field: "event_type" },
    eventKey: { type: DataTypes.STRING(180), allowNull: false, field: "event_key" },
    title: { type: DataTypes.STRING(120), allowNull: false },
    message: { type: DataTypes.STRING(320), allowNull: false },
    href: { type: DataTypes.STRING(500), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
    readAt: { type: DataTypes.DATE, allowNull: true, field: "read_at" },
  },
  { tableName: "user_notifications", timestamps: false, modelName: "UserNotification" },
);
