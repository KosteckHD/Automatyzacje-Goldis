import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from "@nestjs/common";
import { configuredArtifactRoot } from "../../infrastructure/artifacts/artifact-storage";
import { loadApiRuntimeConfig } from "../../infrastructure/config";
import { purgeImportResultsPreservingOtherAssignees } from "../leads/public";
import { removePrivateArtifact } from "./deletion-artifacts";
import { DeletionJobsRepository } from "./deletion-jobs.repository";

const leaseMs = 60_000;
const maxAttempts = 5;
const pollMs = 1_500;

@Injectable()
export class DeletionJobRunner implements OnModuleInit, OnModuleDestroy {
  private readonly leaseOwner = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(@Optional() @Inject(DeletionJobsRepository) private readonly repository = new DeletionJobsRepository()) {}

  onModuleInit() {
    if (!loadApiRuntimeConfig().deletionWorkerEnabled) return;
    this.timer = setInterval(() => {
      void this.processOne().catch(() => undefined);
    }, pollMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async processOne(now = new Date()): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      const job = await this.repository.claim(now, this.leaseOwner, leaseMs);
      if (!job) return false;
      try {
        const files = await this.repository.findPendingFiles(job.jobId);
        const root = configuredArtifactRoot();
        for (const file of files) {
          await removePrivateArtifact(root, file.storageKey);
          await this.repository.markFileRemoved(file.fileId, this.leaseOwner, new Date());
        }
        await this.repository.complete(
          job.jobId,
          this.leaseOwner,
          files.length,
          purgeImportResultsPreservingOtherAssignees,
        );
      } catch {
        await this.repository.recordFailure(
          job.jobId,
          this.leaseOwner,
          Number(job.attemptCount),
          new Date(),
          maxAttempts,
        );
      }
      return true;
    } finally {
      this.inFlight = false;
    }
  }
}
