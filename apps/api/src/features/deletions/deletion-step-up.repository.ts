import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { QueryTypes, Transaction } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import { sequelize, User, UserSession } from "../../infrastructure/database/db";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { canDeleteTarget, createDeletionStepUpGrant } from "./deletion-step-up";
import { previewFingerprint } from "./deletions.contract";
import { loadPreviewSnapshot } from "./deletions.repository";

export type DeletionStepUpIdentity = Readonly<{
  status: string;
  passwordHash: string;
  credentialRevision: number;
  mustChangePassword: boolean;
  role: string;
  canDeleteData: boolean;
  deletionGrantVersion: number;
}>;

export type DeletionStepUpIssueInput = Readonly<{
  actor: SessionPrincipal;
  previewId: string;
  expectedPasswordHash: string;
  expectedCredentialRevision: number;
  now: Date;
  expiresAt: Date;
}>;

/** SQL and transaction boundary for issuing a deletion step-up grant. */
@Injectable()
export class DeletionStepUpRepository {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async findIdentity(userId: string, tenantId: string): Promise<DeletionStepUpIdentity | null> {
    const user = await User.findByPk(userId, {
      attributes: ["status", "passwordHash", "credentialRevision", "mustChangePassword"],
    });
    if (!user) return null;
    const memberships = await sequelize.query<{
      role: string;
      canDeleteData: boolean;
      deletionGrantVersion: number;
    }>(
      `SELECT role, can_delete_data AS "canDeleteData", deletion_grant_version AS "deletionGrantVersion"
         FROM tenant_memberships WHERE user_id = :userId AND tenant_id = :tenantId AND status = 'active'`,
      { replacements: { userId, tenantId }, type: QueryTypes.SELECT },
    );
    const membership = memberships[0];
    if (!membership) return null;
    return {
      status: user.status,
      passwordHash: user.passwordHash,
      credentialRevision: user.credentialRevision,
      mustChangePassword: user.mustChangePassword,
      role: membership.role,
      canDeleteData: membership.canDeleteData,
      deletionGrantVersion: membership.deletionGrantVersion,
    };
  }

  async issueGrant(input: DeletionStepUpIssueInput): Promise<string> {
    const { actor, previewId, now } = input;
    return sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        await lockUsersInTransaction([actor.userId], transaction);
        const currentUser = await User.findByPk(actor.userId, { transaction, lock: transaction.LOCK.UPDATE });
        const currentMemberships = await sequelize.query<{
          role: string;
          canDeleteData: boolean;
          deletionGrantVersion: number;
        }>(
          `SELECT role, can_delete_data AS "canDeleteData", deletion_grant_version AS "deletionGrantVersion"
             FROM tenant_memberships WHERE user_id = :userId AND tenant_id = :tenantId AND status = 'active' FOR UPDATE`,
          { replacements: { userId: actor.userId, tenantId: actor.tenantId }, type: QueryTypes.SELECT, transaction },
        );
        const currentMembership = currentMemberships[0];
        const currentSession = await UserSession.findOne({
          where: { sessionId: actor.sessionId, userId: actor.userId, tenantId: actor.tenantId, revokedAt: null },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          currentUser?.status !== "active" ||
          currentUser.mustChangePassword ||
          currentUser.passwordHash !== input.expectedPasswordHash ||
          currentUser.credentialRevision !== input.expectedCredentialRevision ||
          !currentMembership ||
          !currentSession ||
          currentSession.expiresAt.getTime() <= now.getTime() ||
          currentSession.credentialRevision !== currentUser.credentialRevision
        ) {
          throw new ConflictException(
            "Sesja, poświadczenia lub uprawnienia zmieniły się; odśwież podgląd i spróbuj ponownie",
          );
        }

        const previews = await sequelize.query<{
          scopeFingerprint: string;
          expiresAt: Date;
          stepUpIssuedAt: Date | null;
          targetType: "artifact" | "run" | "import" | "tenant";
          targetId: string | null;
          summary: { blockers?: unknown };
        }>(
          `SELECT scope_fingerprint AS "scopeFingerprint", expires_at AS "expiresAt",
                  step_up_issued_at AS "stepUpIssuedAt", target_type AS "targetType", target_id AS "targetId", summary
             FROM deletion_previews
            WHERE preview_id = :previewId AND tenant_id = :tenantId
              AND actor_user_id = :actorUserId AND session_id = :sessionId
            FOR UPDATE`,
          {
            replacements: {
              previewId,
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              sessionId: actor.sessionId,
            },
            type: QueryTypes.SELECT,
            transaction,
          },
        );
        const preview = previews[0];
        if (
          !preview ||
          new Date(preview.expiresAt).getTime() <= now.getTime() ||
          preview.stepUpIssuedAt ||
          !/^[0-9a-f]{64}$/.test(preview.scopeFingerprint) ||
          !preview.summary ||
          !Array.isArray(preview.summary.blockers) ||
          preview.summary.blockers.length > 0
        ) {
          throw new ConflictException(
            "Podgląd wygasł, został już potwierdzony albo zawiera blokady; utwórz nowy podgląd",
          );
        }
        if (
          !(await canDeleteTarget({
            role: currentMembership.role,
            canDeleteData: currentMembership.canDeleteData,
            targetType: preview.targetType,
            targetId: preview.targetId,
            tenantId: actor.tenantId,
            userId: actor.userId,
            transaction,
          }))
        ) {
          throw new ForbiddenException("Operator może usunąć wyłącznie własny import");
        }
        const freshSnapshot = await loadPreviewSnapshot({
          targetType: preview.targetType,
          targetId: preview.targetId,
          tenantId: actor.tenantId,
          transaction,
        });
        if (
          previewFingerprint(actor.tenantId, freshSnapshot) !== preview.scopeFingerprint ||
          freshSnapshot.summary.blockers.length
        ) {
          throw new ConflictException("Dane zmieniły się od podglądu albo pojawiła się blokada; utwórz nowy podgląd");
        }
        const marked = await sequelize.query(
          `UPDATE deletion_previews SET step_up_issued_at = :now
            WHERE preview_id = :previewId AND step_up_issued_at IS NULL AND consumed_at IS NULL AND expires_at > :now
            RETURNING preview_id`,
          { replacements: { now, previewId }, type: QueryTypes.SELECT, transaction },
        );
        if (!marked.length) throw new ConflictException("Podgląd usuwania został już użyty; utwórz nowy podgląd");

        const token = await createDeletionStepUpGrant({
          actor,
          previewId,
          credentialRevision: currentUser.credentialRevision,
          scopeFingerprint: preview.scopeFingerprint,
          now,
          transaction,
          deletionGrantVersion: currentMembership.deletionGrantVersion,
        });
        await this.audit.record(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: "deletion.step_up.granted",
            resourceType: "deletion",
            resourceId: previewId,
            outcome: "succeeded",
            metadata: { scope: "data-delete", expiresAt: input.expiresAt.toISOString() },
          },
          transaction,
        );
        return token;
      },
    );
  }
}
