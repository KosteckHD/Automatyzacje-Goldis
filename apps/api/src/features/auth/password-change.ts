import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { type User, UserSession } from "../../infrastructure/database/db";
import type { AuditService } from "../audit/public";

export type PasswordChangeReason =
  | "self_service"
  | "administrator_reset"
  | "manager_reset"
  | "recovery"
  | "offline_admin_recovery";

/** The caller must lock the user and revalidate its credential snapshot in this transaction. */
export async function applyPasswordChange(
  input: Readonly<{
    user: User;
    tenantId: string;
    actorUserId: string | null;
    passwordHash: string;
    mustChangePassword: boolean;
    reason: PasswordChangeReason;
    transaction: Transaction;
    audit: Pick<AuditService, "record">;
  }>,
): Promise<Readonly<{ credentialRevision: number; revokedSessions: number }>> {
  const { user, transaction } = input;
  if (user.credentialRevision >= 2_147_483_647) {
    throw new ServiceUnavailableException("Nie można zwiększyć rewizji zabezpieczeń konta");
  }
  const now = new Date();
  const credentialRevision = user.credentialRevision + 1;
  user.passwordHash = input.passwordHash;
  user.credentialRevision = credentialRevision;
  user.mustChangePassword = input.mustChangePassword;
  user.updatedAt = now;
  await user.save({ transaction, fields: ["passwordHash", "credentialRevision", "mustChangePassword", "updatedAt"] });
  const [revokedSessions] = await UserSession.update(
    {
      revokedAt: now,
      revokedBy: input.actorUserId,
      revokeReason: "password_change",
    },
    { where: { userId: user.userId, revokedAt: null }, transaction },
  );
  await input.audit.record(
    {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: "password.changed",
      resourceType: "user",
      resourceId: user.userId,
      outcome: "succeeded",
      metadata: { reason: input.reason, revokedSessions },
    },
    transaction,
  );
  return { credentialRevision, revokedSessions };
}

export function assertCredentialSnapshot(user: User, passwordHash: string, revision: number): void {
  if (user.passwordHash !== passwordHash || user.credentialRevision !== revision) {
    throw new ConflictException("Poświadczenia zmieniły się; odśwież stronę i spróbuj ponownie");
  }
}
