import {
  canTransitionRunStatus,
  policyMatchesDate,
  validateOcSnapshotV1,
  validateRunResultV1,
  type OcPolicy,
  type RunResultV1,
  type RunStatus,
} from "@goldis/core";
import { AutomationRun, OcPolicyRecord, OcSnapshot, RunEvent, sequelize } from "./db";
import { assertWorkerExecution, WorkerExecutionConflict, type WorkerExecutionFence } from "./worker-execution";

export class RunEvaluationError extends Error {
  constructor(readonly code: "RUN_NOT_FOUND" | "SNAPSHOT_NOT_FOUND" | "SNAPSHOT_INCOMPLETE" | "RESULT_STATE_CONFLICT" | "RESULT_EVALUATION_FAILED") {
    super(code);
    this.name = "RunEvaluationError";
  }
}

function toPolicy(record: OcPolicyRecord): OcPolicy {
  return {
    sourceOrdinal: record.sourceOrdinal,
    insuredName: record.insuredName,
    policyTypeAndNumber: record.policyTypeAndNumber,
    contractType: record.contractType,
    insuredClaimCount: record.insuredClaimCount,
    vehicleRegistration: record.vehicleRegistration,
    vehicleGroup: record.vehicleGroup,
    vehicleMake: record.vehicleMake,
    vehicleModel: record.vehicleModel,
    insurer: record.insurer,
    coverageFrom: record.coverageFrom,
    coverageTo: record.coverageTo,
  };
}

/** Evaluates only a complete persisted snapshot and atomically checkpoints the result state. */
export async function evaluateStoredSnapshot(runId: string, execution?: WorkerExecutionFence): Promise<RunResultV1> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new RunEvaluationError("RUN_NOT_FOUND");
  }
  try {
    return await sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new RunEvaluationError("RUN_NOT_FOUND");
      assertWorkerExecution(run, execution, ["reading_oc", "export_ready", "no_matching_policies"]);
      const snapshot = await OcSnapshot.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!snapshot) throw new RunEvaluationError("SNAPSHOT_NOT_FOUND");
      const rows = await OcPolicyRecord.findAll({
        where: { runId },
        order: [["sourceOrdinal", "ASC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (rows.length !== snapshot.totalCount) throw new RunEvaluationError("SNAPSHOT_INCOMPLETE");

      const policies = rows.map(toPolicy);
      try {
        validateOcSnapshotV1({
          schemaVersion: 1,
          totalCount: snapshot.totalCount,
          policies,
          capturedAt: snapshot.capturedAt.toISOString(),
          parserVersion: snapshot.parserVersion,
        });
      } catch {
        throw new RunEvaluationError("SNAPSHOT_INCOMPLETE");
      }

      const currentOcCount = policies.filter((policy) => policyMatchesDate(policy, run.referenceDate)).length;
      const nextStatus: RunStatus = currentOcCount > 0 ? "export_ready" : "no_matching_policies";
      if (run.status !== nextStatus) {
        if (run.status !== "reading_oc" || !canTransitionRunStatus(run.status, nextStatus)) {
          throw new RunEvaluationError("RESULT_STATE_CONFLICT");
        }
        const now = new Date();
        run.status = nextStatus;
        run.currentStep = nextStatus;
        run.errorCode = null;
        run.updatedAt = now;
        if (nextStatus === "no_matching_policies") run.finishedAt = now;
        await run.save({ transaction });
        await RunEvent.create({
          runId,
          status: nextStatus,
          step: nextStatus,
          errorCode: null,
          metadata: { totalOcCount: snapshot.totalCount, currentOcCount, referenceDate: run.referenceDate },
          createdAt: now,
        }, { transaction });
      }

      assertWorkerExecution(run, execution, ["export_ready", "no_matching_policies"]);
      return validateRunResultV1({
        schemaVersion: 1,
        runId,
        referenceDate: run.referenceDate,
        outcome: currentOcCount > 0 ? "export_ready" : "no_matching_policies",
        totalOcCount: snapshot.totalCount,
        currentOcCount,
        artifactId: null,
      });
    });
  } catch (error) {
    if (error instanceof RunEvaluationError || error instanceof WorkerExecutionConflict) throw error;
    throw new RunEvaluationError("RESULT_EVALUATION_FAILED");
  }
}
