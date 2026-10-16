import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import { isResourceTombstoned } from "../../contracts/deletion-barrier";
import {
  type NotificationEventType,
  ResultSet,
  sequelize,
  TenantMembership,
  UserNotification,
} from "../../infrastructure/database/db";

@Injectable()
export class NotificationsRepository {
  async hasActiveMembership(tenantId: string, userId: string) {
    const membership = await TenantMembership.findOne({ where: { tenantId, userId, status: "active" } });
    return Boolean(membership);
  }

  async recordResultSetEvent(
    resultSet: ResultSet,
    eventType: NotificationEventType,
    config: { title: string; message: string; href: string },
    transaction: Transaction,
  ) {
    const eventKey = `${resultSet.resultSetId}:${eventType}`;
    await UserNotification.findOrCreate({
      where: { tenantId: resultSet.tenantId, recipientUserId: resultSet.actorUserId, eventKey },
      defaults: {
        notificationId: randomUUID(),
        tenantId: resultSet.tenantId,
        recipientUserId: resultSet.actorUserId,
        resultSetId: resultSet.resultSetId,
        eventType,
        eventKey,
        ...config,
        createdAt: new Date(),
        readAt: null,
      },
      transaction,
    });
  }

  async list(input: { tenantId: string; userId: string; limit: number; unreadOnly: boolean }) {
    const replacements = { tenantId: input.tenantId, userId: input.userId, limit: input.limit };
    const [counts, items] = await Promise.all([
      sequelize.query<{ unreadCount: number }>(
        `SELECT count(*)::int AS "unreadCount" FROM user_notifications notification
          JOIN result_sets result_set ON result_set.result_set_id = notification.result_set_id AND result_set.tenant_id = notification.tenant_id
         WHERE notification.tenant_id = :tenantId AND notification.recipient_user_id = :userId AND notification.read_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
             AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')`,
        { replacements, type: QueryTypes.SELECT },
      ),
      sequelize.query<Record<string, unknown>>(
        `SELECT notification.notification_id AS id, notification.event_type AS "eventType", notification.title, notification.message,
                notification.href, notification.result_set_id AS "resultSetId", notification.created_at AS "createdAt", notification.read_at AS "readAt"
           FROM user_notifications notification
           JOIN result_sets result_set ON result_set.result_set_id = notification.result_set_id AND result_set.tenant_id = notification.tenant_id
          WHERE notification.tenant_id = :tenantId AND notification.recipient_user_id = :userId
            AND (:unreadOnly = FALSE OR notification.read_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM resource_tombstones deletion WHERE deletion.tenant_id = result_set.tenant_id
              AND deletion.resource_type = 'import' AND deletion.resource_id = result_set.batch_id AND deletion.state <> 'completed')
          ORDER BY notification.created_at DESC, notification.notification_id DESC LIMIT :limit`,
        { replacements: { ...replacements, unreadOnly: input.unreadOnly }, type: QueryTypes.SELECT },
      ),
    ]);
    return { unreadCount: Number(counts[0]?.unreadCount ?? 0), items };
  }

  async markRead(input: { tenantId: string; userId: string; notificationId: string }) {
    return sequelize.transaction(async (transaction) => {
      const item = await UserNotification.findOne({
        where: {
          notificationId: input.notificationId,
          tenantId: input.tenantId,
          recipientUserId: input.userId,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!item) return null;
      const resultSet = await ResultSet.findOne({
        where: { resultSetId: item.resultSetId, tenantId: input.tenantId },
        transaction,
      });
      const batchId = resultSet?.batchId;
      if (!resultSet || (batchId && (await isResourceTombstoned("import", batchId, transaction)))) return null;
      if (!item.readAt) {
        item.readAt = new Date();
        await item.save({ transaction });
      }
      return { id: item.notificationId, readAt: item.readAt.toISOString() };
    });
  }
}
