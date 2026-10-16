import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transaction } from "sequelize";
import type { AuditEventInput, AuditRepository } from "./audit.repository";
import { AuditService } from "./audit.service";

test("AuditService preserves trusted actor context and transaction when delegating writes", async () => {
  const event = {
    tenantId: "99999999-9999-4999-8999-999999999999",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    action: "user.updated",
    resourceType: "user",
    resourceId: "22222222-2222-4222-8222-222222222222",
    outcome: "succeeded",
    metadata: { changed: true },
  } as const satisfies AuditEventInput;
  const transaction = { id: "synthetic-transaction" };
  let recorded: unknown;
  const service = new AuditService({
    record: async (input: AuditEventInput, currentTransaction?: Transaction) => {
      recorded = { input, transaction: currentTransaction };
    },
  } as unknown as AuditRepository);

  await service.record(event, transaction as never);
  assert.deepEqual(recorded, { input: event, transaction });
});
