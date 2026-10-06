import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAuditMetadataSafe } from "./audit";

test("audyt przyjmuje wyłącznie płaskie metadane techniczne", () => {
  assert.doesNotThrow(() => assertAuditMetadataSafe({ rowNumber: 18001, retry: true, reasonCode: "USER_CANCELLED" }));
  assert.throws(() => assertAuditMetadataSafe({ PESEL: "synthetic-only" }), /SENSITIVE_KEY/);
  assert.throws(() => assertAuditMetadataSafe({ details: { email: "synthetic@example.invalid" } }), /VALUE_INVALID/);
  assert.throws(() => assertAuditMetadataSafe([{ attemptCount: 1 }]), /MUST_BE_AN_OBJECT/);
  assert.throws(() => assertAuditMetadataSafe({ count: Number.NaN }), /VALUE_INVALID/);
});
