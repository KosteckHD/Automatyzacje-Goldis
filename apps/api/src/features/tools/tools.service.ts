import { Inject, Injectable } from "@nestjs/common";
import type { SessionPrincipal } from "../auth";
import { ToolCatalogRepository } from "./tool-catalog.repository";

@Injectable()
export class ToolsService {
  constructor(@Inject(ToolCatalogRepository) private readonly repository: ToolCatalogRepository) {}

  async list(principal: SessionPrincipal) {
    const access = await this.repository.listAccess(principal);
    if (!access.length) return { items: [] };
    const tools = await this.repository.findCatalogRows(access.map((item) => item.toolId));
    return {
      items: tools.map((tool) => ({
        toolId: tool.toolId,
        displayName: tool.displayName,
        description: tool.description,
        status: tool.status,
        access: access.find((item) => item.toolId === tool.toolId),
      })),
    };
  }
}
