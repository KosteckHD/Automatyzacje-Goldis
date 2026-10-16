import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { AuditService } from "../audit/public";
import type { EnrichmentJobService } from "../enrichment/public";
import type { ImportPreparationWorkflowsRepository } from "./preparation-workflows.repository";
import { ImportPreparationWorkflowService } from "./preparation-workflows.service";
import type { ImportPreparationService } from "./preparations.service";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  role: "admin" as const,
};

function createService() {
  return new ImportPreparationWorkflowService(
    {} as ImportPreparationService,
    {} as EnrichmentJobService,
    {} as AuditService,
    {} as ImportPreparationWorkflowsRepository,
  );
}

test("workflow start validates route identity and rejects malformed or extra body fields before persistence", async () => {
  const service = createService();
  const batchId = "33333333-3333-4333-8333-333333333333";
  const preparationId = "44444444-4444-4444-8444-444444444444";
  await assert.rejects(
    service.start("invalid", preparationId, { idempotencyKey: "synthetic-workflow-key-1234" }, actor),
    NotFoundException,
  );
  await assert.rejects(service.start(batchId, preparationId, { idempotencyKey: "short" }, actor), BadRequestException);
  await assert.rejects(
    service.start(
      batchId,
      preparationId,
      {
        idempotencyKey: "synthetic-workflow-key-1234",
        tenantId: actor.tenantId,
      },
      actor,
    ),
    BadRequestException,
  );
});
