"use strict";

if (process.env.GOLDIS_RESTORE_MAINTENANCE !== "1") {
  console.error("DELETION_RESTORE_MAINTENANCE_REQUIRED");
  process.exit(2);
}

const { sequelize } = require("../dist/infrastructure/database/db");
const { applyPendingDeletionJournal } = require("../dist/features/deletions/deletion-restore");

applyPendingDeletionJournal()
  .then(async (result) => {
    console.log(`DELETION_JOURNAL_REPLAY_PASS appliedEntries=${result.appliedEntries} headSequence=${result.headSequence}`);
    await sequelize.close();
  })
  .catch(async (error) => {
    const code = typeof error?.message === "string" && /^DELETION_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "DELETION_RESTORE_FAILED";
    console.error(code);
    await sequelize.close().catch(() => undefined);
    process.exitCode = 1;
  });
