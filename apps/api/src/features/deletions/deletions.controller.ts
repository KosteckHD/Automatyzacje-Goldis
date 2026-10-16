import { Body, Controller, ForbiddenException, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { DeletionsService } from "./deletions.service";

@Controller("deletions")
@UseGuards(SessionGuard)
export class DeletionController {
  constructor(@Inject(DeletionsService) private readonly deletions: DeletionsService) {}

  @Post("preview")
  preview(@Body() body: unknown, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(request);
    if (!actor?.sessionId) throw new ForbiddenException();
    return this.deletions.preview({ actor, body });
  }
}
