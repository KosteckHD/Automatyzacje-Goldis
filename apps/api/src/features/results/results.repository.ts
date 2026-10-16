import { Injectable } from "@nestjs/common";
import { isRunDeletionPending } from "../../contracts/deletion-barrier";
import { AutomationRun } from "../../infrastructure/database/db";

@Injectable()
export class ResultsRepository {
  isDeletionPending(runId: string) {
    return isRunDeletionPending(runId);
  }

  findRunForWorkerResult(runId: string) {
    return AutomationRun.findByPk(runId);
  }
}
