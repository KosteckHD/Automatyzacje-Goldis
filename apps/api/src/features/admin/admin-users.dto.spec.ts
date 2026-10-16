import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import {
  parseAdminCreateUserInput,
  parseAdminRevokeToolGrantInput,
  parseAdminSetDeletionGrantInput,
  parseAdminSetToolGrantInput,
} from "./admin-users.dto";

test("admin create-user DTO preserves its supported fields and role", () => {
  assert.deepEqual(
    parseAdminCreateUserInput({
      username: "  example  ",
      password: "strong-password-for-test-only",
      role: "operator",
      confirmationToken: "synthetic-confirmation",
      idempotencyKey: "synthetic-request-id",
    }),
    {
      username: "  example  ",
      password: "strong-password-for-test-only",
      role: "operator",
      confirmationToken: "synthetic-confirmation",
      idempotencyKey: "synthetic-request-id",
    },
  );
});

test("admin create-user DTO rejects unknown fields and unsupported roles", () => {
  assert.throws(
    () =>
      parseAdminCreateUserInput({
        username: "example",
        password: "strong-password-for-test-only",
        role: "operator",
        tenantId: "foreign",
      }),
    BadRequestException,
  );
  assert.throws(
    () =>
      parseAdminCreateUserInput({
        username: "example",
        password: "strong-password-for-test-only",
        role: "root",
      }),
    BadRequestException,
  );
});

test("admin grant DTOs validate strict payloads and imply discovery for executable tools", () => {
  assert.deepEqual(
    parseAdminSetToolGrantInput({
      canDiscover: false,
      canExecute: true,
      canViewResults: false,
      canDownloadResults: false,
      expectedVersion: 0,
      confirmationToken: "synthetic-confirmation",
      idempotencyKey: "synthetic-request-id",
    }),
    {
      canDiscover: true,
      canExecute: true,
      canViewResults: false,
      canDownloadResults: false,
      expectedVersion: 0,
      confirmationToken: "synthetic-confirmation",
      idempotencyKey: "synthetic-request-id",
    },
  );
  assert.deepEqual(parseAdminSetDeletionGrantInput({ canDeleteData: true, expectedVersion: 3 }), {
    canDeleteData: true,
    expectedVersion: 3,
    confirmationToken: undefined,
    idempotencyKey: undefined,
  });
  assert.deepEqual(parseAdminRevokeToolGrantInput({ expectedVersion: 1 }), {
    expectedVersion: 1,
    confirmationToken: undefined,
    idempotencyKey: undefined,
  });
  assert.throws(() => parseAdminSetToolGrantInput({ canExecute: "yes", expectedVersion: -1 }), BadRequestException);
  assert.throws(
    () => parseAdminSetDeletionGrantInput({ canDeleteData: false, expectedVersion: 0, extra: true }),
    BadRequestException,
  );
});
