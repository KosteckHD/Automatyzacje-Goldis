import { createHash, randomUUID } from "node:crypto";
import { transitionRunStatus } from "@goldis/core";
import { AutomationRun, ExportArtifact, RunEvent, sequelize } from "./db";
import { configuredArtifactRoot, writeArtifactAtomically } from "./private-artifact-store";
import { exportRunWorkbook } from "./run-export";
import { assertWorkerExecution, WorkerExecutionConflict, type WorkerExecutionFence } from "./worker-execution";

export class ExportFinalizeError extends Error {
  constructor(readonly code: "RUN_NOT_FOUND" | "EXPORT_STATE_CONFLICT" | "ARTIFACT_INCONSISTENT" | "EXPORT_FAILED") {
    super(code);
    this.name = "ExportFinalizeError";
  }
}

type Workbook = NonNullable<Awaited<ReturnType<typeof exportRunWorkbook>>>;
export type ExportFinalizerOptions = Readonly<{
  execution?: WorkerExecutionFence;
  artifactRoot?: string;
  exportWorkbook?: (runId: string) => Promise<Workbook | null>;
  writeArtifact?: typeof writeArtifactAtomically;
  afterFilePublished?: (storageKey: string) => void | Promise<void>;
}>;

type FinalizedArtifact = Readonly<{
  artifactId: string;
  runId: string;
  fileName: string;
  storageKey: string;
  sha256: string;
  policyCount: number;
  state: "ready";
}>;

function artifactSummary(artifact: ExportArtifact): FinalizedArtifact {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    fileName: artifact.fileName,
    storageKey: artifact.storageKey,
    sha256: artifact.sha256,
    policyCount: artifact.policyCount,
    state: "ready",
  };
}

async function recordExportFailure(runId: string, execution?: WorkerExecutionFence): Promise<void> {
  try {
    await sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run || run.status !== "export_ready") return;
      assertWorkerExecution(run, execution, ["export_ready"]);
      const now = new Date();
      run.errorCode = "EXPORT_FAILED";
      run.currentStep = "export_ready";
      run.updatedAt = now;
      await run.save({ transaction });
      await RunEvent.create({
        runId,
        status: "export_ready",
        step: "export_failed",
        errorCode: "EXPORT_FAILED",
        metadata: {},
        createdAt: now,
      }, { transaction });
    });
  } catch {
    // Do not print the original exception or any workbook/identity fields.
  }
}

/** Publishes the workbook first; only a durable file can receive ready metadata and complete the run. */
export async function finalizeRunExport(runId: string, options: ExportFinalizerOptions = {}): Promise<FinalizedArtifact> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new ExportFinalizeError("RUN_NOT_FOUND");
  }
  try {
    const root = options.artifactRoot ?? configuredArtifactRoot();
    const exporter = options.exportWorkbook ?? exportRunWorkbook;
    const writer = options.writeArtifact ?? writeArtifactAtomically;
    return await sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new ExportFinalizeError("RUN_NOT_FOUND");
      assertWorkerExecution(run, options.execution, ["export_ready", "completed"]);

      if (run.status === "completed") {
        const readyArtifacts = await ExportArtifact.findAll({ where: { runId, state: "ready" }, transaction });
        if (readyArtifacts.length !== 1 || readyArtifacts[0].policyCount < 1) {
          throw new ExportFinalizeError("ARTIFACT_INCONSISTENT");
        }
        return artifactSummary(readyArtifacts[0]);
      }
      if (run.status !== "export_ready") throw new ExportFinalizeError("EXPORT_STATE_CONFLICT");

      const workbook = await exporter(runId);
      if (!workbook || workbook.runId !== runId || workbook.bytes.byteLength === 0
        || !Number.isSafeInteger(workbook.policyCount) || workbook.policyCount < 1) {
        throw new ExportFinalizeError("EXPORT_FAILED");
      }
      const artifactId = randomUUID();
      const stored = await writer(root, artifactId, workbook.bytes);
      await options.afterFilePublished?.(stored.storageKey);
      assertWorkerExecution(run, options.execution, ["export_ready"]);
      const sha256 = createHash("sha256").update(workbook.bytes).digest("hex");
      const now = new Date();
      const artifact = await ExportArtifact.create({
        artifactId,
        runId,
        fileName: workbook.fileName,
        storageKey: stored.storageKey,
        sha256,
        policyCount: workbook.policyCount,
        state: "ready",
        createdAt: now,
        readyAt: now,
      }, { transaction });

      run.status = transitionRunStatus(run.status, "completed", { artifactId });
      run.currentStep = "completed";
      run.errorCode = null;
      run.finishedAt = now;
      run.updatedAt = now;
      await run.save({ transaction });
      await RunEvent.create({
        runId,
        status: "completed",
        step: "completed",
        errorCode: null,
        metadata: { artifactId, sha256, policyCount: workbook.policyCount },
        createdAt: now,
      }, { transaction });
      assertWorkerExecution(run, options.execution, ["completed"]);
      return artifactSummary(artifact);
    });
  } catch (error) {
    if (error instanceof WorkerExecutionConflict) throw error;
    if (error instanceof ExportFinalizeError
      && ["RUN_NOT_FOUND", "EXPORT_STATE_CONFLICT", "ARTIFACT_INCONSISTENT"].includes(error.code)) {
      throw error;
    }
    await recordExportFailure(runId, options.execution);
    throw new ExportFinalizeError("EXPORT_FAILED");
  }
}
