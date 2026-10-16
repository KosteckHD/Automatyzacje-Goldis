import { Injectable } from "@nestjs/common";
import { Tool } from "../../infrastructure/database/db";
import type { SessionPrincipal } from "../auth";
import { listToolAccess, type ToolAccessSnapshot } from "../authorization/public";

@Injectable()
export class ToolCatalogRepository {
  listAccess(principal: SessionPrincipal): Promise<ToolAccessSnapshot[]> {
    return listToolAccess(principal);
  }

  findCatalogRows(toolIds: readonly string[]) {
    return Tool.findAll({
      where: { toolId: [...toolIds] },
      order: [["sortOrder", "ASC"]],
    });
  }
}
