import type { IdentityMatchV1, OcSnapshotV1 } from "@goldis/core";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { assertWorkerExecution, type WorkerExecutionFence } from "../../contracts/worker-execution";
import { finalizeRunExport } from "./export-finalization.service";
import { persistOcSnapshot } from "./oc-snapshot.repository";
import { ResultsRepository } from "./results.repository";
import { evaluateStoredSnapshot } from "./run-evaluation.repository";

@Injectable()
export class ResultsService {
  constructor(@Inject(ResultsRepository) private readonly repository: ResultsRepository) {}

  async acceptWorkerResult(
    runId: string,
    execution: WorkerExecutionFence,
    identity: IdentityMatchV1 | null,
    snapshot: OcSnapshotV1 | null,
  ) {
    if (await this.repository.isDeletionPending(runId))
      throw new ConflictException("Wynik zadania nie jest już dostępny");
    const run = await this.repository.findRunForWorkerResult(runId);
    if (!run || !["reading_oc", "export_ready", "completed", "no_matching_policies"].includes(run.status)) {
      throw new ConflictException("Zadanie nie jest gotowe do zapisu wyniku");
    }
    assertWorkerExecution(run, execution, ["reading_oc", "export_ready", "completed", "no_matching_policies"]);
    if (identity && snapshot) await persistOcSnapshot(runId, identity, snapshot, { execution });
    const evaluated =
      run.status === "reading_oc"
        ? await evaluateStoredSnapshot(runId, execution)
        : run.status === "export_ready"
          ? { outcome: "export_ready" as const }
          : { outcome: run.status };
    if (evaluated.outcome === "export_ready") {
      await finalizeRunExport(runId, { execution });
      return { outcome: "completed", artifactAvailable: true };
    }
    return { outcome: evaluated.outcome, artifactAvailable: evaluated.outcome === "completed" };
  }
}
