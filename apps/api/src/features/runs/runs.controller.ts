import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { recordAuditEvent } from "../audit/public";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { ArtifactDownloadError, artifactDownloadHeaders } from "../results/public";
import { validateRunControlRequest } from "./run-control.dto";
import { RunService } from "./runs.service";

@Controller("runs")
@UseGuards(SessionGuard, PermissionGuard)
export class RunController {
  constructor(@Inject(RunService) private readonly runs: RunService) {}

  @Post()
  @RequirePermission("run:create", "body-batch")
  create(@Body() body: { batchId?: string; rowNumber?: number }, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.create(body?.batchId ?? "", body?.rowNumber as number, {
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
    });
  }

  @Get()
  @RequirePermission("run:read", "query-batch")
  list(@Query("batchId") batchId?: string) {
    return this.runs.list(batchId ?? "");
  }

  @Get(":id")
  @RequirePermission("run:read", "route-run")
  get(@Param("id") id: string, @Req() req: Request) {
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.get(id, principal.role, principal.userId);
  }

  @Get(":id/artifact")
  @RequirePermission("artifact:download", "route-run")
  async artifact(@Param("id") id: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    let artifact: Awaited<ReturnType<RunService["downloadArtifact"]>>;
    try {
      artifact = await this.runs.downloadArtifact(id);
    } catch (error) {
      if (error instanceof ArtifactDownloadError && error.code === "ARTIFACT_STORAGE_UNAVAILABLE") {
        throw new ServiceUnavailableException("Plik wynikowy jest chwilowo niedostępny");
      }
      throw new NotFoundException("Nie znaleziono gotowego pliku wynikowego");
    }
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException();
    try {
      await recordAuditEvent({
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        action: "artifact.downloaded",
        resourceType: "artifact",
        resourceId: id,
        outcome: "succeeded",
      });
    } catch {
      throw new ServiceUnavailableException("Nie można zapisać zdarzenia audytu pobrania");
    }
    for (const [name, value] of Object.entries(artifactDownloadHeaders(artifact.fileName, artifact.bytes.byteLength))) {
      response.setHeader(name, value);
    }
    response.status(200).send(artifact.bytes);
  }

  @Post(":id/cancel")
  @RequirePermission("run:cancel", "route-run")
  cancel(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.cancel(id, { tenantId: principal.tenantId, actorUserId: principal.userId });
  }

  @Post(":id/pause")
  @RequirePermission("run:cancel", "route-run")
  pause(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.pause(
      id,
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      validateRunControlRequest(req.body),
    );
  }

  @Post(":id/resume")
  @RequirePermission("run:resume", "route-run")
  resumePaused(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.resumePaused(
      id,
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      validateRunControlRequest(req.body),
    );
  }

  @Post(":id/resume-auth")
  @RequirePermission("run:resume", "route-run")
  resumeAuth(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.resumeAuth(id, { tenantId: principal.tenantId, actorUserId: principal.userId });
  }

  @Post(":id/resume-review")
  @RequirePermission("run:manual_data", "route-run")
  resumeReview(@Param("id") id: string, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.runs.resumeReview(id, { tenantId: principal.tenantId, actorUserId: principal.userId });
  }
}
