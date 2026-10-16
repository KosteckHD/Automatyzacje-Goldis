import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import type { SessionPrincipal } from "../../contracts/identity";
import type { PermissionResourceResolver, ResourceSelector } from "./authorization-guard";
import type { AuthorizationContext } from "./authorization-policy";

function selectedId(selector: ResourceSelector, request: Request): string | null {
  switch (selector) {
    case "route-batch":
      return typeof request.params.id === "string"
        ? request.params.id
        : typeof request.params.batchId === "string"
          ? request.params.batchId
          : null;
    case "route-run":
    case "route-intervention":
    case "route-correction":
    case "route-conflict":
    case "route-enrichment-job":
    case "route-submission":
      return typeof request.params.id === "string" ? request.params.id : null;
    case "query-batch":
      return typeof request.query.batchId === "string" ? request.query.batchId : null;
    case "query-run":
      return typeof request.query.runId === "string" ? request.query.runId : null;
    case "body-run": {
      const body = request.body as Record<string, unknown> | undefined;
      return typeof body?.runId === "string" ? body.runId : null;
    }
    case "body-batch": {
      const body = request.body as Record<string, unknown> | undefined;
      return typeof body?.batchId === "string" ? body.batchId : null;
    }
    case "session-list":
    case "new-batch":
    case "collection":
      return null;
  }
}

export async function resolvePermissionResource(
  selector: ResourceSelector,
  request: Request,
  principal: SessionPrincipal,
): Promise<
  | (Pick<AuthorizationContext, "resourceTenantId" | "resourceOwnerId"> & {
      resourceToolId?: string | null;
      resourceAssigneeId?: string | null;
      resourceInterventionKind?: "sms" | "identity_review" | "portal_error" | null;
      resourceToolStatus?: string | null;
      resourceRunStarterId?: string | null;
    })
  | null
> {
  if (selector === "new-batch") {
    const toolId = typeof request.params.toolId === "string" ? request.params.toolId : "oc-policy-verification";
    try {
      const { Tool } = await import("../../infrastructure/database/db");
      const tool = await Tool.findByPk(toolId, { attributes: ["toolId"] });
      return tool
        ? { resourceTenantId: principal.tenantId, resourceOwnerId: principal.userId, resourceToolId: tool.toolId }
        : null;
    } catch {
      throw new ServiceUnavailableException();
    }
  }
  if (selector === "session-list") {
    return { resourceTenantId: principal.tenantId, resourceOwnerId: principal.userId, resourceToolId: null };
  }
  if (selector === "collection") {
    // This passes the role-level collection gate. Each list query must still scope tenant,
    // owner and current view_results grant in SQL before filtering or pagination.
    return { resourceTenantId: principal.tenantId, resourceOwnerId: principal.userId, resourceToolId: null };
  }
  const id = selectedId(selector, request);
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  try {
    const { AutomationRun, ImportBatch, ManualIntervention, Tool } = await import("../../infrastructure/database/db");
    let resolvedId = id;
    let resourceAssigneeId: string | null = null;
    let resourceInterventionKind: "sms" | "identity_review" | "portal_error" | null = null;
    if (selector === "route-enrichment-job") {
      const { EnrichmentJob } = await import("../../infrastructure/database/db");
      const job = await EnrichmentJob.findByPk(id, { attributes: ["batchId", "tenantId"] });
      if (!job) return null;
      const batch = await ImportBatch.findByPk(job.batchId, { attributes: ["tenantId", "ownerUserId", "toolId"] });
      if (!batch || batch.tenantId !== job.tenantId) return null;
      const { isResourceTombstoned } = await import("../../contracts/deletion-barrier");
      if (await isResourceTombstoned("import", job.batchId)) return null;
      return { resourceTenantId: job.tenantId, resourceOwnerId: batch.ownerUserId, resourceToolId: batch.toolId };
    }
    if (selector === "route-submission") {
      const { RunSubmission } = await import("../../infrastructure/database/db");
      const submission = await RunSubmission.findByPk(id, { attributes: ["importBatchId", "tenantId", "toolId"] });
      if (!submission) return null;
      const batch = await ImportBatch.findByPk(submission.importBatchId, {
        attributes: ["tenantId", "ownerUserId", "toolId"],
      });
      if (!batch || batch.tenantId !== submission.tenantId || batch.toolId !== submission.toolId) return null;
      const { isResourceTombstoned } = await import("../../contracts/deletion-barrier");
      if (await isResourceTombstoned("import", submission.importBatchId)) return null;
      return {
        resourceTenantId: submission.tenantId,
        resourceOwnerId: batch.ownerUserId,
        resourceToolId: batch.toolId,
      };
    }
    if (selector === "route-intervention") {
      const intervention = await ManualIntervention.findByPk(id, { attributes: ["runId", "assigneeUserId", "kind"] });
      resolvedId = intervention?.runId ?? "";
      resourceAssigneeId = intervention?.assigneeUserId ?? null;
      resourceInterventionKind =
        intervention?.kind === "sms" ||
        intervention?.kind === "identity_review" ||
        intervention?.kind === "portal_error"
          ? intervention.kind
          : null;
      if (!resolvedId) return null;
    }
    if (selector === "route-correction" || selector === "route-conflict") {
      const { RegonCorrection, EntityGroupingConflict, SourceRow } = await import("../../infrastructure/database/db");
      const record =
        selector === "route-correction"
          ? await RegonCorrection.findByPk(id, { attributes: ["sourceRowId"] })
          : await EntityGroupingConflict.findByPk(id, { attributes: ["sourceRowId"] });
      if (!record) return null;
      const source = await SourceRow.findByPk(record.sourceRowId, { attributes: ["batchId"] });
      if (!source) return null;
      resolvedId = source.batchId;
    }
    const isRun =
      selector === "route-run" ||
      selector === "query-run" ||
      selector === "body-run" ||
      selector === "route-intervention";
    const run = isRun
      ? await AutomationRun.findByPk(resolvedId, { attributes: ["batchId", "toolId", "startedByUserId"] })
      : null;
    const batchId = isRun ? run?.batchId : resolvedId;
    if (!batchId) return null;
    const batch = await ImportBatch.findByPk(batchId, { attributes: ["tenantId", "ownerUserId", "toolId"] });
    if (!batch) return null;
    const { isResourceTombstoned } = await import("../../contracts/deletion-barrier");
    if (await isResourceTombstoned("import", batchId)) return null;
    if (isRun && resolvedId && (await isResourceTombstoned("run", resolvedId))) return null;
    if (run && run.toolId !== batch.toolId) throw new ServiceUnavailableException();
    if ((selector === "route-run" || selector === "query-run" || selector === "body-run") && resolvedId) {
      const assigned = await ManualIntervention.findOne({
        where: { runId: resolvedId, assigneeUserId: principal.userId, status: "open" },
        attributes: ["interventionId"],
      });
      resourceAssigneeId = assigned ? principal.userId : null;
    }
    const tool = await Tool.findByPk(batch.toolId, { attributes: ["status"] });
    if (!tool) return null;
    return {
      resourceTenantId: batch.tenantId,
      resourceOwnerId: batch.ownerUserId,
      resourceToolId: batch.toolId,
      resourceAssigneeId,
      resourceInterventionKind,
      resourceToolStatus: tool.status,
      resourceRunStarterId: run?.startedByUserId ?? null,
    };
  } catch {
    throw new ServiceUnavailableException();
  }
}

@Injectable()
export class AuthorizationRepository {
  resolveResource: PermissionResourceResolver = resolvePermissionResource;
}
