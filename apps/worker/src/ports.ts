import type {
  AutomationErrorCodeV1,
  IdentityMatchV1,
  OcSnapshotV1,
  RunInputV1,
  RunStatus,
  SourceRow,
} from "@goldis/core";

/** Data the worker re-reads from PostgreSQL for a single run. */
export type WorkerRunContext = Readonly<{
  run: RunInputV1;
  source: SourceRow & { id: string };
  status: RunStatus;
  errorCode?: AutomationErrorCodeV1 | null;
  cancelRequested: boolean;
  identity: IdentityMatchV1 | null;
}>;

export type IdentityLookupResult =
  | Readonly<{ kind: "matched"; identity: IdentityMatchV1 }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ambiguous"; candidateCount: number }>
  | Readonly<{ kind: "identity_review"; reason: "name_mismatch" | "missing_pesel" | "missing_expected_person"; candidateCount: number }>
  | Readonly<{ kind: "waiting_for_sms"; portal: "pzu" }>;

export type PolicyLookupResult =
  | Readonly<{ kind: "snapshot"; snapshot: OcSnapshotV1 }>
  | Readonly<{ kind: "waiting_for_manual_data"; fieldCode: string }>
  | Readonly<{ kind: "waiting_for_sms"; portal: "compensa" }>
  | Readonly<{ kind: "portal_error"; errorCode: AutomationErrorCodeV1 }>;

/** Portal boundary. Implementations map portal screens into the shared contract. */
export interface IdentityProvider {
  findIdentity(context: WorkerRunContext, signal?: AbortSignal): Promise<IdentityLookupResult>;
}

/** Compensa/UFG boundary. Implementations return data, never raw page objects. */
export interface PolicyProvider {
  verifyAndReadOc(context: WorkerRunContext, identity: IdentityMatchV1, signal?: AbortSignal): Promise<PolicyLookupResult>;
}

/** Persistence boundary. Implementations must compare the expected state atomically. */
export interface RunRepository {
  load(runId: string): Promise<WorkerRunContext | null>;
  transition(runId: string, expected: RunStatus, next: RunStatus, errorCode?: AutomationErrorCodeV1 | null): Promise<boolean>;
  saveIdentity(runId: string, identity: IdentityMatchV1): Promise<void>;
}

export interface Clock {
  now(): Date;
}
