/**
 * Shared role, scope, and assignment rules for the Goldis tenant.
 */
export type GoldisRole = "admin" | "operator" | "reviewer" | "auditor";
export type InterventionKind = "sms" | "identity_review" | "portal_error";

export function canAssignIntervention(input: Readonly<{
  role: string; kind: InterventionKind; canViewResults: boolean; canExecute: boolean;
}>): boolean {
  if (input.role === "admin") return true;
  if (input.kind === "sms") return input.role === "operator" && input.canExecute;
  return (input.role === "operator" || input.role === "reviewer") && input.canViewResults;
}

export type PermissionAction =
  | "batch:create"
  | "batch:read"
  | "enrichment:read"
  | "run:create"
  | "run:read"
  | "run:cancel"
  | "run:resume"
  | "run:manual_data"
  | "sms:submit"
  | "intervention:read"
  | "intervention:mark_read"
  | "correction:propose"
  | "correction:review"
  | "conflict:review"
  | "audit:read"
  | "artifact:download"
  | "user:manage";

export type PermissionScope = "owned" | "tenant";

export type AuthorizationContext = Readonly<{
  actorUserId: string | null;
  actorTenantId: string | null;
  resourceOwnerId?: string | null;
  resourceTenantId: string | null;
}>;

const adminActions: readonly PermissionAction[] = [
  "batch:create", "batch:read", "enrichment:read", "run:create", "run:read", "run:cancel", "run:resume",
  "sms:submit", "correction:propose", "correction:review", "conflict:review", "audit:read",
  "artifact:download", "user:manage", "intervention:read", "intervention:mark_read", "run:manual_data",
];

const roleScopes: Readonly<Record<GoldisRole, Readonly<Partial<Record<PermissionAction, PermissionScope>>>>> = {
  admin: Object.fromEntries(adminActions.map((action) => [action, "tenant"])) as Partial<Record<PermissionAction, PermissionScope>>,
  operator: {
    "batch:create": "tenant",
    "batch:read": "owned",
    "enrichment:read": "owned",
    "run:create": "owned",
    "run:read": "owned",
    "run:cancel": "owned",
    "run:resume": "owned",
    "sms:submit": "owned",
    "intervention:read": "owned",
    "intervention:mark_read": "owned",
    "correction:propose": "owned",
    "artifact:download": "owned",
  },
  reviewer: {
    "batch:read": "tenant",
    "enrichment:read": "tenant",
    "run:read": "tenant",
    "intervention:read": "tenant",
    "intervention:mark_read": "tenant",
    "correction:review": "tenant",
    "conflict:review": "tenant",
    "audit:read": "tenant",
  },
  auditor: { "audit:read": "tenant" },
};

export function permissionScope(role: GoldisRole, action: PermissionAction): PermissionScope | null {
  return roleScopes[role][action] ?? null;
}

export function canPerform(
  role: GoldisRole,
  action: PermissionAction,
  context: AuthorizationContext,
): boolean {
  const scope = permissionScope(role, action);
  if (!scope || !context.actorUserId || !context.actorTenantId || !context.resourceTenantId
    || context.actorTenantId !== context.resourceTenantId) return false;
  if (scope === "tenant") return true;
  return Boolean(context.actorUserId && context.resourceOwnerId
    && context.actorUserId === context.resourceOwnerId);
}
