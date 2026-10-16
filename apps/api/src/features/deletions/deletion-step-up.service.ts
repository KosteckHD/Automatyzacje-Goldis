import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { SessionPrincipal } from "../auth";
import { verifyPassword } from "../auth";
import { canRequestDeletionStepUp, deletionStepUpLifetimeMs } from "./deletion-step-up";
import type { DeletionStepUpResponseDto } from "./deletion-step-up.dto";
import { DeletionStepUpRepository } from "./deletion-step-up.repository";

/** Re-authentication use case for an already-authorized deletion preview. */
@Injectable()
export class DeletionStepUpService {
  constructor(@Inject(DeletionStepUpRepository) private readonly repository: DeletionStepUpRepository) {}

  async request(input: {
    actor: SessionPrincipal;
    previewId: string;
    currentPassword: string;
  }): Promise<DeletionStepUpResponseDto> {
    if (!input.actor.sessionId) throw new UnauthorizedException();
    const identity = await this.repository.findIdentity(input.actor.userId, input.actor.tenantId);
    if (!identity) throw new ForbiddenException("Brak odrębnego uprawnienia do usuwania danych");
    if (!canRequestDeletionStepUp(identity.role, identity.canDeleteData) && identity.role !== "operator") {
      throw new ForbiddenException("Brak odrębnego uprawnienia do usuwania danych");
    }
    if (!(await verifyPassword(input.currentPassword, identity.passwordHash))) {
      throw new UnauthorizedException("Nieprawidłowe obecne hasło");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + deletionStepUpLifetimeMs);
    const stepUpToken = await this.repository.issueGrant({
      actor: input.actor,
      previewId: input.previewId,
      expectedPasswordHash: identity.passwordHash,
      expectedCredentialRevision: identity.credentialRevision,
      now,
      expiresAt,
    });
    return { stepUpToken, expiresAt: expiresAt.toISOString() };
  }
}
