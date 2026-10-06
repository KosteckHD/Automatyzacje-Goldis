import type { GoldisRole } from "./authorization-policy";

/** SQL predicate for list queries. Apply it before counts, filters and pagination. */
export function operationalCollectionScope(role: GoldisRole | string): string {
  const activeTool = "(t.status <> 'disabled')";
  const resultGrant = `EXISTS (
    SELECT 1 FROM tool_grants tg
    WHERE tg.tenant_id = b.tenant_id
      AND tg.tool_id = b.tool_id
      AND tg.user_id = :userId
      AND (tg.can_view_results = TRUE OR tg.can_download_results = TRUE)
  )`;
  switch (role) {
    case "admin":
      return "b.tenant_id = :tenantId";
    case "operator":
      return `b.tenant_id = :tenantId AND b.owner_user_id = :userId AND ${activeTool} AND ${resultGrant}`;
    case "reviewer":
      return `b.tenant_id = :tenantId AND ${activeTool} AND ${resultGrant}`;
    case "auditor":
    default:
      return "FALSE";
  }
}
