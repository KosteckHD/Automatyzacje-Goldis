import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictException } from "@nestjs/common";
import { ResultsService } from "./results.service";

test("ResultsService blocks result processing while deletion is pending", async () => {
  let readCount = 0;
  const service = new ResultsService({
    async isDeletionPending() {
      return true;
    },
    async findRunForWorkerResult() {
      readCount += 1;
      return null;
    },
  } as never);

  await assert.rejects(
    service.acceptWorkerResult("run-id", {} as never, null, null),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.equal(readCount, 0);
});

test("ResultsService refuses results for runs outside the checkpoint states", async () => {
  const service = new ResultsService({
    async isDeletionPending() {
      return false;
    },
    async findRunForWorkerResult() {
      return { status: "cancelled" };
    },
  } as never);

  await assert.rejects(
    service.acceptWorkerResult("run-id", {} as never, null, null),
    (error: unknown) => error instanceof ConflictException,
  );
});
