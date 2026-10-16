import type { GoldisRole } from "./authorization-policy";

/** SQL predicate for list queries. Apply it before counts, filters and pagination. */
export function operationalCollectionScope(role: GoldisRole | string): string {
  const activeTool = "(t.status <> 'disabled' OR b.tool_id = 'oc-policy-verification')";
  const sharedOcResults = `(
    b.tool_id = 'oc-policy-verification'
    AND EXISTS (SELECT 1 FROM tools shared_tool
                 WHERE shared_tool.tool_id = b.tool_id)
  )`;
  const resultGrant = `EXISTS (
    SELECT 1 FROM tool_grants tg
    WHERE tg.tenant_id = b.tenant_id
      AND tg.tool_id = b.tool_id
      AND tg.user_id = :userId
      AND tg.can_view_results = TRUE
  )`;
  switch (role) {
    case "admin":
      return "b.tenant_id = :tenantId";
    case "operator":
      return `b.tenant_id = :tenantId AND ${activeTool}
        AND (b.owner_user_id = :userId OR ${sharedOcResults} OR ${resultGrant})`;
    case "manager":
      return `b.tenant_id = :tenantId AND ${activeTool} AND (${sharedOcResults} OR ${resultGrant})`;
    case "reviewer":
      return `b.tenant_id = :tenantId AND ${activeTool} AND ${resultGrant}`;
    default:
      return "FALSE";
  }
}
