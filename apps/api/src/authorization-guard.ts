import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, NotFoundException, Optional, SetMetadata, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { canPerform, permissionScope, type AuthorizationContext, type PermissionAction } from "./authorization-policy";
import { readSessionPrincipal, type SessionPrincipal } from "./session";

export type ResourceSelector = "new-batch" | "route-batch" | "query-batch" | "body-batch" | "route-run" | "query-run" | "body-run" | "session-list" | "route-intervention" | "collection";
export type PermissionRequirement = Readonly<{ action: PermissionAction; resource: ResourceSelector }>;
export type PermissionResourceResolver = (
  selector: ResourceSelector,
  request: Request,
  principal: SessionPrincipal,
) => Promise<Pick<AuthorizationContext, "resourceTenantId" | "resourceOwnerId"> & { resourceToolId?: string | null; resourceAssigneeId?: string | null } | null>;

export const PERMISSION_RESOURCE_RESOLVER = "GOLDIS_PERMISSION_RESOURCE_RESOLVER";
const permissionMetadataKey = "goldis:permission-requirement";

export function RequirePermission(action: PermissionAction, resource: ResourceSelector) {
  return SetMetadata(permissionMetadataKey, { action, resource } satisfies PermissionRequirement);
}

function selectedId(selector: ResourceSelector, request: Request): string | null {
  switch (selector) {
    case "route-batch":
    case "route-run":
    case "route-intervention":
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
): Promise<Pick<AuthorizationContext, "resourceTenantId" | "resourceOwnerId"> & { resourceToolId?: string | null; resourceAssigneeId?: string | null } | null> {
  if (selector === "new-batch") {
    const toolId = typeof request.params.toolId === "string" ? request.params.toolId : "oc-policy-verification";
    try {
      const { Tool } = await import("./db");
      const tool = await Tool.findByPk(toolId, { attributes: ["toolId"] });
      return tool ? { resourceTenantId: principal.tenantId, resourceOwnerId: principal.userId, resourceToolId: tool.toolId } : null;
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
    const { AutomationRun, ImportBatch, ManualIntervention } = await import("./db");
    let resolvedId = id;
    let resourceAssigneeId: string | null = null;
    if (selector === "route-intervention") {
      const intervention = await ManualIntervention.findByPk(id, { attributes: ["runId", "assigneeUserId"] });
      resolvedId = intervention?.runId ?? "";
      resourceAssigneeId = intervention?.assigneeUserId ?? null;
      if (!resolvedId) return null;
    }
    const isRun = selector === "route-run" || selector === "query-run" || selector === "body-run" || selector === "route-intervention";
    const run = isRun ? await AutomationRun.findByPk(resolvedId, { attributes: ["batchId", "toolId"] }) : null;
    const batchId = isRun ? run?.batchId : resolvedId;
    if (!batchId) return null;
    const batch = await ImportBatch.findByPk(batchId, { attributes: ["tenantId", "ownerUserId", "toolId"] });
    if (!batch) return null;
    if (run && run.toolId !== batch.toolId) throw new ServiceUnavailableException();
    if ((selector === "route-run" || selector === "query-run" || selector === "body-run") && resolvedId) {
      const assigned = await ManualIntervention.findOne({
        where: { runId: resolvedId, assigneeUserId: principal.userId, status: "open" },
        attributes: ["interventionId"],
      });
      resourceAssigneeId = assigned ? principal.userId : null;
    }
    return { resourceTenantId: batch.tenantId, resourceOwnerId: batch.ownerUserId, resourceToolId: batch.toolId, resourceAssigneeId };
  } catch {
    throw new ServiceUnavailableException();
  }
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Optional() @Inject(PERMISSION_RESOURCE_RESOLVER) private readonly resolveResource?: PermissionResourceResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = readSessionPrincipal(request);
    const requirement = Reflect.getMetadata(permissionMetadataKey, context.getHandler()) as PermissionRequirement | undefined;
    if (!principal || !requirement) throw new ForbiddenException();
    let resource: Pick<AuthorizationContext, "resourceTenantId" | "resourceOwnerId"> & { resourceToolId?: string | null; resourceAssigneeId?: string | null } | null;
    try {
      resource = await (this.resolveResource ?? resolvePermissionResource)(requirement.resource, request, principal);
    } catch {
      throw new ServiceUnavailableException();
    }
    if (!resource) throw new NotFoundException();
    const authorizationContext: AuthorizationContext = {
      actorUserId: principal.userId,
      actorTenantId: principal.tenantId,
      resourceOwnerId: resource.resourceOwnerId,
      resourceTenantId: resource.resourceTenantId,
    };
    const isAssignedInterventionRead = (requirement.action === "intervention:read" || requirement.action === "intervention:mark_read")
      && principal.role === "operator" && resource.resourceAssigneeId === principal.userId;
    const isAssignedRunRead = requirement.action === "run:read" && principal.role === "operator"
      && resource.resourceAssigneeId === principal.userId;
    const isAssignedSms = requirement.action === "sms:submit" && principal.role === "operator"
      && resource.resourceAssigneeId === principal.userId;
    if (canPerform(principal.role, requirement.action, authorizationContext) || isAssignedInterventionRead || isAssignedRunRead || isAssignedSms) {
      const { capabilityForPermission, canAccessTool } = await import("./tool-access");
      const capability = capabilityForPermission(requirement.action);
      if (capability && resource.resourceToolId) {
        try {
          if (!await canAccessTool(principal, resource.resourceToolId, capability)) throw new NotFoundException();
        } catch (error) {
          if (error instanceof NotFoundException) throw error;
          throw new ServiceUnavailableException();
        }
      }
      return true;
    }
    if (!resource.resourceTenantId || resource.resourceTenantId !== principal.tenantId
      || (permissionScope(principal.role, requirement.action) === "owned"
        && resource.resourceOwnerId !== principal.userId)) {
      // Conceal cross-tenant and other-owner resource existence.
      throw new NotFoundException();
    }
    throw new ForbiddenException();
  }
}
