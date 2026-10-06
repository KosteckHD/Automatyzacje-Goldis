import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards, Param } from "@nestjs/common";
import type { Request } from "express";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "./session";
import { ReviewService } from "./review-service";

@Controller("review")
@UseGuards(SessionGuard, PermissionGuard)
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get("corrections")
  @RequirePermission("correction:review", "collection")
  corrections(@Req() request: Request, @Query() query: Parameters<ReviewService["listCorrections"]>[1]) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return this.review.listCorrections(actor, query);
  }

  @Get("my-corrections")
  @RequirePermission("correction:propose", "collection")
  myCorrections(@Req() request: Request, @Query() query: Parameters<ReviewService["listCorrections"]>[1]) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return this.review.listCorrections(actor, query, true);
  }

  @Get("conflicts")
  @RequirePermission("conflict:review", "collection")
  conflicts(@Req() request: Request, @Query() query: Parameters<ReviewService["listConflicts"]>[1]) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return this.review.listConflicts(actor, query);
  }

  @Post("corrections/:id/decision")
  @RequirePermission("correction:review", "route-correction")
  decideCorrection(@Param("id") id: string, @Body() body: unknown, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new BadRequestException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return this.review.decideCorrection(id, actor, body);
  }

  @Post("conflicts/:id/resolution")
  @RequirePermission("conflict:review", "route-conflict")
  resolveConflict(@Param("id") id: string, @Body() body: unknown, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new BadRequestException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return this.review.resolveConflict(id, actor, body);
  }
}
