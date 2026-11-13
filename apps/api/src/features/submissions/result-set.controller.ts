import { Controller, ForbiddenException, Get, Inject, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { recordAuditEvent } from "../audit/public";
import { readSessionPrincipal, SessionGuard } from "../auth/public";
import { artifactDownloadHeaders } from "../results/public";
import { RunSubmissionService } from "./run-submissions.service";

@Controller("result-sets")
@UseGuards(SessionGuard)
export class ResultSetController {
  constructor(@Inject(RunSubmissionService) private readonly submissions: RunSubmissionService) {}

  private actor(request: Request) {
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak aktywnej sesji");
    return { principal, actor: { tenantId: principal.tenantId, actorUserId: principal.userId } };
  }

  @Get(":id/summary")
  summary(@Param("id") id: string, @Req() request: Request) {
    const { principal, actor } = this.actor(request);
    return this.submissions.resultSetSummary(id, actor, principal.role);
  }

  @Get(":id/rows")
  rows(
    @Param("id") id: string,
    @Query("cursor") cursor: string | undefined,
    @Query("q") search: string | undefined,
    @Query("status") status: string | undefined,
    @Req() request: Request,
  ) {
    const { principal, actor } = this.actor(request);
    return this.submissions.resultSetRows(id, cursor, actor, principal.role, search ?? "", status);
  }

  @Get(":id/export")
  async export(@Param("id") id: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    const { principal, actor } = this.actor(request);
    const file = await this.submissions.exportResultSet(id, actor, principal.role);
    await recordAuditEvent({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      action: "result_set.exported",
      resourceType: "result_set",
      resourceId: id,
      outcome: "succeeded",
      metadata: { format: "xlsx", rows: file.rows, policies: file.policies },
    });
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    for (const [name, value] of Object.entries(artifactDownloadHeaders(file.fileName, file.bytes.byteLength)))
      response.setHeader(name, value);
    response.status(200).send(file.bytes);
  }
}
