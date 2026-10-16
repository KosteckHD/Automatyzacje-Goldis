import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConflictResolutionRequest, parseCorrectionDecisionRequest } from "./review.dto";

function isBadRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "getStatus" in error &&
    typeof error.getStatus === "function" &&
    error.getStatus() === 400
  );
}

test("review decision DTO accepts the supported correction decision", () => {
  assert.deepEqual(
    parseCorrectionDecisionRequest({
      decision: "approved",
      expectedRowVersion: 4,
      reasonCode: "REGISTRY_MATCH_VERIFIED",
    }),
    { decision: "approved", expectedRowVersion: 4, reasonCode: "REGISTRY_MATCH_VERIFIED" },
  );
});

test("review decision DTO rejects unknown fields, invalid versions, and invalid correction reasons", () => {
  for (const value of [
    null,
    { decision: "approved", expectedRowVersion: 4 },
    { decision: "approved", expectedRowVersion: 0, reasonCode: "OTHER" },
    { decision: "approved", expectedRowVersion: 4, reasonCode: "OTHER", extra: true },
  ])
    assert.throws(() => parseCorrectionDecisionRequest(value), isBadRequest);
});

test("conflict resolution DTO enforces action-specific fields and reason codes", () => {
  assert.deepEqual(
    parseConflictResolutionRequest({
      action: "link_existing",
      expectedRowVersion: 3,
      reasonCode: "IDENTIFIERS_VERIFIED",
      canonicalEntityId: "99999999-9999-4999-8999-999999999999",
    }),
    {
      action: "link_existing",
      expectedRowVersion: 3,
      reasonCode: "IDENTIFIERS_VERIFIED",
      canonicalEntityId: "99999999-9999-4999-8999-999999999999",
    },
  );
  for (const value of [
    { action: "recheck", expectedRowVersion: 3, reasonCode: "IDENTIFIERS_VERIFIED" },
    { action: "link_existing", expectedRowVersion: 3, reasonCode: "IDENTIFIERS_VERIFIED" },
    {
      action: "reject_link",
      expectedRowVersion: 3,
      reasonCode: "CANDIDATE_REJECTED",
      canonicalEntityId: "99999999-9999-4999-8999-999999999999",
    },
  ])
    assert.throws(() => parseConflictResolutionRequest(value), isBadRequest);
});
