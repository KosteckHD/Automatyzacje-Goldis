import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { SessionPrincipal } from "../auth/public";
import { deletionIdempotencyPattern, deletionJobIdPattern, safeJob } from "./deletion-jobs.contract";
import { DeletionJobsRepository } from "./deletion-jobs.repository";
import { hashDeletionStepUpToken } from "./deletion-step-up";

@Injectable()
export class DeletionJobsService {
  constructor(@Optional() @Inject(DeletionJobsRepository) private readonly repository = new DeletionJobsRepository()) {}

  async get(actor: SessionPrincipal, jobId: string) {
    if (!deletionJobIdPattern.test(jobId)) throw new NotFoundException();
    const rows = await this.repository.findJob(jobId, actor.tenantId);
    const row = rows[0];
    if (!row) throw new NotFoundException();
    const membership = await this.repository.findMembership(actor.tenantId, actor.userId);
    if (row.actorUserId !== actor.userId && membership?.role !== "admin") throw new NotFoundException();
    const fileCounts = await this.repository.countJobFiles(jobId);
    return safeJob(row, Number(fileCounts.total ?? 0), Number(fileCounts.removed ?? 0));
  }

  async list(actor: SessionPrincipal) {
    const membership = await this.repository.findMembership(actor.tenantId, actor.userId);
    if (!membership) throw new NotFoundException();
    const rows = await this.repository.listJobs(actor.tenantId, actor.userId, membership.role === "admin");
    return {
      items: rows.map((row) => safeJob(row, Number(row.fileCount ?? 0), Number(row.filesRemoved ?? 0))),
    };
  }

  async create(actor: SessionPrincipal, input: unknown) {
    if (!actor.sessionId) throw new ForbiddenException();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new BadRequestException("Nieprawidłowe zlecenie usuwania");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["previewId", "stepUpToken", "idempotencyKey"].includes(key))) {
      throw new BadRequestException("Nieprawidłowe zlecenie usuwania");
    }
    const previewId =
      typeof body.previewId === "string" && deletionJobIdPattern.test(body.previewId)
        ? body.previewId.toLowerCase()
        : null;
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && deletionIdempotencyPattern.test(body.idempotencyKey)
        ? body.idempotencyKey
        : null;
    const token = typeof body.stepUpToken === "string" && body.stepUpToken.length <= 128 ? body.stepUpToken : null;
    const grantMatch = token && /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/i.exec(token);
    if (!previewId || !idempotencyKey || !token || !grantMatch || !deletionJobIdPattern.test(grantMatch[1])) {
      throw new BadRequestException("Wymagany jest podgląd, klucz idempotencji i potwierdzenie hasłem");
    }
    const tokenHash = hashDeletionStepUpToken(token);
    const now = new Date();
    const jobId = randomUUID();
    return this.repository.createJob({
      actor,
      sessionId: actor.sessionId,
      previewId,
      idempotencyKey,
      token,
      tokenHash,
      grantId: grantMatch[1],
      now,
      jobId,
    });
  }
}
