import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { readSessionClaims, readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { PermissionGuard, RequirePermission } from "../authorization/public";
import { HistoryService } from "../reports/public";
import { parseRegonCorrectionRequest } from "./import.dto";
import { ImportService } from "./import.service";
@Controller("imports")
@UseGuards(SessionGuard, PermissionGuard)
export class ImportController {
  constructor(
    @Inject(ImportService) private readonly imports: ImportService,
    @Inject(HistoryService) private readonly history: HistoryService,
  ) {}

  @Get()
  @RequirePermission("batch:read", "collection")
  list(
    @Req() request: Request,
    @Query() query: {
      toolId?: string;
      dataState?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: string;
    },
  ) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return this.history.imports(actor, query);
  }

  @Post()
  @RequirePermission("batch:create", "new-batch")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 0, parts: 1, headerPairs: 100 },
    }),
  )
  create(@UploadedFile() file: Express.Multer.File, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak uprawnień do utworzenia importu");
    return this.imports.create(file, principal.tenantId, principal.userId);
  }

  @Post("tool/:toolId")
  @RequirePermission("batch:create", "new-batch")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 0, parts: 1, headerPairs: 100 },
    }),
  )
  createForTool(@Param("toolId") toolId: string, @UploadedFile() file: Express.Multer.File, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak uprawnień do utworzenia importu");
    return this.imports.create(file, principal.tenantId, principal.userId, toolId);
  }

  @Get(":id")
  @RequirePermission("batch:read", "route-batch")
  get(@Param("id") id: string) {
    return this.imports.get(id);
  }

  @Get(":id/rows")
  @RequirePermission("batch:read", "route-batch")
  rows(@Param("id") id: string, @Query("page") rawPage?: string, @Query("state") rawState?: string) {
    const page = rawPage ? Number(rawPage) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw new BadRequestException("Nieprawidłowa strona");
    const state = rawState ?? "all";
    if (state !== "all" && state !== "ready" && state !== "review")
      throw new BadRequestException("Nieprawidłowy filtr");
    return this.imports.rows(id, page, state);
  }

  @Get(":id/enrichment")
  @RequirePermission("enrichment:read", "route-batch")
  enrichmentReview(@Param("id") id: string, @Query("page") rawPage?: string) {
    const page = rawPage ? Number(rawPage) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw new BadRequestException("Nieprawidłowa strona");
    return this.imports.enrichmentReview(id, page);
  }

  @Patch(":id/rows/:rowNumber")
  @RequirePermission("correction:propose", "route-batch")
  proposeRegonCorrection(
    @Param("id") id: string,
    @Param("rowNumber") rawRowNumber: string,
    @Body() rawBody: unknown,
    @Req() request: Request,
  ) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const claims = readSessionClaims(request);
    if (!claims) throw new ForbiddenException("Brak uprawnień do korekty");
    const rowNumber = Number(rawRowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new BadRequestException("Nieprawidłowy numer wiersza");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak uprawnień do korekty");
    return this.imports.proposeRegonCorrection(id, rowNumber, parseRegonCorrectionRequest(rawBody), claims.actorRef, {
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
    });
  }
}
