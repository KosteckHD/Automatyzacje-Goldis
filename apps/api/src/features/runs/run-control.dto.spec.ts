import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { validateRunControlRequest } from "./run-control.dto";

test("run control DTO accepts a current revision and an idempotency key", () => {
  assert.deepEqual(validateRunControlRequest({ expectedRevision: "12", idempotencyKey: "pause-request-0001" }), {
    expectedRevision: "12",
    idempotencyKey: "pause-request-0001",
  });
});

test("run control DTO rejects extra fields, malformed revisions, and short keys", () => {
  for (const value of [
    { expectedRevision: "1", idempotencyKey: "pause-request-0001", extra: true },
    { expectedRevision: "01", idempotencyKey: "pause-request-0001" },
    { expectedRevision: "1", idempotencyKey: "short" },
  ]) {
    assert.throws(() => validateRunControlRequest(value), BadRequestException);
  }
});
