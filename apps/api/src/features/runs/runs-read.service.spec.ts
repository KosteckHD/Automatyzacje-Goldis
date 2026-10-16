import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { AutomationRun } from "../../infrastructure/database/db";
import type { RunsReadRepository } from "./runs-read.repository";
import { RunsReadService } from "./runs-read.service";

const runId = "11111111-1111-4111-8111-111111111111";
const artifactDownloadStub = { download: async () => null } as never;

test("RunsReadService rejects malformed IDs before repository access", async () => {
  let calls = 0;
  const service = new RunsReadService(
    {
      findByBatch: async () => {
        calls += 1;
        return [];
      },
    } as unknown as RunsReadRepository,
    artifactDownloadStub,
  );
  await assert.rejects(service.list("invalid"), BadRequestException);
  await assert.rejects(service.get("invalid"), BadRequestException);
  assert.equal(calls, 0);
});

test("RunsReadService maps run lists to the existing public summary contract", async () => {
  const createdAt = new Date("2026-10-16T10:00:00.000Z");
  const run = {
    id: runId,
    batchId: "22222222-2222-4222-8222-222222222222",
    rowNumber: 2,
    toolId: "oc-policy-verification",
    status: "queued",
    currentStep: "queued",
    referenceDate: "2026-10-16",
    errorCode: null,
    manualDataVersion: 0,
    controlState: null,
    controlRevision: null,
    controlAckRevision: null,
    controlCheckpointStatus: null,
    createdAt,
    updatedAt: createdAt,
  } as unknown as AutomationRun;
  const repository = { findByBatch: async () => [run] } as unknown as RunsReadRepository;
  const result = await new RunsReadService(repository, artifactDownloadStub).list(run.batchId);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: runId,
    batchId: run.batchId,
    rowNumber: 2,
    toolId: "oc-policy-verification",
    status: "queued",
    currentStep: "queued",
    referenceDate: "2026-10-16",
    errorCode: null,
    manualDataVersion: 0,
    controlState: "running",
    controlRevision: "0",
    controlAckRevision: "0",
    controlCheckpointStatus: null,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  });
});

test("RunsReadService hides deleted and missing runs with the existing not-found contract", async () => {
  const hidden = new RunsReadService(
    { isDeletionPending: async () => true } as unknown as RunsReadRepository,
    artifactDownloadStub,
  );
  const missing = new RunsReadService(
    {
      isDeletionPending: async () => false,
      findRun: async () => null,
    } as unknown as RunsReadRepository,
    artifactDownloadStub,
  );
  await assert.rejects(hidden.get(runId), NotFoundException);
  await assert.rejects(missing.get(runId), NotFoundException);
});

test("RunsReadService delegates artifact retrieval to the Results feature", async () => {
  let requestedId = "";
  const expected = { fileName: "result.xlsx", bytes: Buffer.from("synthetic"), sha256: "a".repeat(64) };
  const service = new RunsReadService(
    {} as RunsReadRepository,
    {
      download: async (id: string) => {
        requestedId = id;
        return expected;
      },
    } as never,
  );
  assert.equal(await service.downloadArtifact(runId), expected);
  assert.equal(requestedId, runId);
});
