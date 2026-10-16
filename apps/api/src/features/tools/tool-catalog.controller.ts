import { Controller, ForbiddenException, Get, Inject, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard } from "../auth";
import { ToolsService } from "./tools.service";

@Controller("tools")
@UseGuards(SessionGuard)
export class ToolCatalogController {
  constructor(@Inject(ToolsService) private readonly tools: ToolsService) {}

  @Get()
  list(@Req() request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.tools.list(principal);
  }
}
