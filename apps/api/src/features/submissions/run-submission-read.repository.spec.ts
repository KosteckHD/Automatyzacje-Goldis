import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AutomationRun,
  configureDefaultDatabaseUrl,
  type RunSubmission,
  RunSubmissionGroup,
  RunSubmissionItem,
  sequelize,
} from "../../infrastructure/database/db";
import { RunSubmissionReadRepository } from "./run-submission-read.repository";

test("a skipped payer prompt is settled separately from failures and does not hold the next row", async () => {
  // Model methods are replaced below; this loopback URL is never connected to.
  configureDefaultDatabaseUrl("postgresql://synthetic:synthetic@127.0.0.1:1/synthetic");
  const original = {
    items: RunSubmissionItem.findAll,
    groups: RunSubmissionGroup.findAll,
    runs: AutomationRun.findAll,
  };
  let nextStatus = "queued";
  try {
    RunSubmissionItem.findAll = async () =>
      [
        { preparationState: "ready", groupId: "skip" },
        { preparationState: "ready", groupId: "next" },
      ] as never;
    RunSubmissionGroup.findAll = async () =>
      [
        { groupId: "skip", runId: "skipped-run", admissionState: "accepted" },
        { groupId: "next", runId: "next-run", admissionState: "accepted" },
      ] as never;
    AutomationRun.findAll = async () =>
      [
        { id: "skipped-run", status: "failed", errorCode: "COMPENSA_PAYER_DATA_SKIPPED" },
        { id: "next-run", status: nextStatus, errorCode: null },
      ] as never;
    const repository = new RunSubmissionReadRepository();
    const submission = { submissionId: "synthetic", status: "running" } as RunSubmission;
    const running = await repository.countState(submission);
    assert.equal(running.status, "running");
    assert.equal(running.itemCounts.skipped, 1);
    assert.equal(running.itemCounts.failed, 0);
    assert.equal(running.itemCounts.waiting_attention, 0);
    assert.equal(running.groupCounts.skipped, 1);
    nextStatus = "completed";
    const done = await repository.countState(submission);
    assert.equal(done.status, "completed");
    assert.equal(done.itemCounts.completed, 1);
    assert.equal(done.itemCounts.skipped, 1);
    assert.equal(done.groupCounts.failed, 0);
  } finally {
    RunSubmissionItem.findAll = original.items;
    RunSubmissionGroup.findAll = original.groups;
    AutomationRun.findAll = original.runs;
    await sequelize.close();
  }
});
