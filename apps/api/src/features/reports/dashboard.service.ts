import { Inject, Injectable } from "@nestjs/common";
import { listToolAccess } from "../authorization/public";
import { DashboardRepository } from "./dashboard.repository";

@Injectable()
export class DashboardService {
  constructor(@Inject(DashboardRepository) private readonly repository: DashboardRepository) {}

  async get(actor: { tenantId: string; userId: string; role: string }) {
    const accesses = await listToolAccess({
      tenantId: actor.tenantId,
      userId: actor.userId,
      role: actor.role as "admin" | "manager" | "operator" | "reviewer" | "auditor",
    });
    const ocAccess = accesses.find((item) => item.toolId === "oc-policy-verification");
    const canReadOc = Boolean(ocAccess?.canViewResults);

    const [operations, ownOperationMetrics, ownLeadMetrics, teamLeadMetrics, unreadNotifications] = await Promise.all([
      canReadOc ? this.repository.operations(actor) : Promise.resolve([]),
      canReadOc
        ? this.repository.ownOperationMetrics(actor)
        : Promise.resolve({ total: 0, active: 0, attention: 0, completed: 0 }),
      canReadOc
        ? this.repository.ownLeadMetrics(actor)
        : Promise.resolve({ total: 0, notContacted: 0, accepted: 0, notInterested: 0 }),
      canReadOc && (actor.role === "manager" || actor.role === "admin")
        ? this.repository.teamLeadMetrics(actor.tenantId)
        : Promise.resolve(null),
      this.repository.unreadNotifications(actor),
    ]);

    return {
      role: actor.role,
      tools: accesses.map((item) => ({
        toolId: item.toolId,
        canExecute: item.canExecute,
        canViewResults: item.canViewResults,
        canDownloadResults: item.canDownloadResults,
      })),
      metrics: { operations: ownOperationMetrics, myLeads: ownLeadMetrics, team: teamLeadMetrics },
      operations: operations.map((item) => ({
        ...item,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        finishedAt: item.finishedAt ? new Date(item.finishedAt).toISOString() : null,
      })),
      actionRequired: operations
        .filter((item) => item.status === "waiting_attention")
        .map((item) => ({
          id: item.resultSetId,
          toolName: item.toolName,
          fileName: item.fileName,
          createdAt: new Date(item.updatedAt).toISOString(),
          href:
            item.sourceType === "run_submission"
              ? `/submissions/${encodeURIComponent(item.sourceId)}`
              : `/imports/${encodeURIComponent(item.batchId)}`,
          status: item.status,
        })),
      unreadNotifications,
    };
  }
}
