import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { parseCreatePrivilegedActionInput } from "./privileged-actions.dto";

const validInput = {
  action: "admin.user.password",
  targetId: "33333333-3333-4333-8333-333333333333",
  payload: { temporaryPassword: "Synthetic-new-password-2026!" },
  currentPassword: "Current-password-2026!",
  idempotencyKey: "44444444-4444-4444-8444-444444444444",
};

test("privileged action input parser returns only the bounded confirmation contract", () => {
  assert.deepEqual(parseCreatePrivilegedActionInput(validInput), validInput);
  assert.throws(() => parseCreatePrivilegedActionInput({ ...validInput, unexpected: true }), BadRequestException);
  assert.throws(
    () => parseCreatePrivilegedActionInput({ ...validInput, idempotencyKey: "invalid" }),
    BadRequestException,
  );
  assert.throws(() => parseCreatePrivilegedActionInput({ ...validInput, payload: [] }), BadRequestException);
  assert.throws(
    () => parseCreatePrivilegedActionInput({ ...validInput, payload: { value: "x".repeat(17_000) } }),
    BadRequestException,
  );
  assert.throws(
    () => parseCreatePrivilegedActionInput({ ...validInput, currentPassword: "x".repeat(1025) }),
    BadRequestException,
  );
});
