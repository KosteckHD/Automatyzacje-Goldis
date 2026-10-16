import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { type InterventionListRow, InterventionRepository } from "./interventions.repository";
import { canResumeManualIntervention } from "./manual-data.contract";
import { canRetrySms } from "./sms-retry-policy";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(["open", "resolved", "cancelled", "expired", "all"]);
const portals = new Set(["pzu", "compensa"]);
const kinds = new Set(["sms", "identity_review", "portal_error"]);
const cursorTime = (value: string): boolean =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

@Injectable()
export class InterventionService {
  constructor(@Inject(InterventionRepository) private readonly repository: InterventionRepository) {}

  async list(
    input: { tenantId: string; userId: string; role: string },
    query: { status?: string; portal?: string; kind?: string; limit?: string; cursor?: string },
  ) {
    const status = query.status ?? "open";
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (
      !statuses.has(status) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (query.portal !== undefined && !portals.has(query.portal)) ||
      (query.kind !== undefined && !kinds.has(query.kind))
    ) {
      throw new BadRequestException("Nieprawidłowy filtr zgłoszeń");
    }

    let cursor: { createdAt: string; interventionId: string } | null = null;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (
          typeof decoded.createdAt !== "string" ||
          !cursorTime(decoded.createdAt) ||
          typeof decoded.interventionId !== "string" ||
          !uuidPattern.test(decoded.interventionId)
        ) {
          throw new Error();
        }
        cursor = { createdAt: decoded.createdAt, interventionId: decoded.interventionId };
      } catch {
        throw new BadRequestException("Nieprawidłowy kursor zgłoszeń");
      }
    }

    const rows = await this.repository.list({
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      status,
      portal: query.portal ?? null,
      kind: query.kind ?? null,
      cursorCreated: cursor?.createdAt ?? null,
      cursorId: cursor?.interventionId ?? null,
      fetchLimit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((row) => this.toListItem(row, input));
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), interventionId: last.interventionId }),
          ).toString("base64url")
        : null;
    return { items, nextCursor };
  }

  async summary(input: { tenantId: string; userId: string; role: string }) {
    const row = await this.repository.summary(input);
    return {
      openCount: Number(row?.openCount ?? 0),
      unreadCount: Number(row?.unreadCount ?? 0),
      smsCount: Number(row?.smsCount ?? 0),
    };
  }

  async markRead(interventionId: string, userId: string) {
    if (!uuidPattern.test(interventionId)) throw new BadRequestException("Nieprawidłowy identyfikator zgłoszenia");
    const result = await this.repository.markRead(interventionId, userId);
    if (!result) throw new BadRequestException("Nie znaleziono zgłoszenia");
    return result;
  }

  private toListItem(row: InterventionListRow, input: { userId: string; role: string }) {
    const activeSms =
      row.kind === "sms" &&
      row.status === "open" &&
      row.runStatus === "waiting_for_sms" &&
      row.challengeStatus === "active" &&
      row.expiresAt !== null &&
      new Date(row.expiresAt).getTime() > Date.now();
    const isRunStarter = row.startedByUserId === input.userId;
    const canReadSms = isRunStarter && row.canExecute;
    return {
      interventionId: row.interventionId,
      runId: row.runId,
      batchId: row.batchId,
      rowNumber: row.rowNumber,
      kind: row.kind,
      portal: row.portal,
      reasonCode: row.reasonCode,
      fieldCode: row.canViewResults ? row.fieldCode : null,
      status: row.status,
      assigneeUserId: row.assigneeUserId,
      assigneeUsername: row.assigneeUsername,
      priority: row.priority,
      dueAt: row.dueAt ? new Date(row.dueAt).toISOString() : null,
      isAssignedToMe: row.assigneeUserId === input.userId,
      runStatus: row.runStatus,
      revision: Number(row.revision),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      challenge:
        activeSms && canReadSms
          ? {
              challengeId: row.challengeId,
              expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
              status: row.challengeStatus,
              attemptCount: row.attemptCount,
              attemptLimit: row.attemptLimit,
            }
          : null,
      isUnread: (row.seenRevision ?? 0) < Number(row.revision),
      canSubmitSms: activeSms && canReadSms,
      canResumeAuth:
        row.kind === "sms" &&
        row.status === "open" &&
        isRunStarter &&
        row.canExecute &&
        canRetrySms({
          status: row.runStatus,
          errorCode: row.errorCode,
          reasonCode: row.reasonCode,
          portal: row.portal,
          retryCount: Number(row.retryCount),
        }),
      canResumeReview:
        row.canViewResults &&
        isRunStarter &&
        canResumeManualIntervention({
          role: input.role,
          isRunStarter,
          runStatus: row.runStatus,
          fieldCode: row.fieldCode,
          lastSafeStep: row.lastSafeStep,
          externalCaseRef: row.externalCaseRef,
          manualDataVersion: Number(row.manualDataVersion),
          overrideVersion: row.overrideVersion === null ? null : Number(row.overrideVersion),
          fields: row.overrideFields,
        }),
    };
  }
}
