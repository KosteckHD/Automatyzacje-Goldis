import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import type { NotificationEventType, ResultSet } from "../../infrastructure/database/db";
import { NotificationsRepository } from "./notifications.repository";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class NotificationService {
  constructor(@Inject(NotificationsRepository) private readonly repository: NotificationsRepository) {}

  async recordResultSetEvent(resultSet: ResultSet, eventType: NotificationEventType, transaction: Transaction) {
    const operationUrl = `/results/oc-policy-verification?resultSetId=${encodeURIComponent(resultSet.resultSetId)}`;
    const config =
      eventType === "result_ready"
        ? {
            title: "Wynik gotowy",
            message: "Automatyzacja zakończyła pracę. Wyniki są dostępne w platformie.",
            href: operationUrl,
          }
        : {
            title: "Wymagane działanie",
            message: "Automatyzacja czeka na Twoje działanie. Otwórz operację, aby sprawdzić kolejny krok.",
            href:
              resultSet.sourceType === "run_submission"
                ? `/submissions/${encodeURIComponent(resultSet.sourceId)}`
                : resultSet.batchId
                  ? `/imports/${encodeURIComponent(String(resultSet.batchId))}`
                  : operationUrl,
          };
    await this.repository.recordResultSetEvent(resultSet, eventType, config, transaction);
  }

  async list(actor: { tenantId: string; userId: string }, limitValue?: string, unreadOnlyValue?: string) {
    if (!(await this.repository.hasActiveMembership(actor.tenantId, actor.userId))) {
      throw new ForbiddenException("Konto lub dostęp do firmy nie jest już aktywny");
    }
    const limit = limitValue === undefined ? 30 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("Nieprawidłowy limit powiadomień");
    }
    const unreadOnly = unreadOnlyValue === "true";
    if (unreadOnlyValue !== undefined && unreadOnlyValue !== "true" && unreadOnlyValue !== "false") {
      throw new BadRequestException("Nieprawidłowy filtr powiadomień");
    }
    const result = await this.repository.list({
      tenantId: actor.tenantId,
      userId: actor.userId,
      limit,
      unreadOnly,
    });
    return {
      unreadCount: result.unreadCount,
      items: result.items.map((item) => ({
        id: item.id,
        eventType: item.eventType,
        title: item.title,
        message: item.message,
        href: item.href,
        resultSetId: item.resultSetId,
        createdAt: new Date(String(item.createdAt)).toISOString(),
        readAt: item.readAt ? new Date(String(item.readAt)).toISOString() : null,
      })),
    };
  }

  async markRead(actor: { tenantId: string; userId: string }, id: string) {
    if (!uuidPattern.test(id)) throw new NotFoundException("Nie znaleziono powiadomienia");
    const result = await this.repository.markRead({
      tenantId: actor.tenantId,
      userId: actor.userId,
      notificationId: id,
    });
    if (!result) throw new NotFoundException("Nie znaleziono powiadomienia");
    return result;
  }
}
