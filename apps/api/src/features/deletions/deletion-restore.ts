import { QueryTypes, type Transaction } from "sequelize";
import { loadApiRuntimeConfig } from "../../infrastructure/config";
import { sequelize } from "../../infrastructure/database/db";
import { purgeImportResultsPreservingOtherAssignees } from "../leads/public";
import { configuredArtifactRoot } from "../results/public";
import { removePrivateArtifact } from "./deletion-artifacts";
import { type DeletionJournalEntry, readDeletionJournal } from "./deletion-journal";

const zeroHash = "0".repeat(64);

type JournalState = Readonly<{ appliedSequence: string; appliedHash: string }>;
type ArtifactFile = Readonly<{ artifactId: string; storageKey: string }>;

function fail(code: string): never {
  throw new Error(code);
}

async function journalState(transaction?: Transaction) {
  const rows = await sequelize.query<JournalState>(
    `SELECT applied_sequence AS "appliedSequence", applied_hash AS "appliedHash"
       FROM deletion_journal_state WHERE singleton_id = true ${transaction ? "FOR UPDATE" : ""}`,
    { type: QueryTypes.SELECT, transaction },
  );
  const state = rows[0];
  if (!state) fail("DELETION_RESTORE_STATE_MISSING");
  return state;
}

function assertJournalPrefix(entries: readonly DeletionJournalEntry[], state: JournalState): number {
  const sequence = Number(state.appliedSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > entries.length)
    fail("DELETION_RESTORE_JOURNAL_ROLLBACK");
  const expectedHash = sequence === 0 ? zeroHash : entries[sequence - 1]?.hash;
  if (!expectedHash || state.appliedHash !== expectedHash) fail("DELETION_RESTORE_HEAD_MISMATCH");
  return sequence;
}

async function filesFor(entry: DeletionJournalEntry): Promise<ArtifactFile[]> {
  return sequelize.query<ArtifactFile>(
    `SELECT ea.artifact_id AS "artifactId", ea.storage_key AS "storageKey"
       FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id
       JOIN import_batches b ON b.id = r.batch_id
      WHERE b.tenant_id = :tenantId AND (
        (:targetType = 'artifact' AND ea.artifact_id = :targetId)
        OR (:targetType = 'run' AND r.id = :targetId)
        OR (:targetType = 'import' AND b.id = :targetId))
      ORDER BY ea.artifact_id`,
    { replacements: entry, type: QueryTypes.SELECT },
  );
}

async function removeFiles(entry: DeletionJournalEntry, files: readonly ArtifactFile[]): Promise<void> {
  const keys = new Set(files.map((file) => file.storageKey));
  if (entry.targetType === "artifact") keys.add(`artifacts/${entry.targetId}.xlsx`);
  if (keys.size === 0) return;
  const root = configuredArtifactRoot();
  for (const key of keys) await removePrivateArtifact(root, key);
}

async function purgeTarget(entry: DeletionJournalEntry, transaction: Transaction): Promise<void> {
  if (entry.targetType === "artifact") {
    await sequelize.query(
      `DELETE FROM export_artifacts ea USING automation_runs r, import_batches b
        WHERE ea.run_id = r.id AND r.batch_id = b.id AND b.tenant_id = :tenantId AND ea.artifact_id = :targetId`,
      { replacements: entry, type: QueryTypes.DELETE, transaction },
    );
    const remaining = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM export_artifacts ea JOIN automation_runs r ON r.id = ea.run_id
         JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId AND ea.artifact_id = :targetId`,
      { replacements: entry, type: QueryTypes.SELECT, transaction },
    );
    if (Number(remaining[0]?.count ?? 0) !== 0) fail("DELETION_RESTORE_TARGET_REMAINS");
    return;
  }
  if (entry.targetType === "run") {
    await sequelize.query(
      `DELETE FROM automation_runs r USING import_batches b
        WHERE r.batch_id = b.id AND b.tenant_id = :tenantId AND r.id = :targetId`,
      { replacements: entry, type: QueryTypes.DELETE, transaction },
    );
    const remaining = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
        WHERE b.tenant_id = :tenantId AND r.id = :targetId`,
      { replacements: entry, type: QueryTypes.SELECT, transaction },
    );
    if (Number(remaining[0]?.count ?? 0) !== 0) fail("DELETION_RESTORE_TARGET_REMAINS");
    return;
  }
  if (entry.targetType === "import") {
    await purgeImportResultsPreservingOtherAssignees(entry.tenantId, entry.targetId, transaction);
    await sequelize.query("DELETE FROM import_batches WHERE tenant_id = :tenantId AND id = :targetId", {
      replacements: entry,
      type: QueryTypes.DELETE,
      transaction,
    });
    const remaining = await sequelize.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM import_batches WHERE tenant_id = :tenantId AND id = :targetId",
      { replacements: entry, type: QueryTypes.SELECT, transaction },
    );
    if (Number(remaining[0]?.count ?? 0) !== 0) fail("DELETION_RESTORE_TARGET_REMAINS");
    return;
  }
  fail("DELETION_RESTORE_SCOPE_UNSUPPORTED");
}

/** Replays only journal entries newer than the DB's recorded head. Run with every app/worker stopped. */
export async function applyPendingDeletionJournal(): Promise<{ appliedEntries: number; headSequence: number }> {
  if (!loadApiRuntimeConfig().deletionRestoreMaintenance) fail("DELETION_RESTORE_MAINTENANCE_REQUIRED");
  const entries = await readDeletionJournal();
  let sequence = assertJournalPrefix(entries, await journalState());
  const pending = entries.slice(sequence);
  for (const entry of pending) {
    if (
      entry.sequence !== sequence + 1 ||
      entry.previousHash !== (sequence === 0 ? zeroHash : entries[sequence - 1]?.hash)
    ) {
      fail("DELETION_RESTORE_JOURNAL_GAP");
    }
    const files = await filesFor(entry);
    await removeFiles(entry, files);
    await sequelize.transaction(async (transaction) => {
      const current = await journalState(transaction);
      if (
        Number(current.appliedSequence) !== sequence ||
        current.appliedHash !== (sequence === 0 ? zeroHash : entries[sequence - 1]?.hash)
      ) {
        fail("DELETION_RESTORE_STATE_CHANGED");
      }
      await purgeTarget(entry, transaction);
      const updated = await sequelize.query(
        `UPDATE deletion_journal_state SET applied_sequence = :sequence, applied_hash = :hash, updated_at = :now
          WHERE singleton_id = true AND applied_sequence = :previousSequence AND applied_hash = :previousHash
          RETURNING applied_sequence`,
        {
          replacements: {
            sequence: entry.sequence,
            hash: entry.hash,
            now: new Date(),
            previousSequence: sequence,
            previousHash: entry.previousHash,
          },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (!updated.length) fail("DELETION_RESTORE_STATE_CHANGED");
    });
    sequence = entry.sequence;
  }
  return { appliedEntries: pending.length, headSequence: sequence };
}
