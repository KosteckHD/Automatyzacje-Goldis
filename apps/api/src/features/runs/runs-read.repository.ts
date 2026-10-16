import { Injectable } from "@nestjs/common";
import { Op } from "sequelize";
import { isRunDeletionPending } from "../../contracts/deletion-barrier";
import {
  AutomationRun,
  ExportArtifact,
  ManualIntervention,
  OcPolicyRecord,
  OcSnapshot,
  RunEvent,
  RunManualDataOverride,
} from "../../infrastructure/database/db";

@Injectable()
export class RunsReadRepository {
  findByBatch(batchId: string) {
    return AutomationRun.findAll({ where: { batchId }, order: [["createdAt", "DESC"]], limit: 50 });
  }

  findRun(runId: string) {
    return AutomationRun.findByPk(runId);
  }

  isDeletionPending(runId: string) {
    return isRunDeletionPending(runId);
  }

  findSnapshot(runId: string) {
    return OcSnapshot.findByPk(runId);
  }

  countCurrentPolicies(runId: string, referenceDate: string) {
    return OcPolicyRecord.count({ where: { runId, coverageTo: { [Op.gte]: referenceDate } } });
  }

  findEvents(runId: string) {
    return RunEvent.findAll({
      where: { runId },
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
    });
  }

  findOpenIntervention(runId: string) {
    return ManualIntervention.findOne({ where: { runId, status: "open" }, order: [["createdAt", "DESC"]] });
  }

  findManualOverride(runId: string, version: number) {
    return RunManualDataOverride.findOne({ where: { runId, version } });
  }

  findReadyArtifact(runId: string) {
    return ExportArtifact.findOne({ where: { runId, state: "ready" } });
  }
}
