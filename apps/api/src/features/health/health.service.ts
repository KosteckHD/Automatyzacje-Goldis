import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { QueryTypes } from "sequelize";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { sequelize } from "../../infrastructure/database/db";
import { assertDeletionJournalApplied } from "../deletions/public";
import { type EnrichmentWorkerRuntimeStatus, enrichmentWorkerHealth } from "./enrichment-worker-health";
import { probeApiReadiness } from "./health-probe";
import { automationReadiness, type WorkerRuntimeStatus } from "./health-readiness";

const readinessTtlMs = 3_000;
const probeTimeoutMs = 2_000;

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readinessCache: { ready: boolean; expiresAt: number } | null = null;
  private readinessFlight: Promise<boolean> | null = null;
  private redisClient: Redis | null = null;

  private async redisAvailable(): Promise<boolean> {
    const redisUrl = loadApiSecretConfig().redisUrl;
    if (!redisUrl) return false;
    let redis = this.redisClient;
    if (!redis || redis.status === "end") {
      redis = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 1_000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      redis.on("error", () => undefined);
      this.redisClient = redis;
    }
    try {
      if (redis.status === "wait") await redis.connect();
      if (redis.status !== "ready") return false;
      return (await redis.ping()) === "PONG";
    } catch {
      redis.disconnect();
      if (this.redisClient === redis) this.redisClient = null;
      return false;
    }
  }

  live() {
    return { status: "ok", service: "goldis-api" } as const;
  }

  liveness() {
    return { status: "alive", service: "goldis-api" } as const;
  }

  async readiness(): Promise<boolean> {
    const now = Date.now();
    if (this.readinessCache && this.readinessCache.expiresAt > now) return this.readinessCache.ready;
    if (this.readinessFlight) return this.readinessFlight;
    const flight = (async () => {
      const ready = await probeApiReadiness(
        {
          database: () => sequelize.authenticate(),
          redis: () => this.redisAvailable(),
          deletionJournal: () => assertDeletionJournalApplied(),
        },
        probeTimeoutMs,
      );
      this.readinessCache = { ready, expiresAt: Date.now() + readinessTtlMs };
      return ready;
    })();
    this.readinessFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.readinessFlight === flight) this.readinessFlight = null;
    }
  }

  async automation() {
    let servicesReady = false;
    let worker: WorkerRuntimeStatus | null = null;
    try {
      await sequelize.authenticate();
      servicesReady = await this.redisAvailable();
      if (!servicesReady) throw new Error("REDIS_UNAVAILABLE");
      const rows = await sequelize.query<WorkerRuntimeStatus>(
        `SELECT mode, portal_config_valid AS "portalConfigValid", observed_at AS "observedAt"
           FROM worker_runtime_status WHERE worker_id = 'portal-worker' LIMIT 1`,
        { type: QueryTypes.SELECT },
      );
      worker = rows[0] ?? null;
    } catch {
      servicesReady = false;
    }
    return automationReadiness({ servicesReady, worker });
  }

  async enrichment() {
    let worker: EnrichmentWorkerRuntimeStatus | null = null;
    try {
      await sequelize.authenticate();
      const rows = await sequelize.query<EnrichmentWorkerRuntimeStatus>(
        `SELECT status, provider_name AS "providerName", observed_at AS "observedAt"
           FROM enrichment_worker_runtime_status WHERE worker_id = 'registry-enrichment-worker' LIMIT 1`,
        { type: QueryTypes.SELECT },
      );
      worker = rows[0] ?? null;
    } catch {
      /* return status only; database details are private */
    }
    return enrichmentWorkerHealth({ worker });
  }

  async onModuleDestroy(): Promise<void> {
    const redis = this.redisClient;
    this.redisClient = null;
    if (!redis) return;
    try {
      await redis.quit();
    } catch {
      // Redis may already be unavailable while the application is stopping.
    } finally {
      redis.disconnect();
    }
  }
}
