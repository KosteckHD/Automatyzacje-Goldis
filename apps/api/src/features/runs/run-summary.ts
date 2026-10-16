import type { AutomationRun } from "../../infrastructure/database/db";

export function summarizeRun(run: AutomationRun): Record<string, unknown> {
  return {
    id: run.id,
    batchId: run.batchId,
    rowNumber: run.rowNumber,
    toolId: run.toolId,
    status: run.status,
    currentStep: run.currentStep,
    referenceDate: run.referenceDate,
    errorCode: run.errorCode,
    manualDataVersion: run.manualDataVersion,
    controlState: run.controlState ?? "running",
    controlRevision: String(run.controlRevision ?? 0),
    controlAckRevision: String(run.controlAckRevision ?? 0),
    controlCheckpointStatus: run.controlCheckpointStatus ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
