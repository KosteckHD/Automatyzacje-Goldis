import { Inject, Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";
import type { AutomationRun } from "../../infrastructure/database/db";
import { RunDispatchService } from "./run-dispatch.service";
import { RunRecoveryRepository } from "./run-recovery.repository";

@Injectable()
export class RunRecoveryService {
  constructor(
    @Inject(RunRecoveryRepository) private readonly repository: RunRecoveryRepository,
    @Inject(RunDispatchService) private readonly dispatch: RunDispatchService,
  ) {}

  async reconcile() {
    try {
      await this.ensureResultDispatches();
      await this.dispatch.recoverPublishedOutbox();
      await this.recoverOrphanRuns();
      await this.dispatch.publishOutbox();
    } catch {
      // The next interval retries. Do not include row data or Redis errors in logs.
      console.warn("RUN_QUEUE_RECONCILE_FAILED");
    }
  }

  async ensureResultDispatches() {
    await this.repository.transaction(async (transaction) => {
      const runs = await this.repository.findResultRuns(transaction, new Date());
      for (const run of runs) await this.dispatch.ensureDispatch(run.id, "result_delivery", transaction);
    });
  }

  async recoverOrphanRuns() {
    const now = new Date();
    const candidates = await this.repository.findOrphanCandidates(now);
    for (const candidate of candidates) {
      await this.repository.withRecoverableRun(candidate.id, async (run, transaction) => {
        await this.recoverRun(run, now, transaction);
      });
    }
  }

  private async recoverRun(run: AutomationRun, now: Date, transaction: Transaction) {
    const attemptCount = Number(run.technicalAttemptCount ?? 0);
    if (attemptCount >= 2) {
      await this.repository.requireManualReview(run, attemptCount, now, transaction);
      return;
    }
    const intent = run.status === "reading_oc" || run.status === "export_ready" ? "result_delivery" : "recovery";
    const nextAttemptCount = attemptCount + 1;
    const delayMs = attemptCount === 0 ? 5_000 : 15_000;
    await this.repository.scheduleRecovery(run, nextAttemptCount, intent, delayMs, now, transaction);
  }
}
