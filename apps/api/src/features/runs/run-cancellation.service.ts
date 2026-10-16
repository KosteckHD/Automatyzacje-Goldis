import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { AuditActorContext } from "../audit/public";
import { WorkerCodeForwarder } from "../interventions/public";
import { RunCancellationRepository } from "./run-cancellation.repository";
import { summarizeRun } from "./run-summary";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RunCancellationService {
  constructor(
    @Inject(RunCancellationRepository) private readonly repository: RunCancellationRepository,
    @Inject(WorkerCodeForwarder) private readonly codeForwarder: WorkerCodeForwarder,
  ) {}

  async cancel(runId: string, actor: AuditActorContext) {
    if (!uuidPattern.test(runId)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    const result = await this.repository.cancel(runId, actor);
    if (result.invalidatedChallengeId) await this.codeForwarder.invalidate(result.invalidatedChallengeId);
    return summarizeRun(result.run);
  }
}
