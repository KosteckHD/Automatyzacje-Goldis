export { AuthorizationModule } from "./authorization.module";
export {
  PERMISSION_RESOURCE_RESOLVER,
  PermissionGuard,
  type PermissionRequirement,
  type PermissionResourceResolver,
  RequirePermission,
  type ResourceSelector,
} from "./authorization-guard";
export { operationalCollectionScope } from "./resource-scope";
export type { ToolAccessSnapshot, ToolCapability, ToolPrincipal } from "./tool-access";
export {
  canAccessTool,
  capabilityForPermission,
  listToolAccess,
  readToolAccess,
  showToolInSession,
  toolAccessFromRecords,
} from "./tool-access";
