import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { parseRunSubmissionSelection, runSubmissionRequestHash } from "./run-submission.dto";

test("run submission selection normalizes explicit rows and inclusive ranges", () => {
  assert.deepEqual(parseRunSubmissionSelection({ rowNumbers: [8, 2, 5] }), { rowNumbers: [2, 5, 8] });
  assert.deepEqual(parseRunSubmissionSelection({ fromRow: 3, toRow: 5 }), { rowNumbers: [3, 4, 5] });
});

test("run submission selection rejects ambiguous, duplicate, oversized, and extra input", () => {
  for (const input of [
    { rowNumbers: [2], fromRow: 2, toRow: 2 },
    { rowNumbers: [2, 2] },
    { rowNumbers: [1] },
    { fromRow: 2, toRow: 502 },
    { rowNumbers: [2], tenantId: "untrusted" },
  ]) {
    assert.throws(() => parseRunSubmissionSelection(input), BadRequestException);
  }
});

test("run submission idempotency hash is stable for normalized selection order", () => {
  const reversed = parseRunSubmissionSelection({ rowNumbers: [8, 2] });
  const sorted = parseRunSubmissionSelection({ rowNumbers: [2, 8] });
  assert.equal(runSubmissionRequestHash("batch-a", reversed), runSubmissionRequestHash("batch-a", sorted));
  assert.notEqual(
    runSubmissionRequestHash("batch-a", { rowNumbers: [2, 8] }),
    runSubmissionRequestHash("batch-b", { rowNumbers: [2, 8] }),
  );
});
