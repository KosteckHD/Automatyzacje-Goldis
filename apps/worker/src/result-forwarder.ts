import type { IdentityMatchV1, OcSnapshotV1 } from "@goldis/core";
import type { RunExecutionLease } from "./execution-lease";

export type PersistedRunOutcome = "completed" | "no_matching_policies";

/** Sends only a validated result to the private API; never writes its body to logs or queues. */
export class WorkerResultForwarder {
  private readonly baseUrl: URL;
  private readonly secret: string;
  private readonly origin: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const configured = environment.WORKER_RESULT_API_URL;
    const secret = environment.WORKER_AUTH_SECRET;
    const origin = environment.PUBLIC_APP_ORIGIN;
    if (!configured || !secret || secret.length < 32 || !origin) throw new Error("WORKER_RESULT_CONFIG_INVALID");
    const url = new URL(configured);
    const originUrl = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || originUrl.origin !== origin || !["http:", "https:"].includes(originUrl.protocol)) {
      throw new Error("WORKER_RESULT_CONFIG_INVALID");
    }
    this.baseUrl = url;
    this.secret = secret;
    this.origin = origin;
  }

  async store(runId: string, identity: IdentityMatchV1, snapshot: OcSnapshotV1, lease: RunExecutionLease): Promise<PersistedRunOutcome> {
    return this.post(runId, { identity, snapshot }, lease);
  }

  async finalize(runId: string, lease: RunExecutionLease): Promise<PersistedRunOutcome> {
    return this.post(runId, {}, lease);
  }

  private async post(runId: string, body: object, lease: RunExecutionLease): Promise<PersistedRunOutcome> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error("RUN_ID_INVALID");
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!lease || lease.runId !== runId || !uuid.test(lease.executionId) || !uuid.test(lease.workerSessionId)) {
      throw new Error("WORKER_RESULT_EXECUTION_INVALID");
    }
    const url = new URL(this.baseUrl);
    url.pathname = `/api/internal/worker-runs/${runId}/result`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.secret}`,
          origin: this.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, execution: { executionId: lease.executionId, workerSessionId: lease.workerSessionId } }),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new Error("WORKER_RESULT_DELIVERY_UNCERTAIN");
    }
    if (!response.ok) throw new Error("WORKER_RESULT_REJECTED");
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("WORKER_RESULT_RESPONSE_INVALID");
    }
    const outcome = (result as { outcome?: unknown } | null)?.outcome;
    if (outcome !== "completed" && outcome !== "no_matching_policies") {
      throw new Error("WORKER_RESULT_RESPONSE_INVALID");
    }
    return outcome;
  }
}
