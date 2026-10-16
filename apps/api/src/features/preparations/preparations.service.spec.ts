import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditService } from "../audit/public";
import type { ImportPreparationsRepository } from "./preparations.repository";
import { ImportPreparationService } from "./preparations.service";

function isBadRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "getStatus" in error &&
    typeof error.getStatus === "function" &&
    error.getStatus() === 400
  );
}

test("ImportPreparationService validates untrusted start and cancel bodies before touching persistence", async () => {
  const service = new ImportPreparationService(
    { record: async () => undefined } as unknown as AuditService,
    {} as ImportPreparationsRepository,
  );
  const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const preparationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const actor = {
    tenantId: "99999999-9999-4999-8999-999999999999",
    userId: "11111111-1111-4111-8111-111111111111",
    role: "admin" as const,
  };

  await assert.rejects(service.start(batchId, { idempotencyKey: "short" }, actor), isBadRequest);
  await assert.rejects(
    service.start(batchId, { idempotencyKey: "valid-preparation-key-1234", extra: true }, actor),
    isBadRequest,
  );
  await assert.rejects(service.cancel(batchId, preparationId, { expectedVersion: 0 }, actor), isBadRequest);
  await assert.rejects(
    service.cancel(batchId, preparationId, { expectedVersion: 1, extra: true }, actor),
    isBadRequest,
  );
});
