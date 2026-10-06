import assert from "node:assert/strict";
import { test } from "node:test";
import { canRetrySms } from "./sms-retry-policy";

test("SMS resend requires a recognized intervention and an unused PZU budget", () => {
  const timeout = { status: "waiting_for_manual_data", errorCode: "SMS_RETRY_REQUIRED", reasonCode: "SMS_TIMEOUT", portal: "pzu", retryCount: 0 };
  assert.equal(canRetrySms(timeout), true);
  const rejected = { ...timeout, status: "waiting_for_sms", errorCode: "SMS_CODE_REJECTED", reasonCode: "SMS_CODE_REJECTED" };
  assert.equal(canRetrySms(rejected), true);
  for (const input of [timeout, rejected]) {
    assert.equal(canRetrySms({ ...input, retryCount: 1 }), false);
    assert.equal(canRetrySms({ ...input, status: "cancelled" }), false);
    assert.equal(canRetrySms({ ...input, reasonCode: "SMS_DELIVERY_UNCERTAIN" }), false);
    assert.equal(canRetrySms({ ...input, reasonCode: "SMS_ATTEMPT_LIMIT" }), false);
    assert.equal(canRetrySms({ ...input, portal: null }), false);
  }
});
