import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  SetMetadata,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticatedRequest, SessionPrincipal } from "../../contracts/identity";
import { resolvePermissionResource } from "./authorization.repository";
import { type AuthorizationContext, canPerform, type PermissionAction, permissionScope } from "./authorization-policy";

export type ResourceSelector =
  | "new-batch"
  | "route-batch"
  | "query-batch"
  | "body-batch"
  | "route-run"
  | "query-run"
  | "body-run"
  | "session-list"
  | "route-intervention"
  | "route-correction"
  | "route-conflict"
  | "route-enrichment-job"
  | "route-submission"
  | "collection";
export type PermissionRequirement = Readonly<{ action: PermissionAction; resource: ResourceSelector }>;
export type PermissionResourceResolver = (
  selector: ResourceSelector,
  request: Request,
  principal: SessionPrincipal,
) => Promise<
  | (Pick<AuthorizationContext, "resourceTenantId" | "resourceOwnerId"> & {
      resourceToolId?: string | null;
      resourceAssigneeId?: string | null;
      resourceInterventionKind?: "sms" | "identity_review" | "portal_error" | null;
      resourceToolStatus?: string | null;
      resourceRunStarterId?: string | null;
    })
  | null
>;

export const PERMISSION_RESOURCE_RESOLVER = "GOLDIS_PERMISSION_RESOURCE_RESOLVER";
const permissionMetadataKey = "goldis:permission-requirement";

export function RequirePermission(action: PermissionAction, resource: ResourceSelector) {
  return SetMetadata(permissionMetadataKey, { action, resource } satisfies PermissionRequirement);
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Optional() @Inject(PERMISSION_RESOURCE_RESOLVER) private readonly resolveResource?: PermissionResourceResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = (request as AuthenticatedRequest).goldisPrincipal ?? null;
    const requirement = Reflect.getMetadata(permissionMetadataKey, context.getHandler()) as
      | PermissionRequirement
      | undefined;
    if (!principal || !requirement) throw new ForbiddenException();
    let resource:
      | (Pick<AuthorizationContext, "resourceTenantId" | "resourceOwnerId"> & {
          resourceToolId?: string | null;
          resourceAssigneeId?: string | null;
          resourceInterventionKind?: "sms" | "identity_review" | "portal_error" | null;
          resourceToolStatus?: string | null;
          resourceRunStarterId?: string | null;
        })
      | null;
    try {
      resource = await (this.resolveResource ?? resolvePermissionResource)(requirement.resource, request, principal);
    } catch {
      throw new ServiceUnavailableException();
    }
    if (!resource) throw new NotFoundException();
    // Tenant is the mandatory outer boundary. Ownership and assignment exceptions
    // only narrow access within this tenant; they can never replace this check.
    if (!resource.resourceTenantId || resource.resourceTenantId !== principal.tenantId) {
      throw new NotFoundException();
    }
    const authorizationContext: AuthorizationContext = {
      actorUserId: principal.userId,
      actorTenantId: principal.tenantId,
      resourceOwnerId: resource.resourceOwnerId,
      resourceTenantId: resource.resourceTenantId,
    };
    const isAssignedInterventionRead =
      (requirement.action === "intervention:read" || requirement.action === "intervention:mark_read") &&
      principal.role === "operator" &&
      resource.resourceAssigneeId === principal.userId;
    const isAssignedRunRead =
      requirement.action === "run:read" &&
      principal.role === "operator" &&
      resource.resourceAssigneeId === principal.userId;
    const isAssignedSms =
      requirement.action === "sms:submit" &&
      principal.role === "operator" &&
      resource.resourceAssigneeId === principal.userId;
    const isRunStarterOperationalAccess =
      (requirement.resource === "route-run" ||
        requirement.resource === "query-run" ||
        requirement.resource === "body-run") &&
      ["admin", "manager", "operator"].includes(principal.role) &&
      resource.resourceRunStarterId === principal.userId &&
      ["run:read", "run:resume", "run:manual_data", "sms:submit"].includes(requirement.action);
    const isScopedOperationalCollection =
      requirement.resource === "collection" &&
      (requirement.action === "batch:read" || requirement.action === "run:read") &&
      principal.role === "operator";
    let isSharedOcResultRead = false;
    if (
      requirement.resource !== "route-batch" &&
      resource.resourceOwnerId !== principal.userId &&
      resource.resourceToolId === "oc-policy-verification" &&
      (requirement.action === "batch:read" ||
        requirement.action === "run:read" ||
        requirement.action === "artifact:download") &&
      (principal.role === "operator" || principal.role === "manager")
    ) {
      try {
        const { canAccessTool } = await import("./tool-access");
        const capability = requirement.action === "artifact:download" ? "download_results" : "view_results";
        isSharedOcResultRead = await canAccessTool(principal, resource.resourceToolId, capability);
      } catch {
        throw new ServiceUnavailableException();
      }
    }
    let isAssignedSmsMetadataRead = false;
    let isManagerSmsMetadataRead = false;
    if (
      (requirement.action === "intervention:read" || requirement.action === "intervention:mark_read") &&
      principal.role === "operator" &&
      resource.resourceInterventionKind === "sms" &&
      resource.resourceAssigneeId === principal.userId &&
      (resource.resourceToolStatus === "available" || resource.resourceToolStatus === "maintenance") &&
      resource.resourceToolId
    ) {
      try {
        const { ToolGrant } = await import("../../infrastructure/database/db");
        const grant = await ToolGrant.findOne({
          where: { tenantId: principal.tenantId, toolId: resource.resourceToolId, userId: principal.userId },
          attributes: ["canExecute"],
        });
        isAssignedSmsMetadataRead = Boolean(grant?.canExecute);
      } catch {
        throw new ServiceUnavailableException();
      }
    }
    if (
      (requirement.action === "intervention:read" || requirement.action === "intervention:mark_read") &&
      principal.role === "manager" &&
      resource.resourceInterventionKind === "sms" &&
      (resource.resourceToolStatus === "available" || resource.resourceToolStatus === "maintenance") &&
      resource.resourceToolId
    ) {
      try {
        const { ToolGrant } = await import("../../infrastructure/database/db");
        const grant = await ToolGrant.findOne({
          where: { tenantId: principal.tenantId, toolId: resource.resourceToolId, userId: principal.userId },
          attributes: ["canExecute"],
        });
        isManagerSmsMetadataRead = Boolean(grant?.canExecute);
      } catch {
        throw new ServiceUnavailableException();
      }
    }
    if (
      canPerform(principal.role, requirement.action, authorizationContext) ||
      isAssignedInterventionRead ||
      isAssignedRunRead ||
      isAssignedSms ||
      isRunStarterOperationalAccess ||
      isAssignedSmsMetadataRead ||
      isManagerSmsMetadataRead ||
      isSharedOcResultRead ||
      isScopedOperationalCollection
    ) {
      const { capabilityForPermission, canAccessTool } = await import("./tool-access");
      const capability = capabilityForPermission(requirement.action);
      if (capability && resource.resourceToolId && !isAssignedSmsMetadataRead && !isManagerSmsMetadataRead) {
        try {
          if (!(await canAccessTool(principal, resource.resourceToolId, capability))) throw new NotFoundException();
        } catch (error) {
          if (error instanceof NotFoundException) throw error;
          throw new ServiceUnavailableException();
        }
      }
      return true;
    }
    if (
      permissionScope(principal.role, requirement.action) === "owned" &&
      resource.resourceOwnerId !== principal.userId
    ) {
      // Conceal resources outside the role's owner scope.
      throw new NotFoundException();
    }
    throw new ForbiddenException();
  }
}
