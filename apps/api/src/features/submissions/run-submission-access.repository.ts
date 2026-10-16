import { Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { TenantMembership, Tool, ToolGrant, User, UserSession } from "../../infrastructure/database/db";

export type RunSubmissionExecutionAccess = Readonly<{
  user: User | null;
  membership: TenantMembership | null;
  session: UserSession | null;
  tool: Tool | null;
  grant: ToolGrant | null;
}>;

@Injectable()
export class RunSubmissionAccessRepository {
  async findExecutionAccess(
    tenantId: string,
    userId: string,
    toolId: string,
    sessionId: string | undefined,
    transaction: Transaction,
  ): Promise<RunSubmissionExecutionAccess> {
    const user = await User.findByPk(userId, {
      attributes: ["status", "credentialRevision"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const membership = await TenantMembership.findOne({
      where: { tenantId, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const session = sessionId
      ? await UserSession.findOne({
          where: { sessionId, tenantId, userId, revokedAt: null },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    const toolRecord = await Tool.findByPk(toolId, { transaction, lock: transaction.LOCK.UPDATE });
    const grant = await ToolGrant.findOne({
      where: { tenantId, toolId, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return { user, membership, session, tool: toolRecord, grant };
  }
}
