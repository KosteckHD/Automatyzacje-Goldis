import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { sequelize } from "./db";
import { RegistryEnrichmentJobRunner } from "./enrichment-jobs";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const workerId = randomUUID();
  // No provider is selected by default. A concrete, authorized adapter must be
  // supplied before live lookups can be enabled; queued work then fails safely.
  const runner = new RegistryEnrichmentJobRunner(null);
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  await sequelize.authenticate();
  while (!stopping) {
    try {
      if (!await runner.processOne(workerId)) await wait(500);
    } catch {
      // Do not log provider bodies, row values, or connection strings.
      console.error("ENRICHMENT_WORKER_TICK_FAILED");
      await wait(1_000);
    }
  }
}

void main().catch(async () => {
  console.error("ENRICHMENT_WORKER_START_FAILED");
  await sequelize.close().catch(() => undefined);
  process.exitCode = 1;
}).finally(async () => {
  if (process.exitCode !== 1) await sequelize.close().catch(() => undefined);
});
