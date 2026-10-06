import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunJob } from "./run-queue";

test("kolejka produkcyjna przekazuje workerowi wyłącznie runId", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const dispatchId = "22222222-2222-4222-8222-222222222222";
  const job = createRunJob(runId, dispatchId);
  assert.deepEqual(job.data, { runId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(job.options.jobId, `dispatch-${dispatchId}`);
  assert.deepEqual(Object.keys(job.data), ["runId"]);
  assert.equal(JSON.stringify(job).includes("pesel"), false);
  assert.equal(JSON.stringify(job).includes("regon"), false);
});
