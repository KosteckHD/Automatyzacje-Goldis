/**
 * Shared role, scope, and assignment rules for the Goldis tenant.
 */
import type { GoldisRole } from "../../contracts/identity";

export type { GoldisRole } from "../../contracts/identity";
export type InterventionKind = "sms" | "identity_review" | "portal_error";

export function canAssignIntervention(
  input: Readonly<{
    role: string;
    kind: InterventionKind;
    canViewResults: boolean;
    canExecute: boolean;
  }>,
): boolean {
  if (input.role === "admin") return true;
  if (input.role === "manager") return input.kind === "sms" ? input.canExecute : input.canViewResults;
  if (input.kind === "sms") return input.role === "operator" && input.canExecute;
  return (input.role === "operator" || input.role === "reviewer") && input.canViewResults;
}

export type PermissionAction =
  | "batch:create"
  | "batch:read"
  | "enrichment:read"
  | "enrichment:start"
  | "enrichment:cancel"
  | "submission:read"
  | "submission:cancel"
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
  "batch:create",
  "batch:read",
  "enrichment:read",
  "enrichment:start",
  "enrichment:cancel",
  "submission:read",
  "submission:cancel",
  "run:create",
  "run:read",
  "run:cancel",
  "run:resume",
  "sms:submit",
  "correction:propose",
  "correction:review",
  "conflict:review",
  "audit:read",
  "artifact:download",
  "user:manage",
  "intervention:read",
  "intervention:mark_read",
  "run:manual_data",
];

const roleScopes: Readonly<Record<GoldisRole, Readonly<Partial<Record<PermissionAction, PermissionScope>>>>> = {
  admin: Object.fromEntries(adminActions.map((action) => [action, "tenant"])) as Partial<
    Record<PermissionAction, PermissionScope>
  >,
  manager: {
    "batch:create": "tenant",
    "batch:read": "tenant",
    "enrichment:read": "tenant",
    "enrichment:start": "tenant",
    "enrichment:cancel": "tenant",
    "submission:read": "tenant",
    "submission:cancel": "tenant",
    "run:create": "tenant",
    "run:read": "tenant",
    "run:cancel": "tenant",
    "run:resume": "tenant",
    "run:manual_data": "tenant",
    "sms:submit": "tenant",
    "intervention:read": "tenant",
    "intervention:mark_read": "tenant",
    "correction:propose": "tenant",
    "correction:review": "tenant",
    "conflict:review": "tenant",
    "audit:read": "tenant",
    "artifact:download": "tenant",
  },
  operator: {
    "batch:create": "tenant",
    "batch:read": "owned",
    "enrichment:read": "owned",
    "enrichment:start": "owned",
    "enrichment:cancel": "owned",
    "submission:read": "owned",
    "submission:cancel": "owned",
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

export function canPerform(role: GoldisRole, action: PermissionAction, context: AuthorizationContext): boolean {
  const scope = permissionScope(role, action);
  if (
    !scope ||
    !context.actorUserId ||
    !context.actorTenantId ||
    !context.resourceTenantId ||
    context.actorTenantId !== context.resourceTenantId
  )
    return false;
  if (scope === "tenant") return true;
  return Boolean(context.actorUserId && context.resourceOwnerId && context.actorUserId === context.resourceOwnerId);
}
