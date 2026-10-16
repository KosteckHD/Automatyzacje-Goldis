import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("API admission fails closed until the database matches the verified journal head", async () => {
  process.env.DATABASE_URL ??= "postgres://goldis_journal_test:unused@127.0.0.1:1/goldis_journal_test";
  const directory = await mkdtemp(join(tmpdir(), "goldis-journal-admission-"));
  const previousJournalDir = process.env.GOLDIS_DELETION_JOURNAL_DIR;
  const previousExportDir = process.env.API_EXPORT_DIR;
  process.env.GOLDIS_DELETION_JOURNAL_DIR = directory;
  process.env.API_EXPORT_DIR = join(directory, "exports");

  const { sequelize } = await import("../../infrastructure/database/db");
  const { assertDeletionJournalApplied } = await import("./deletion-journal-admission");
  const { appendDeletionJournalIntent } = await import("./deletion-journal");
  const originalQuery = sequelize.query;
  let state = { appliedSequence: "0", appliedHash: "0".repeat(64) };
  (sequelize as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async () => [state];
  try {
    await assertDeletionJournalApplied();
    const entry = await appendDeletionJournalIntent({
      jobId: "11111111-1111-4111-8111-111111111111",
      tenantId: "22222222-2222-4222-8222-222222222222",
      targetType: "run",
      targetId: "33333333-3333-4333-8333-333333333333",
    });
    await assert.rejects(assertDeletionJournalApplied(), /DELETION_RESTORE_REPLAY_REQUIRED/);
    state = { appliedSequence: "1", appliedHash: entry.hash };
    await assertDeletionJournalApplied();
    state = { appliedSequence: "1", appliedHash: "f".repeat(64) };
    await assert.rejects(assertDeletionJournalApplied(), /DELETION_RESTORE_REPLAY_REQUIRED/);
  } finally {
    (sequelize as unknown as { query: unknown }).query = originalQuery;
    await sequelize.close();
    if (previousJournalDir === undefined) delete process.env.GOLDIS_DELETION_JOURNAL_DIR;
    else process.env.GOLDIS_DELETION_JOURNAL_DIR = previousJournalDir;
    if (previousExportDir === undefined) delete process.env.API_EXPORT_DIR;
    else process.env.API_EXPORT_DIR = previousExportDir;
    await rm(directory, { recursive: true, force: true });
  }
});
