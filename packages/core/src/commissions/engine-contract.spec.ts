import assert from "node:assert/strict";
import test from "node:test";
import {
  CommissionEngineContractError,
  validateCommissionEngineRequestV1,
  validateCommissionEngineResultV1,
} from "./engine-contract";

test("commission engine request rejects non-allowlisted sources and malformed file hashes", () => {
  assert.throws(() => validateCommissionEngineRequestV1({
    schemaVersion: 1, requestId: "r1", executionId: "e1", attemptToken: "t1", engineVersion: "v1",
    start: "2026-06-01", end: "2026-09-30", preset: {},
    files: [{ sourceType: "Other", fileName: "a.xlsx", sha256: "bad", contentBase64: "YQ==" }],
  }), CommissionEngineContractError);
});

test("commission result enforces unambiguous complete policy counters", () => {
  const valid = {
    schema_version: 1, engine_version: "v1", request_id: "r1", execution_id: "e1", attempt_token: "t1",
    start: "2026-06-01", end: "2026-09-30", preset_version: "d1",
    summary: { policies: 2, missing_policies: 1, candidate_policies: 0, matched_policies: 1,
      wrong_rate_rows: 0, wrong_rate_policies: 0, checked_rate_rows: 1, unverified_rate_rows: 0,
      report_records: 1, duplicate_files: 0 },
    issues: [], unresolved: [], details: [], policies: [],
    reverse_audit: { crm_policies_all_dates: 2, report_record_status_counts: {}, rows: [], note: "synthetic" },
    warnings: [], assumptions: [],
  };
  assert.equal(validateCommissionEngineResultV1(valid).summary.policies, 2);
  assert.throws(() => validateCommissionEngineResultV1({ ...valid, summary: { ...valid.summary, matched_policies: 0 } }),
    CommissionEngineContractError);
  assert.throws(() => validateCommissionEngineResultV1({ ...valid, reverse_audit: [] }), CommissionEngineContractError);
});
