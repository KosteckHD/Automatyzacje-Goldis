import { QueryTypes, type Transaction } from "sequelize";
import { sequelize } from "../../infrastructure/database/db";
import { readDeletionJournal } from "./deletion-journal";

const zeroHash = "0".repeat(64);

export async function assertDeletionJournalApplied(transaction?: Transaction): Promise<void> {
  const entries = await readDeletionJournal();
  const head = entries.at(-1);
  const rows = await sequelize.query<{ appliedSequence: string; appliedHash: string }>(
    `SELECT applied_sequence AS "appliedSequence", applied_hash AS "appliedHash"
       FROM deletion_journal_state WHERE singleton_id = true ${transaction ? "FOR UPDATE" : ""}`,
    { type: QueryTypes.SELECT, transaction },
  );
  const state = rows[0];
  const expectedSequence = head?.sequence ?? 0;
  const expectedHash = head?.hash ?? zeroHash;
  if (!state || Number(state.appliedSequence) !== expectedSequence || state.appliedHash !== expectedHash) {
    throw new Error("DELETION_RESTORE_REPLAY_REQUIRED");
  }
}
