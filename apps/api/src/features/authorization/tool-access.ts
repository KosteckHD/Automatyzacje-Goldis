import type { ToolGrant as ToolGrantModel } from "../../infrastructure/database/db";
import type { GoldisRole } from "./";

export type ToolCapability = "discover" | "execute" | "view_results" | "download_results";
export type ToolPrincipal = Readonly<{ tenantId: string; userId: string; role: GoldisRole }>;
export type ToolAccessSnapshot = Readonly<{
  toolId: string;
  canDiscover: boolean;
  canExecute: boolean;
  canViewResults: boolean;
  canDownloadResults: boolean;
}>;

export function toolAccessFromRecords(
  principal: ToolPrincipal,
  tool: Readonly<{ toolId: string; status: string }>,
  grant: Readonly<Pick<ToolGrantModel, "canDiscover" | "canExecute" | "canViewResults" | "canDownloadResults">> | null,
): ToolAccessSnapshot {
  if (principal.role === "admin")
    return {
      toolId: tool.toolId,
      canDiscover: true,
      canExecute: tool.status === "available",
      canViewResults: true,
      canDownloadResults: true,
    };
  const sharedOcResults =
    tool.toolId === "oc-policy-verification" && (principal.role === "operator" || principal.role === "manager");
  if (tool.status === "disabled")
    return {
      toolId: tool.toolId,
      canDiscover: false,
      canExecute: false,
      canViewResults: sharedOcResults,
      canDownloadResults: sharedOcResults,
    };
  if (!grant)
    return {
      toolId: tool.toolId,
      canDiscover: sharedOcResults,
      canExecute: false,
      canViewResults: sharedOcResults,
      canDownloadResults: sharedOcResults,
    };
  return {
    toolId: tool.toolId,
    canDiscover: grant.canDiscover || grant.canExecute || sharedOcResults,
    canExecute: grant.canExecute && tool.status === "available",
    canViewResults: sharedOcResults || grant.canViewResults,
    canDownloadResults: sharedOcResults || grant.canDownloadResults,
  };
}

export function capabilityForPermission(action: string): ToolCapability | null {
  if (
    [
      "batch:create",
      "enrichment:start",
      "enrichment:cancel",
      "submission:cancel",
      "run:create",
      "run:cancel",
      "run:resume",
      "run:manual_data",
      "sms:submit",
    ].includes(action)
  )
    return "execute";
  if (action === "artifact:download") return "download_results";
  if (
    [
      "batch:read",
      "enrichment:read",
      "submission:read",
      "run:read",
      "intervention:read",
      "intervention:mark_read",
      "correction:propose",
      "correction:review",
      "conflict:review",
    ].includes(action)
  )
    return "view_results";
  return null;
}

export function showToolInSession(access: ToolAccessSnapshot): boolean {
  return access.canDiscover || access.canViewResults;
}

export async function readToolAccess(principal: ToolPrincipal, toolId: string): Promise<ToolAccessSnapshot | null> {
  const { Tool, ToolGrant } = await import("../../infrastructure/database/db");
  const tool = await Tool.findByPk(toolId, { attributes: ["toolId", "status"] });
  if (!tool) return null;
  if (principal.role === "admin") return toolAccessFromRecords(principal, tool, null);
  const grant = await ToolGrant.findOne({
    where: { tenantId: principal.tenantId, toolId, userId: principal.userId },
    attributes: ["canDiscover", "canExecute", "canViewResults", "canDownloadResults"],
  });
  return toolAccessFromRecords(principal, tool, grant);
}

export async function canAccessTool(
  principal: ToolPrincipal,
  toolId: string,
  capability: ToolCapability,
): Promise<boolean> {
  const access = await readToolAccess(principal, toolId);
  if (!access) return false;
  if (capability === "discover") return access.canDiscover;
  if (capability === "execute") return access.canExecute;
  if (capability === "view_results") return access.canViewResults;
  return access.canDownloadResults;
}

export async function listToolAccess(principal: ToolPrincipal): Promise<ToolAccessSnapshot[]> {
  const { Tool } = await import("../../infrastructure/database/db");
  const records = await Tool.findAll({
    order: [
      ["sortOrder", "ASC"],
      ["toolId", "ASC"],
    ],
  });
  const sharedOcReader = principal.role === "operator" || principal.role === "manager";
  const tools = records.filter(
    (tool) =>
      tool.status === "available" ||
      tool.status === "maintenance" ||
      (sharedOcReader && tool.toolId === "oc-policy-verification" && tool.status === "disabled"),
  );
  const snapshots = await Promise.all(tools.map((tool) => readToolAccess(principal, tool.toolId)));
  // A module may expose prior results without allowing it to start new work or show in the operational catalog.
  // Shared OC access follows the operational collection scope; other modules still require an explicit grant.
  return snapshots.filter((item): item is ToolAccessSnapshot => Boolean(item && showToolInSession(item)));
}
