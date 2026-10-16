import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { AuditActorContext } from "../audit";
import { RunAdmissionService } from "./run-admission.service";
import { RunCancellationService } from "./run-cancellation.service";
import type { RunControlRequest } from "./run-control.dto";
import { RunControlService } from "./run-control.service";
import { RunDispatchService } from "./run-dispatch.service";
import { RunRecoveryService } from "./run-recovery.service";
import { RunResumeService } from "./run-resume.service";
import { RunsReadService } from "./runs-read.service";

@Injectable()
export class RunService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(RunsReadService) private readonly runReads: RunsReadService,
    @Inject(RunDispatchService) private readonly dispatch: RunDispatchService,
    @Inject(RunAdmissionService) private readonly admission: RunAdmissionService,
    @Inject(RunCancellationService) private readonly cancellation: RunCancellationService,
    @Inject(RunControlService) private readonly control: RunControlService,
    @Inject(RunRecoveryService) private readonly recovery: RunRecoveryService,
    @Inject(RunResumeService) private readonly resume: RunResumeService,
  ) {}

  onModuleInit() {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 5_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get queue() {
    return this.dispatch.activeQueue;
  }

  ensureDispatch(
    runId: string,
    intentType: "create" | "resume_auth" | "resume_review" | "recovery" | "result_delivery",
    transaction: import("sequelize").Transaction,
  ) {
    return this.dispatch.ensureDispatch(runId, intentType, transaction);
  }

  publishOutbox() {
    return this.dispatch.publishOutbox();
  }

  private reconcile() {
    return this.recovery.reconcile();
  }

  create(batchId: string, rowNumber: number, actor: AuditActorContext & { sessionId?: string }) {
    return this.admission.create(batchId, rowNumber, actor);
  }

  async list(batchId: string) {
    return this.runReads.list(batchId);
  }

  async get(id: string, role: string | null = null, userId: string | null = null) {
    return this.runReads.get(id, role, userId);
  }

  async downloadArtifact(id: string) {
    return this.runReads.downloadArtifact(id);
  }

  resumeAuth(id: string, actor: AuditActorContext) {
    return this.resume.resumeAuth(id, actor);
  }

  resumeReview(id: string, actor: AuditActorContext) {
    return this.resume.resumeReview(id, actor);
  }
  async cancel(id: string, actor: AuditActorContext) {
    return this.cancellation.cancel(id, actor);
  }

  pause(id: string, actor: AuditActorContext, request: RunControlRequest) {
    return this.control.pause(id, actor, request);
  }

  resumePaused(id: string, actor: AuditActorContext, request: RunControlRequest) {
    return this.control.resumePaused(id, actor, request);
  }
}
