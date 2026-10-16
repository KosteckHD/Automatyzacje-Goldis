import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { EnrichmentJobsRepository } from "./enrichment-jobs.repository";
import { EnrichmentJobService } from "./enrichment-jobs.service";

test("EnrichmentJobService validates route identity and selected rows before opening a transaction", async () => {
  let transactions = 0;
  const repository = {
    transaction: async () => {
      transactions += 1;
      throw new Error("transaction should not be reached");
    },
  } as unknown as EnrichmentJobsRepository;
  const service = new EnrichmentJobService(repository);
  const actor = { tenantId: "tenant-a", userId: "user-a", role: "admin" } as const;

  await assert.rejects(service.start("invalid", {} as never, actor), NotFoundException);
  await assert.rejects(
    service.start(
      "10000000-0000-4000-8000-000000000001",
      { idempotencyKey: "valid-idempotency-key-01", rowNumbers: [] },
      actor,
    ),
    BadRequestException,
  );
  assert.equal(transactions, 0);
});

test("EnrichmentJobService rejects malformed cancellation versions before opening a transaction", async () => {
  let transactions = 0;
  const repository = {
    transaction: async () => {
      transactions += 1;
      throw new Error("transaction should not be reached");
    },
  } as unknown as EnrichmentJobsRepository;
  const service = new EnrichmentJobService(repository);
  const actor = { tenantId: "tenant-a", userId: "user-a", role: "admin" } as const;

  await assert.rejects(service.cancel("job-id", { expectedVersion: 0 }, actor), BadRequestException);
  assert.equal(transactions, 0);
});
