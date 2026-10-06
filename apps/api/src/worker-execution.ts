import type { RunStatus } from "@goldis/core";

export type WorkerExecutionFence = Readonly<{ executionId: string; workerSessionId: string }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkerExecutionConflict extends Error {
  constructor() { super("WORKER_EXECUTION_CONFLICT"); this.name = "WorkerExecutionConflict"; }
}

export function parseWorkerExecution(value: unknown): WorkerExecutionFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkerExecutionConflict();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || typeof input.executionId !== "string" || !uuid.test(input.executionId)
    || typeof input.workerSessionId !== "string" || !uuid.test(input.workerSessionId)) throw new WorkerExecutionConflict();
  return { executionId: input.executionId, workerSessionId: input.workerSessionId };
}

/** Call while holding the run row lock, and again before committing a long write. */
export function assertWorkerExecution(
  run: Readonly<{ status: RunStatus; executionId: string | null; workerSessionId: string | null; leaseExpiresAt: Date | null }>,
  execution: WorkerExecutionFence | undefined,
  allowedStatuses: readonly RunStatus[],
  now = Date.now(),
): void {
  // Internal import/reconciliation callers have no worker execution. HTTP always requires one.
  if (!execution) return;
  if (!allowedStatuses.includes(run.status) || run.executionId !== execution.executionId
    || run.workerSessionId !== execution.workerSessionId || !run.leaseExpiresAt
    || new Date(run.leaseExpiresAt).getTime() <= now || !Number.isFinite(new Date(run.leaseExpiresAt).getTime())) {
    throw new WorkerExecutionConflict();
  }
}
