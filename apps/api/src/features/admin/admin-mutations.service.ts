import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import type { SessionPrincipal } from "../auth";
import { canAssignIntervention } from "../authorization";
import { AdminMutationsRepository } from "./admin-mutations.repository";

@Injectable()
export class AdminMutationsService {
  constructor(@Inject(AdminMutationsRepository) private readonly repository: AdminMutationsRepository) {}

  async lockTenantAdminChanges(
    actor: SessionPrincipal,
    transaction: Transaction,
    targetUserIds: readonly string[] = [],
  ) {
    const { user, member, session } = await this.repository.lockTenantAdminChanges(actor, transaction, targetUserIds);
    if (
      user?.status !== "active" ||
      !member ||
      !session ||
      session.expiresAt.getTime() <= Date.now() ||
      session.credentialRevision !== user.credentialRevision
    ) {
      throw new ForbiddenException("Sesja administratora lub uprawnienia nie są już aktywne");
    }
  }

  async clearDeletionGrantForMembership(tenantId: string, userId: string, transaction: Transaction): Promise<void> {
    if (!(await this.repository.clearDeletionGrantForMembership(tenantId, userId, transaction))) {
      throw new ServiceUnavailableException("Nie można bezpiecznie zwiększyć rewizji grantu usuwania");
    }
  }

  async unassignOpenInterventions(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
    toolId?: string;
    kind?: "sms" | "identity_review" | "portal_error";
    transaction: Transaction;
  }): Promise<number> {
    const rows = await this.repository.findOpenAssignedInterventionIds(input);
    for (const row of rows) {
      await this.repository.unassignOpenIntervention(
        row.interventionId,
        input.userId,
        input.actorUserId,
        input.transaction,
      );
    }
    return rows.length;
  }

  async unassignIneligibleInterventions(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
    transaction: Transaction;
    role?: string;
  }): Promise<number> {
    const rows = await this.repository.findOpenAssignedInterventions(input);
    let removed = 0;
    for (const row of rows) {
      const allowed =
        row.toolStatus !== "disabled" &&
        canAssignIntervention({
          role: input.role ?? row.role,
          kind: row.kind,
          canViewResults: row.canViewResults,
          canExecute: row.canExecute,
        });
      if (allowed) continue;
      if (
        await this.repository.unassignOpenIntervention(
          row.interventionId,
          input.userId,
          input.actorUserId,
          input.transaction,
        )
      ) {
        removed += 1;
      }
    }
    return removed;
  }
}
