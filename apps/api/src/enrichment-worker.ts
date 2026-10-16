/** Compatibility process entry point used by Compose and the package scripts. */
import { sequelize } from "./infrastructure/database/db";
import { startEnrichmentWorker } from "./processes/enrichment/enrichment-worker";

if (require.main === module) {
  void startEnrichmentWorker()
    .catch(async () => {
      console.error("ENRICHMENT_WORKER_START_FAILED");
      await sequelize.close().catch(() => undefined);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (process.exitCode !== 1) await sequelize.close().catch(() => undefined);
    });
}
