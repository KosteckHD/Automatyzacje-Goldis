import assert from "node:assert/strict";
import { test } from "node:test";
import { isRunDispatchIntentV1, RUN_DISPATCH_INTENTS_V1 } from "./run-dispatch";

test("run dispatch contract validates the stable API-worker intent set", () => {
  assert.deepEqual(RUN_DISPATCH_INTENTS_V1, ["create", "resume_auth", "resume_review", "recovery", "result_delivery"]);
  for (const intent of RUN_DISPATCH_INTENTS_V1) assert.equal(isRunDispatchIntentV1(intent), true);
  assert.equal(isRunDispatchIntentV1("run"), false);
  assert.equal(isRunDispatchIntentV1(null), false);
});
