import { canTransitionRunStatus, type AutomationErrorCodeV1, type IdentityMatchV1, type RunStatus } from "@goldis/core";
import type { Clock, RunRepository, WorkerRunContext } from "../ports";

export type MemoryRunEvent = Readonly<{
  status: RunStatus;
  step: RunStatus;
  errorCode: AutomationErrorCodeV1 | null;
  createdAt: string;
}>;

/** Test double: checkpoint state and event list are committed together in one synchronous section. */
export class MemoryRunRepository implements RunRepository {
  private state: WorkerRunContext;
  private eventRecords: MemoryRunEvent[] = [];
  private failNextCheckpoint = false;

  constructor(initial: WorkerRunContext, private readonly clock: Clock) {
    this.state = { ...initial };
  }

  async load(runId: string): Promise<WorkerRunContext | null> {
    return this.state.run.runId === runId ? { ...this.state } : null;
  }

  async transition(
    runId: string,
    expected: RunStatus,
    next: RunStatus,
    errorCode: AutomationErrorCodeV1 | null = null,
  ): Promise<boolean> {
    if (runId !== this.state.run.runId || expected !== this.state.status || !canTransitionRunStatus(expected, next)) return false;
    if (this.failNextCheckpoint) {
      this.failNextCheckpoint = false;
      throw new Error("SIMULATED_CHECKPOINT_FAILURE");
    }

    const createdAt = this.clock.now().toISOString();
    const nextState: WorkerRunContext = { ...this.state, status: next };
    const nextEvents = [...this.eventRecords, { status: next, step: next, errorCode, createdAt }];
    // No await or callback separates these assignments; test readers observe the previous or new checkpoint.
    this.state = nextState;
    this.eventRecords = nextEvents;
    return true;
  }

  async saveIdentity(runId: string, identity: IdentityMatchV1): Promise<void> {
    if (runId !== this.state.run.runId) throw new Error("RUN_NOT_FOUND");
    this.state = { ...this.state, identity };
  }

  failNextTransitionBeforeCommit(): void {
    this.failNextCheckpoint = true;
  }

  events(): readonly MemoryRunEvent[] {
    return this.eventRecords.map((event) => ({ ...event }));
  }
}
