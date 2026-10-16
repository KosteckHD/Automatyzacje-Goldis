import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCancelPreparationRequest, parseStartPreparationRequest } from "./preparations.dto";

function isBadRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "getStatus" in error &&
    typeof error.getStatus === "function" &&
    error.getStatus() === 400
  );
}

test("start preparation request accepts the established idempotency key format", () => {
  assert.deepEqual(parseStartPreparationRequest({ idempotencyKey: "preparation-key-123456" }), {
    idempotencyKey: "preparation-key-123456",
  });
});

test("start preparation request rejects malformed and additional fields", () => {
  for (const value of [
    null,
    [],
    {},
    { idempotencyKey: "short" },
    { idempotencyKey: "preparation-key-123456", unexpected: true },
  ]) {
    assert.throws(() => parseStartPreparationRequest(value), isBadRequest);
  }
});

test("cancel preparation request accepts only a positive safe expected version", () => {
  assert.deepEqual(parseCancelPreparationRequest({ expectedVersion: 3 }), { expectedVersion: 3 });
  for (const value of [
    null,
    [],
    {},
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { expectedVersion: 1, extra: true },
  ]) {
    assert.throws(() => parseCancelPreparationRequest(value), isBadRequest);
  }
});
