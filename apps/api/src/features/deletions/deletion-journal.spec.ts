import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendDeletionJournalIntent, DeletionJournalError, readDeletionJournal } from "./deletion-journal";

const intent = (suffix: string) => ({
  jobId: `11111111-1111-4111-8111-${suffix.repeat(12)}`,
  tenantId: "22222222-2222-4222-8222-222222222222",
  targetType: "import" as const,
  targetId: `33333333-3333-4333-8333-${suffix.repeat(12)}`,
});

test("dziennik kasowań dopisuje zsynchronizowany łańcuch bez danych osobowych", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-deletion-journal-"));
  try {
    const [first, second] = await Promise.all([
      appendDeletionJournalIntent(intent("a"), { directory, now: new Date("2026-10-09T10:00:00.000Z") }),
      appendDeletionJournalIntent(intent("b"), { directory, now: new Date("2026-10-09T10:00:01.000Z") }),
    ]);
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(second.previousHash, first.hash);
    assert.deepEqual(
      (await readDeletionJournal({ directory })).map((entry) => entry.jobId),
      [intent("a").jobId, intent("b").jobId],
    );

    const serialized = await readFile(join(directory, "deletion-journal.jsonl"), "utf8");
    assert.match(serialized, /"formatVersion":1/);
    assert.doesNotMatch(serialized, /NIP|REGON|PESEL|Acme|Jan Kowalski/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dziennik odrzuca podmianę, ucięcie łańcucha i brak klucza", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldis-deletion-journal-"));
  const journalFile = join(directory, "deletion-journal.jsonl");
  const keyFile = join(directory, "deletion-journal.key");
  try {
    await appendDeletionJournalIntent(intent("c"), { directory });
    const original = await readFile(journalFile, "utf8");
    const modified = original.replace(intent("c").targetId, intent("d").targetId);
    await writeFile(journalFile, modified, "utf8");
    await assert.rejects(
      readDeletionJournal({ directory }),
      (error: unknown) => error instanceof DeletionJournalError && error.code === "DELETION_JOURNAL_TAMPERED",
    );

    await writeFile(journalFile, `${original.trimEnd()}\n{`, "utf8");
    await assert.rejects(
      readDeletionJournal({ directory }),
      (error: unknown) => error instanceof DeletionJournalError && error.code === "DELETION_JOURNAL_TAMPERED",
    );

    await writeFile(journalFile, original, "utf8");
    await unlink(keyFile);
    await assert.rejects(
      readDeletionJournal({ directory }),
      (error: unknown) => error instanceof DeletionJournalError && error.code === "DELETION_JOURNAL_KEY_MISSING",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
