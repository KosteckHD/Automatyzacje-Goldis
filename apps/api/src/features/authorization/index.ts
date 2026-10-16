export { AuthorizationModule } from "./authorization.module";
export { AuthorizationRepository, resolvePermissionResource } from "./authorization.repository";
export {
  PERMISSION_RESOURCE_RESOLVER,
  PermissionGuard,
  type PermissionRequirement,
  type PermissionResourceResolver,
  RequirePermission,
  type ResourceSelector,
} from "./authorization-guard";
export {
  type AuthorizationContext,
  canAssignIntervention,
  canPerform,
  type GoldisRole,
  type InterventionKind,
  type PermissionAction,
  type PermissionScope,
  permissionScope,
} from "./authorization-policy";
export { operationalCollectionScope } from "./resource-scope";
