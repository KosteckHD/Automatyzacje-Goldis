"use strict";

async function main() {
  if (process.env.GOLDIS_RESTORE_MAINTENANCE !== "1" || process.env.APP_ENV !== "production") {
    throw new Error("RESTORE_MAINTENANCE_MODE_REQUIRED");
  }
  const { sequelize } = require("../dist/infrastructure/database/db.js");
  try {
    let tokenCount = 0;
    let mailCount = 0;
    await sequelize.transaction(async (transaction) => {
      const { QueryTypes } = require("sequelize");
      const tokens = await sequelize.query(
        `UPDATE account_recovery_tokens SET revoked_at = now()
          WHERE consumed_at IS NULL AND revoked_at IS NULL
          RETURNING token_id`, { type: QueryTypes.SELECT, transaction },
      );
      tokenCount = tokens.length;
      const messages = await sequelize.query(
        `UPDATE auth_mail_outbox SET status = 'cancelled', payload_ciphertext = NULL,
                payload_nonce = NULL, payload_auth_tag = NULL, lease_until = NULL, lease_owner = NULL,
                last_error_code = 'restore_snapshot_invalidated'
          WHERE status IN ('pending', 'processing')
          RETURNING mail_id`, { type: QueryTypes.SELECT, transaction },
      );
      mailCount = messages.length;
    });
    process.stdout.write(`RESTORE_RECOVERY_INVALIDATION_PASS revoked_tokens=${tokenCount} cancelled_messages=${mailCount}\n`);
  } finally {
    await sequelize.close();
  }
}

main().catch(() => {
  process.stderr.write("RESTORE_RECOVERY_INVALIDATION_FAILED\n");
  process.exitCode = 1;
});
