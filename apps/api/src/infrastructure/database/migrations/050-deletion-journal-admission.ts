import { DataTypes, type QueryInterface } from "sequelize";

/** Stores the journal head known to the database so a stale restore cannot be admitted. */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.transaction(async (transaction) => {
    await context.createTable("deletion_journal_state", {
      singleton_id: { type: DataTypes.BOOLEAN, primaryKey: true, allowNull: false, defaultValue: true },
      applied_sequence: { type: DataTypes.BIGINT, allowNull: false, defaultValue: "0" },
      applied_hash: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "0".repeat(64) },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await context.sequelize.query(
      `ALTER TABLE deletion_journal_state
         ADD CONSTRAINT deletion_journal_state_singleton CHECK (singleton_id = true),
         ADD CONSTRAINT deletion_journal_state_sequence_valid CHECK (applied_sequence >= 0),
         ADD CONSTRAINT deletion_journal_state_hash_valid CHECK (applied_hash ~ '^[0-9a-f]{64}$');
       INSERT INTO deletion_journal_state (singleton_id, applied_sequence, applied_hash, updated_at)
         VALUES (true, 0, '${"0".repeat(64)}', now())`,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error("DELETION_JOURNAL_ADMISSION_HISTORY_IS_NOT_SAFE_TO_REVERSE");
}
