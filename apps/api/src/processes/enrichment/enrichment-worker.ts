import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { sequelize, configureDefaultDatabaseUrl } from "../../infrastructure/database/db";
import { RegistryEnrichmentJobRunner } from "../../features/enrichment/enrichment-job.runner";
import { createRegistryProviderFromEnvironment } from "../../features/enrichment/registry-provider.factory";
import { assertSequelizeRuntimeDatabaseRole } from "../../infrastructure/database/runtime-database-role";
import { loadEnrichmentWorkerRuntimeConfig } from "../../infrastructure/config";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const WORKER_ID = "registry-enrichment-worker";

function safePostgresFailureDetails(error: unknown): string {
  if (!error || typeof error !== "object") return "{}";
  const value = error as { original?: unknown; parent?: unknown };
  const cause = (value.original ?? value.parent ?? error) as Record<string, unknown>;
  const safeIdentifier = (candidate: unknown) => typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(candidate)
    ? candidate : undefined;
  const failure = typeof cause.message === "string"
    ? cause.message.match(/^permission denied for (table|sequence|schema|function) ([A-Za-z0-9_.-]{1,100})$/)
    : null;
  const details = {
    code: typeof cause.code === "string" && /^[0-9A-Z]{5}$/.test(cause.code) ? cause.code : undefined,
    schema: safeIdentifier(cause.schema),
    table: safeIdentifier(cause.table),
    column: safeIdentifier(cause.column),
    constraint: safeIdentifier(cause.constraint),
    permissionDenied: failure ? `${failure[1]}:${failure[2]}` : undefined,
  };
  return JSON.stringify(Object.fromEntries(Object.entries(details).filter(([, item]) => item !== undefined)));
}

export async function startEnrichmentWorker(): Promise<void> {
  const runtimeConfig = loadEnrichmentWorkerRuntimeConfig(process.env);
  configureDefaultDatabaseUrl(runtimeConfig.database.databaseUrl);
  const workerId = randomUUID();
  const provider = createRegistryProviderFromEnvironment(runtimeConfig.providerEnvironment);
  const runner = new RegistryEnrichmentJobRunner(provider);
  let stopping = false;
  let status: "disabled" | "ready" | "degraded" = provider ? "ready" : "disabled";
  let lastHeartbeat = 0;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  await sequelize.authenticate();
  await assertSequelizeRuntimeDatabaseRole(sequelize, runtimeConfig.database.expectedRole);
  const heartbeat = async (nextStatus = status) => {
    status = nextStatus;
    await sequelize.query(
      `INSERT INTO enrichment_worker_runtime_status (worker_id, status, provider_name, observed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (worker_id) DO UPDATE SET status = EXCLUDED.status,
         provider_name = EXCLUDED.provider_name, observed_at = EXCLUDED.observed_at`,
      { bind: [WORKER_ID, status, provider?.cacheNamespace ?? null] },
    );
    lastHeartbeat = Date.now();
  };
  await heartbeat();
  while (!stopping) {
    try {
      if (Date.now() - lastHeartbeat >= 10_000) await heartbeat(provider ? "ready" : "disabled");
      if (!await runner.processOne(workerId)) await wait(500);
    } catch (error) {
      status = "degraded";
      // Do not log provider bodies, row values, or connection strings.
      console.error("ENRICHMENT_WORKER_TICK_FAILED", safePostgresFailureDetails(error));
      await wait(1_000);
    }
  }
  await sequelize.query("DELETE FROM enrichment_worker_runtime_status WHERE worker_id = $1", { bind: [WORKER_ID] });
}

