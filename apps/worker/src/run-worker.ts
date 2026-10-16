export {
  createProductionRunProcessor,
  deliverStagedResult,
  recordProcessorFailure,
  safeStartupFailureCode,
  startRunWorker,
  validateAndParkRun,
} from "./application/worker-runtime";

import { safeStartupFailureCode, startRunWorker } from "./application/worker-runtime";

if (require.main === module) {
  startRunWorker().catch((error) => {
    console.error("RUN_WORKER_START_FAILED", safeStartupFailureCode(error));
    process.exitCode = 1;
  });
}
