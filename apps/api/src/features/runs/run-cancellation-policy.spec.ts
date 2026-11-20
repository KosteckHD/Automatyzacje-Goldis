import assert from "node:assert/strict";
import { test } from "node:test";
import { canCancelAbandonedSms } from "./run-cancellation-policy";

const now = new Date("2026-11-19T10:00:00Z");
const abandoned = { status: "waiting_for_manual_data", errorCode: "SMS_RETRY_REQUIRED", lastSafeStep: null,
  externalCaseRef: null, leaseExpiresAt: null };

test("an expired pre-case SMS login can be closed, including uncertain code delivery", () => {
  assert.equal(canCancelAbandonedSms(abandoned, now), true);
  assert.equal(canCancelAbandonedSms({ ...abandoned, errorCode: "SMS_DELIVERY_UNCERTAIN",
    leaseExpiresAt: new Date(now.getTime() - 1) }, now), true);
});

test("cancellation preserves live execution, portal cases and non-SMS reconciliation", () => {
  for (const patch of [
    { status: "compensa_form" }, { status: "completed" }, { errorCode: "PORTAL_FAILURE" },
    { lastSafeStep: "compensa_offer_draft_open" }, { externalCaseRef: "synthetic-case" },
    { leaseExpiresAt: new Date(now.getTime() + 1) },
  ]) assert.equal(canCancelAbandonedSms({ ...abandoned, ...patch }, now), false, JSON.stringify(patch));
});
