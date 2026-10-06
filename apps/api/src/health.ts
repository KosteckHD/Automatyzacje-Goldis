import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import Redis from "ioredis";
import { QueryTypes } from "sequelize";
import { sequelize } from "./db";
import { automationReadiness, type WorkerRuntimeStatus } from "./health-readiness";

type RuntimeStatus = WorkerRuntimeStatus;

@Controller("health")
export class HealthController {
  private async redisAvailable(): Promise<boolean> {
    if (!process.env.REDIS_URL) return false;
    const redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true, connectTimeout: 1_500, maxRetriesPerRequest: 1,
      enableOfflineQueue: false, retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    try { await redis.connect(); return (await redis.ping()) === "PONG"; }
    catch { return false; }
    finally { await redis.quit().catch(() => redis.disconnect()); }
  }

  @Get()
  live() {
    return { status: "ok", service: "goldis-api" };
  }

  @Get("live")
  liveness() {
    return { status: "alive", service: "goldis-api" };
  }

  @Get("ready")
  async readiness(@Res() response: Response) {
    const checks = { database: false, redis: false };
    try { await sequelize.authenticate(); checks.database = true; } catch { /* safe status only */ }
    checks.redis = await this.redisAvailable();
    const ready = checks.database && checks.redis;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ready ? "ready" : "not_ready", checks,
    });
  }

  @Get("automation")
  async automation(@Res() response: Response) {
    let servicesReady = false;
    let worker: RuntimeStatus | null = null;
    try {
      await sequelize.authenticate();
      servicesReady = await this.redisAvailable();
      if (!servicesReady) throw new Error("REDIS_UNAVAILABLE");
      if (servicesReady) {
        const rows = await sequelize.query<RuntimeStatus>(
          `SELECT mode, portal_config_valid AS "portalConfigValid", observed_at AS "observedAt"
           FROM worker_runtime_status WHERE worker_id = 'portal-worker' LIMIT 1`,
          { type: QueryTypes.SELECT },
        );
        worker = rows[0] ?? null;
      }
    } catch { servicesReady = false; }
    const result = automationReadiness({ servicesReady, worker });
    response.status(result.servicesReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(result);
  }

}
