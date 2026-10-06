import {
  canTransitionRunStatus,
  validateIdentityMatchV1,
  validateOcSnapshotV1,
  validateRunInputV1,
  validateRunResultV1,
  type AutomationErrorCodeV1,
  type IdentityMatchV1,
  type OcPolicy,
  type RunResultV1,
  type RunStatus,
} from "@goldis/core";
import { selectCurrentPolicies } from "./oc";
import type { Clock, IdentityLookupResult, IdentityProvider, PolicyLookupResult, PolicyProvider, RunRepository, WorkerRunContext } from "./ports";

export type PipelineResult =
  | Readonly<{
      kind: "draft_result";
      result: Exclude<RunResultV1, { outcome: "completed" }>;
      currentPolicies: readonly OcPolicy[];
      evaluatedAt: string;
    }>
  | Readonly<{ kind: "identity_review"; reason: "ambiguous" | "name_mismatch" | "missing_pesel" }>
  | Readonly<{ kind: "waiting_for_sms"; portal: "pzu" | "compensa" }>
  | Readonly<{ kind: "waiting_for_manual_data"; fieldCode: string }>
  | Readonly<{ kind: "failed"; errorCode: AutomationErrorCodeV1 }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "state_conflict" }>;

export type PipelineDependencies = Readonly<{
  identityProvider: IdentityProvider;
  policyProvider: PolicyProvider;
  repository: RunRepository;
  clock: Clock;
}>;

function comparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
}

function identityReviewReason(result: Extract<IdentityLookupResult, { kind: "identity_review" }>): "name_mismatch" | "missing_pesel" {
  return result.reason === "missing_expected_person" ? "name_mismatch" : result.reason;
}

/** Runs the deterministic worker orchestration; results are drafts and are not persisted as terminal outcomes. */
export async function runPipeline(runId: string, dependencies: PipelineDependencies, signal?: AbortSignal): Promise<PipelineResult> {
  const { identityProvider, policyProvider, repository, clock } = dependencies;
  let context = await repository.load(runId);
  if (!context || context.run.runId !== runId) return { kind: "failed", errorCode: "INPUT_INVALID" };

  const transition = async (next: RunStatus, errorCode?: AutomationErrorCodeV1): Promise<boolean> => {
    context = await repository.load(runId);
    if (!context || context.cancelRequested || signal?.aborted) return false;
    if (!canTransitionRunStatus(context.status, next)) return false;
    return repository.transition(runId, context.status, next, errorCode ?? null);
  };

  const stopIfCancelled = async (): Promise<boolean> => {
    context = await repository.load(runId);
    if (!context) return true;
    if (!context.cancelRequested && !signal?.aborted) return false;
    if (canTransitionRunStatus(context.status, "cancelled")) {
      await repository.transition(runId, context.status, "cancelled", null);
    }
    return true;
  };

  const fail = async (errorCode: AutomationErrorCodeV1): Promise<PipelineResult> => {
    context = await repository.load(runId);
    if (context && canTransitionRunStatus(context.status, "failed")) {
      await repository.transition(runId, context.status, "failed", errorCode);
    }
    return { kind: "failed", errorCode };
  };

  try {
    const run = validateRunInputV1(context.run);
    if (run.sourceRowId !== context.source.id || !context.source.effectiveRegon || run.referenceDate !== context.run.referenceDate) {
      return fail("INPUT_INVALID");
    }
  } catch {
    return fail("INPUT_INVALID");
  }

  if (context.status === "awaiting_portal_adapter") {
    if (await stopIfCancelled()) return { kind: "cancelled" };
    if (!(await transition("pzu_login"))) return { kind: "state_conflict" };
  }
  if (await stopIfCancelled()) return { kind: "cancelled" };

  let identity: IdentityMatchV1;
  if (context.status === "pzu_login" || context.status === "everest_search") {
    context = (await repository.load(runId))!;
    let identityResult: IdentityLookupResult;
    try {
      identityResult = await identityProvider.findIdentity(context, signal);
    } catch {
      if (await stopIfCancelled()) return { kind: "cancelled" };
      return fail("PORTAL_FAILURE");
    }
    if (await stopIfCancelled()) return { kind: "cancelled" };
    if (identityResult.kind === "waiting_for_sms") {
      if (context.status !== "pzu_login" || !(await transition("waiting_for_sms"))) return { kind: "state_conflict" };
      return { kind: "waiting_for_sms", portal: "pzu" };
    }
    if (context.status === "pzu_login" && !(await transition("everest_search"))) return { kind: "state_conflict" };

    if (identityResult.kind === "not_found") return fail("IDENTITY_NOT_FOUND");
    if (identityResult.kind === "ambiguous") {
      if (!(await transition("identity_review"))) return { kind: "state_conflict" };
      return { kind: "identity_review", reason: "ambiguous" };
    }
    if (identityResult.kind === "identity_review") {
      if (!(await transition("identity_review"))) return { kind: "state_conflict" };
      return { kind: "identity_review", reason: identityReviewReason(identityResult) };
    }

    try {
      identity = validateIdentityMatchV1(identityResult.identity);
    } catch {
      return fail("INPUT_INVALID");
    }
    if (identity.sourceRowId !== context.source.id
      || identity.regon !== context.source.effectiveRegon
      || comparable(identity.companyName) !== comparable(context.source.companyName)) {
      return fail("INPUT_INVALID");
    }
    if (context.source.decisionMakerName
      && comparable(`${identity.firstName} ${identity.lastName}`) !== comparable(context.source.decisionMakerName)) {
      if (!(await transition("identity_review"))) return { kind: "state_conflict" };
      return { kind: "identity_review", reason: "name_mismatch" };
    }
    await repository.saveIdentity(runId, identity);
    if (await stopIfCancelled()) return { kind: "cancelled" };
    if (!(await transition("compensa_login"))) return { kind: "state_conflict" };
  } else if (context.status === "compensa_login" && context.identity) {
    try {
      identity = validateIdentityMatchV1(context.identity);
    } catch {
      return fail("INPUT_INVALID");
    }
    if (identity.sourceRowId !== context.source.id
      || identity.regon !== context.source.effectiveRegon
      || comparable(identity.companyName) !== comparable(context.source.companyName)
      || (context.source.decisionMakerName
        && comparable(`${identity.firstName} ${identity.lastName}`) !== comparable(context.source.decisionMakerName))) {
      return fail("INPUT_INVALID");
    }
  } else {
    return { kind: "state_conflict" };
  }
  if (await stopIfCancelled()) return { kind: "cancelled" };

  context = (await repository.load(runId))!;
  let policyResult: PolicyLookupResult;
  try {
    policyResult = await policyProvider.verifyAndReadOc(context, identity, signal);
  } catch {
    return fail("PORTAL_FAILURE");
  }
  if (await stopIfCancelled()) return { kind: "cancelled" };
  if (policyResult.kind === "waiting_for_sms") {
    if (!(await transition("waiting_for_sms"))) return { kind: "state_conflict" };
    return { kind: "waiting_for_sms", portal: "compensa" };
  }
  if (policyResult.kind === "waiting_for_manual_data") {
    if (!(await transition("compensa_form")) || !(await transition("waiting_for_manual_data"))) return { kind: "state_conflict" };
    return { kind: "waiting_for_manual_data", fieldCode: policyResult.fieldCode };
  }
  if (policyResult.kind === "portal_error") return fail(policyResult.errorCode);

  if (!(await transition("compensa_form"))
    || !(await transition("ufg_verification"))
    || !(await transition("reading_oc"))) return { kind: "state_conflict" };

  let snapshot;
  try {
    snapshot = validateOcSnapshotV1(policyResult.snapshot);
  } catch {
    return fail("UFG_INCOMPLETE");
  }
  const currentPolicies = selectCurrentPolicies(snapshot.policies, context.run.referenceDate);
  const result = validateRunResultV1({
    schemaVersion: 1,
    runId: context.run.runId,
    referenceDate: context.run.referenceDate,
    outcome: currentPolicies.length > 0 ? "export_ready" as const : "no_matching_policies" as const,
    totalOcCount: snapshot.totalCount,
    currentOcCount: currentPolicies.length,
    artifactId: null,
  });
  if (result.outcome === "completed") return fail("INPUT_INVALID");
  const now = clock.now();
  if (!Number.isFinite(now.getTime())) return fail("INPUT_INVALID");
  return {
    kind: "draft_result",
    result,
    currentPolicies,
    evaluatedAt: now.toISOString(),
  };
}
