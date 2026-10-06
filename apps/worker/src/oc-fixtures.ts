import { validateOcSnapshotV1, type IdentityMatchV1, type OcPolicy, type OcSnapshotV1 } from "@goldis/core";
import type { PolicyLookupResult, PolicyProvider, WorkerRunContext } from "./ports";

export type SyntheticUfgScenario =
  | "empty_fields"
  | "zero_policies"
  | "one_policy"
  | "many_policies"
  | "ufg_error"
  | "incomplete_table";

const completePolicy = (sourceOrdinal: number, coverageTo = "2027-01-01"): OcPolicy => ({
  sourceOrdinal,
  insuredName: "Ala Testowa",
  policyTypeAndNumber: `OC TEST-${sourceOrdinal}`,
  contractType: "OC",
  insuredClaimCount: 0,
  vehicleRegistration: `TEST${String(sourceOrdinal).padStart(3, "0")}`,
  vehicleGroup: "Samochód osobowy",
  vehicleMake: "Marka Testowa",
  vehicleModel: `Model ${sourceOrdinal}`,
  insurer: "Testowy Zakład Ubezpieczeń",
  coverageFrom: "2025-01-01",
  coverageTo,
});

const sparsePolicy: OcPolicy = {
  sourceOrdinal: 1,
  insuredName: null,
  policyTypeAndNumber: "OC TEST-SPARSE",
  contractType: null,
  insuredClaimCount: null,
  vehicleRegistration: null,
  vehicleGroup: null,
  vehicleMake: null,
  vehicleModel: null,
  insurer: null,
  coverageFrom: null,
  coverageTo: "2027-01-01",
};

function makeSnapshot(policies: readonly OcPolicy[]): OcSnapshotV1 {
  return validateOcSnapshotV1({
    schemaVersion: 1,
    totalCount: policies.length,
    policies,
    capturedAt: "2026-09-29T12:00:00.000Z",
    parserVersion: "synthetic-ufg-v1",
  });
}

/** Synthetic UFG/Compensa boundary. It returns normalized contracts and has no browser dependency. */
export class SyntheticPolicyProvider implements PolicyProvider {
  constructor(private readonly scenario: SyntheticUfgScenario) {}

  async verifyAndReadOc(_context: WorkerRunContext, _identity: IdentityMatchV1): Promise<PolicyLookupResult> {
    switch (this.scenario) {
      case "empty_fields":
        return { kind: "snapshot", snapshot: makeSnapshot([sparsePolicy]) };
      case "zero_policies":
        return { kind: "snapshot", snapshot: makeSnapshot([]) };
      case "one_policy":
        return { kind: "snapshot", snapshot: makeSnapshot([completePolicy(1)]) };
      case "many_policies":
        return {
          kind: "snapshot",
          snapshot: makeSnapshot([
            completePolicy(1, "2026-09-28"),
            completePolicy(2, "2026-09-29"),
            completePolicy(3, "2026-09-30"),
          ]),
        };
      case "ufg_error":
        return { kind: "portal_error", errorCode: "UFG_INCOMPLETE" };
      case "incomplete_table":
        // A real adapter must compare rendered rows with the summary count before returning a snapshot.
        return { kind: "portal_error", errorCode: "UFG_INCOMPLETE" };
    }
  }
}
