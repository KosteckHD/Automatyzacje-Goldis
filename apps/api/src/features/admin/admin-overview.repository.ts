import { Injectable } from "@nestjs/common";
import { QueryTypes } from "sequelize";
import { sequelize, TenantMembership, Tool } from "../../infrastructure/database/db";
import { dateStringInWarsaw, secondsUntilNextWarsawDay } from "../../shared/warsaw-time";
import { type EnrichmentWorkerRuntimeStatus, enrichmentWorkerHealth } from "../health";

const activeRunStatuses = [
  "queued",
  "validating",
  "pzu_login",
  "everest_search",
  "compensa_login",
  "compensa_form",
  "ufg_verification",
  "reading_oc",
  "export_ready",
  "waiting_for_sms",
  "waiting_for_manual_data",
  "identity_review",
] as const;
const registryDailyLimits = { "mf-vat": 100, "gus-bir": 6_000 } as const;

@Injectable()
export class AdminOverviewRepository {
  async overviewCounts(tenantId: string) {
    const [userCount, toolCount, openInterventions, activeRuns] = await Promise.all([
      TenantMembership.count({ where: { tenantId, status: "active" } }),
      Tool.count(),
      sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM manual_interventions mi JOIN automation_runs r ON r.id = mi.run_id
           JOIN import_batches b ON b.id = r.batch_id WHERE b.tenant_id = :tenantId AND mi.status = 'open'`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
           WHERE b.tenant_id = :tenantId AND r.status IN (:activeStatuses)`,
        { replacements: { tenantId, activeStatuses: activeRunStatuses }, type: QueryTypes.SELECT },
      ),
    ]);
    return {
      userCount,
      toolCount,
      openInterventionCount: Number(openInterventions[0]?.count ?? 0),
      activeRunCount: Number(activeRuns[0]?.count ?? 0),
    };
  }

  async schemaVersion() {
    const [migrationRows, migrationCountRows] = await Promise.all([
      sequelize.query<{ name: string }>(`SELECT name FROM "SequelizeMeta" ORDER BY name DESC LIMIT 1`, {
        type: QueryTypes.SELECT,
      }),
      sequelize.query<{ count: number }>(`SELECT count(*)::int AS count FROM "SequelizeMeta"`, {
        type: QueryTypes.SELECT,
      }),
    ]);
    const latestMigration = migrationRows[0]?.name ?? null;
    return {
      migrationCount: Number(migrationCountRows[0]?.count ?? 0),
      latestMigration,
      version: latestMigration?.match(/^(\d{3})-/)?.[1] ?? null,
    };
  }

  async enrichmentOperationsSnapshot(tenantId: string) {
    const now = new Date();
    const [workers, jobs, budgets] = await Promise.all([
      sequelize.query<EnrichmentWorkerRuntimeStatus>(
        `SELECT status, provider_name AS "providerName", observed_at AS "observedAt"
         FROM enrichment_worker_runtime_status WHERE worker_id = 'registry-enrichment-worker' LIMIT 1`,
        { type: QueryTypes.SELECT },
      ),
      sequelize.query<{ pendingCount: number; oldestPendingAt: Date | null }>(
        `SELECT count(*) FILTER (WHERE status IN ('queued', 'processing'))::int AS "pendingCount",
                min(created_at) FILTER (WHERE status IN ('queued', 'processing')) AS "oldestPendingAt"
           FROM enrichment_jobs WHERE tenant_id = :tenantId`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ providerName: string; dailyLimit: number; reservedRequests: number }>(
        `SELECT provider_name AS "providerName", daily_limit AS "dailyLimit", reserved_requests AS "reservedRequests"
           FROM registry_provider_daily_budgets WHERE usage_date = :usageDate`,
        { replacements: { usageDate: dateStringInWarsaw(now) }, type: QueryTypes.SELECT },
      ),
    ]);
    const health = enrichmentWorkerHealth({ worker: workers[0] ?? null, now: now.getTime() });
    const reservedByProvider = new Map(budgets.map((row) => [row.providerName, row]));
    const providerBudgets = Object.entries(registryDailyLimits).map(([providerName, configuredLimit]) => {
      const row = reservedByProvider.get(providerName);
      const dailyLimit = Math.min(configuredLimit, Number(row?.dailyLimit ?? configuredLimit));
      const reservedRequests = Number(row?.reservedRequests ?? 0);
      const limitReached = reservedRequests >= dailyLimit;
      return {
        providerName,
        usageDate: dateStringInWarsaw(now),
        dailyLimit,
        reservedRequests,
        remainingRequests: Math.max(0, dailyLimit - reservedRequests),
        limitReached,
        resetsAt: limitReached ? new Date(now.getTime() + secondsUntilNextWarsawDay(now) * 1_000).toISOString() : null,
      };
    });
    return {
      worker: health,
      jobs: { pendingCount: Number(jobs[0]?.pendingCount ?? 0), oldestPendingAt: jobs[0]?.oldestPendingAt ?? null },
      providerBudgets,
    };
  }
}
