import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { API_DATABASE } from "../../infrastructure/database";
import {
  InterventionActivity,
  ManualIntervention,
  TenantMembership,
  User,
  UserSession,
} from "../../infrastructure/database/db";
import type { SessionPrincipal } from "../auth";

export type InterventionAssignmentRow = Readonly<{
  interventionId: string;
  kind: "sms" | "identity_review" | "portal_error";
  role: string;
  toolStatus: string;
  canViewResults: boolean;
  canExecute: boolean;
}>;

@Injectable()
export class AdminMutationsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  async lockTenantAdminChanges(
    actor: SessionPrincipal,
    transaction: Transaction,
    targetUserIds: readonly string[] = [],
  ) {
    await this.database.query("SELECT pg_advisory_xact_lock(hashtextextended(:tenantId, 0))", {
      replacements: { tenantId: actor.tenantId },
      transaction,
    });
    await lockUsersInTransaction([actor.userId, ...targetUserIds], transaction);
    const [user, member, session] = await Promise.all([
      User.findByPk(actor.userId, { transaction, lock: transaction.LOCK.UPDATE }),
      TenantMembership.findOne({
        where: { tenantId: actor.tenantId, userId: actor.userId, role: "admin", status: "active" },
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
    return { user, member, session };
  }

  async clearDeletionGrantForMembership(tenantId: string, userId: string, transaction: Transaction): Promise<boolean> {
    const changed = await this.database.query<{ userId: string }>(
      `UPDATE tenant_memberships
          SET can_delete_data = FALSE, deletion_grant_version = deletion_grant_version + 1
        WHERE tenant_id = :tenantId AND user_id = :userId AND can_delete_data = TRUE
          AND deletion_grant_version < 2147483647
        RETURNING user_id AS "userId"`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT, transaction },
    );
    if (changed.length) return true;
    const rows = await this.database.query<{ canDeleteData: boolean }>(
      `SELECT can_delete_data AS "canDeleteData" FROM tenant_memberships
        WHERE tenant_id = :tenantId AND user_id = :userId`,
      { replacements: { tenantId, userId }, type: QueryTypes.SELECT, transaction },
    );
    return !rows[0]?.canDeleteData;
  }

  findOpenAssignedInterventionIds(input: {
    tenantId: string;
    userId: string;
    toolId?: string;
    kind?: "sms" | "identity_review" | "portal_error";
    transaction: Transaction;
  }) {
    return this.database.query<{ interventionId: string }>(
      `SELECT mi.intervention_id AS "interventionId"
         FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
         JOIN import_batches b ON b.id = r.batch_id
        WHERE b.tenant_id = :tenantId AND b.tool_id = COALESCE(:toolId, b.tool_id)
          AND mi.kind = COALESCE(:kind, mi.kind) AND mi.assignee_user_id = :userId AND mi.status = 'open'
        ORDER BY mi.intervention_id FOR UPDATE OF mi`,
      {
        replacements: {
          tenantId: input.tenantId,
          userId: input.userId,
          toolId: input.toolId ?? null,
          kind: input.kind ?? null,
        },
        type: QueryTypes.SELECT,
        transaction: input.transaction,
      },
    );
  }

  findOpenAssignedInterventions(input: { tenantId: string; userId: string; transaction: Transaction }) {
    return this.database.query<InterventionAssignmentRow>(
      `SELECT mi.intervention_id AS "interventionId", mi.kind, m.role, t.status AS "toolStatus",
              COALESCE(g.can_view_results, FALSE) AS "canViewResults",
              COALESCE(g.can_execute, FALSE) AS "canExecute"
         FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
         JOIN import_batches b ON b.id = r.batch_id
         JOIN tools t ON t.tool_id = b.tool_id AND t.tool_id = r.tool_id
         JOIN tenant_memberships m ON m.tenant_id = b.tenant_id AND m.user_id = mi.assignee_user_id
         LEFT JOIN tool_grants g ON g.tenant_id = b.tenant_id AND g.tool_id = b.tool_id AND g.user_id = mi.assignee_user_id
        WHERE b.tenant_id = :tenantId AND mi.assignee_user_id = :userId AND mi.status = 'open'
        ORDER BY mi.intervention_id FOR UPDATE OF mi`,
      {
        replacements: { tenantId: input.tenantId, userId: input.userId },
        type: QueryTypes.SELECT,
        transaction: input.transaction,
      },
    );
  }

  async unassignOpenIntervention(
    interventionId: string,
    userId: string,
    actorUserId: string,
    transaction: Transaction,
  ) {
    const intervention = await ManualIntervention.findByPk(interventionId, { transaction });
    if (intervention?.status !== "open" || intervention.assigneeUserId !== userId) return false;
    const now = new Date();
    intervention.assigneeUserId = null;
    intervention.assignedAt = null;
    intervention.assignedBy = null;
    intervention.dueAt = null;
    intervention.revision += 1;
    intervention.updatedAt = now;
    await intervention.save({ transaction });
    await InterventionActivity.create(
      {
        activityId: randomUUID(),
        interventionId: intervention.interventionId,
        actorUserId,
        eventType: "unassigned",
        previousAssigneeUserId: userId,
        nextAssigneeUserId: null,
        priority: null,
        createdAt: now,
      },
      { transaction },
    );
    return true;
  }
}
