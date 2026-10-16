import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth";
import { PermissionGuard, RequirePermission } from "../authorization";
import type { SelectionInput } from "./run-submission.dto";
import { RunSubmissionService } from "./run-submissions.service";

@Controller()
@UseGuards(SessionGuard, PermissionGuard)
export class RunSubmissionController {
  constructor(@Inject(RunSubmissionService) private readonly submissions: RunSubmissionService) {}

  @Post("imports/:batchId/run-submissions/preview")
  @RequirePermission("run:create", "route-batch")
  preview(@Param("batchId") batchId: string, @Body() body: SelectionInput, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.preview(
      batchId,
      body,
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      principal.role,
    );
  }

  @Post("imports/:batchId/run-submissions")
  @RequirePermission("run:create", "route-batch")
  create(
    @Param("batchId") batchId: string,
    @Body() body: SelectionInput & { selectionFingerprint?: unknown; idempotencyKey?: unknown },
    @Req() request: Request,
  ) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.create(
      batchId,
      body,
      {
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        sessionId: principal.sessionId,
      },
      principal.role,
    );
  }

  @Get("run-submissions/:id")
  @RequirePermission("submission:read", "route-submission")
  get(@Param("id") id: string, @Req() request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.get(id, { tenantId: principal.tenantId, actorUserId: principal.userId }, principal.role);
  }

  @Get("run-submissions/:id/items")
  @RequirePermission("submission:read", "route-submission")
  items(@Param("id") id: string, @Query("cursor") cursor: string | undefined, @Req() request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.listItems(
      id,
      cursor,
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      principal.role,
    );
  }

  @Post("run-submissions/:id/cancel")
  @RequirePermission("submission:cancel", "route-submission")
  cancel(@Param("id") id: string, @Body() body: { expectedVersion?: unknown }, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    if (!body || Object.keys(body).some((key) => key !== "expectedVersion"))
      throw new BadRequestException("Nieprawidłowe żądanie anulowania");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    return this.submissions.cancel(
      id,
      body?.expectedVersion as number,
      { tenantId: principal.tenantId, actorUserId: principal.userId, sessionId: principal.sessionId },
      principal.role,
    );
  }
}
