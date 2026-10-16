import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SessionPrincipal } from "../auth";
import { canDeleteTarget } from "./deletion-step-up";
import {
  type DeletionTargetType,
  deletionPreviewLifetimeMs,
  deletionTargetTypes,
  previewFingerprint,
} from "./deletions.contract";
import { DeletionsPreviewRepository } from "./deletions.repository";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DeletionsService {
  constructor(@Inject(DeletionsPreviewRepository) private readonly repository: DeletionsPreviewRepository) {}

  async preview(input: { actor: SessionPrincipal; body: unknown }) {
    const { actor, body: rawBody } = input;
    if (!actor.sessionId) throw new ForbiddenException();
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new BadRequestException("Nieprawidłowy podgląd usuwania");
    }
    const body = rawBody as Record<string, unknown>;
    if (
      Object.keys(body).some((key) => key !== "targetType" && key !== "targetId") ||
      typeof body.targetType !== "string" ||
      !deletionTargetTypes.includes(body.targetType as DeletionTargetType)
    ) {
      throw new BadRequestException("Nieprawidłowy zakres podglądu usuwania");
    }
    const targetType = body.targetType as DeletionTargetType;
    const targetId =
      targetType === "tenant"
        ? null
        : typeof body.targetId === "string" && uuidPattern.test(body.targetId)
          ? body.targetId.toLowerCase()
          : null;
    if ((targetType === "tenant" && body.targetId !== undefined) || (targetType !== "tenant" && !targetId)) {
      throw new BadRequestException("Zakres wymaga prawidłowego identyfikatora celu");
    }

    const membership = await this.repository.findMembership(actor.tenantId, actor.userId);
    if (!membership || (targetType === "tenant" && membership.role !== "admin")) {
      throw new ForbiddenException("Brak uprawnienia do tego zakresu usuwania");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + deletionPreviewLifetimeMs);
    const previewId = randomUUID();
    return this.repository.withRepeatableRead(async (transaction) => {
      const allowed = await canDeleteTarget({
        role: membership.role,
        canDeleteData: membership.canDeleteData,
        targetType,
        targetId,
        tenantId: actor.tenantId,
        userId: actor.userId,
        transaction,
      });
      if (!allowed) {
        if (membership.role === "operator") throw new NotFoundException();
        throw new ForbiddenException("Brak uprawnienia do tego zakresu usuwania");
      }

      const snapshot = await this.repository.loadSnapshot({
        targetType,
        targetId,
        tenantId: actor.tenantId,
        transaction,
      });
      const fingerprint = previewFingerprint(actor.tenantId, snapshot);
      await this.repository.replacePreview(
        {
          previewId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          sessionId: actor.sessionId as string,
          targetType,
          targetId,
          fingerprint,
          snapshot,
          now,
          expiresAt,
        },
        transaction,
      );
      return {
        previewId,
        targetType,
        targetId,
        summary: snapshot.summary,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        requiresStepUp: true,
      };
    });
  }
}
