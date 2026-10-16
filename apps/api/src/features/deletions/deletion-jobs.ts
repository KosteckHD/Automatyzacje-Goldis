import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { DeletionJobsService } from "./deletion-jobs.service";

@Controller("deletions")
@UseGuards(SessionGuard)
export class DeletionJobController {
  constructor(@Optional() @Inject(DeletionJobsService) private readonly jobs = new DeletionJobsService()) {}

  @Post("jobs")
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@Req() request: Request, @Body() input: unknown) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const actor = readSessionPrincipal(request);
    if (!actor?.sessionId) throw new ForbiddenException();
    return this.jobs.create(actor, input);
  }
  @Get("jobs/:jobId")
  async get(@Param("jobId") jobId: string, @Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException();
    return this.jobs.get(actor, jobId);
  }

  @Get("jobs")
  async list(@Req() request: Request) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException();
    return this.jobs.list(actor);
  }
}
