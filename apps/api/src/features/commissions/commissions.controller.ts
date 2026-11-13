import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "../auth/public";
import { canAccessTool } from "../authorization/public";
import { CommissionsService } from "./commissions.service";

const TOOL = "commission-comparison";

@Controller("tools/commission-comparison")
@UseGuards(SessionGuard)
export class CommissionsController {
  constructor(@Inject(CommissionsService) private readonly commissions: CommissionsService) {}

  @Get("agents")
  async agents(@Req() request: Request) {
    const actor = await this.authorize(request, "view_results");
    return this.commissions.listAgents(actor);
  }

  @Get("files")
  async files(@Req() request: Request) {
    const actor = await this.authorize(request, "view_results");
    return { items: await this.commissions.listFiles(actor) };
  }

  @Post("files")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 1, parts: 2, headerPairs: 100 },
    }),
  )
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body("sourceType") sourceType: string,
    @Req() request: Request,
  ) {
    const actor = await this.authorize(request, "execute", true);
    if (!file || !["CRM", "ASF", "WARTA"].includes(sourceType))
      throw new BadRequestException("COMMISSION_UPLOAD_INVALID");
    return this.commissions.uploadFile(actor, file, sourceType as "CRM" | "ASF" | "WARTA");
  }

  @Delete("files/:fileId")
  async deleteFile(@Param("fileId") fileId: string, @Req() request: Request) {
    const actor = await this.authorize(request, "execute", true);
    return this.commissions.deleteFile(actor, fileId);
  }

  @Get("dictionary/versions")
  async dictionaries(@Req() request: Request) {
    const actor = await this.authorize(request, "view_results");
    return this.commissions.listDictionaries(actor);
  }

  @Get("dictionary/versions/:versionId")
  async dictionary(@Param("versionId") versionId: string, @Req() request: Request) {
    const actor = await this.authorize(request, "view_results");
    return this.commissions.getDictionary(actor, versionId);
  }

  @Get("dictionary/active")
  async activeDictionary(@Req() request: Request) {
    const actor = await this.authorize(request, "view_results");
    return this.commissions.getDictionary(actor);
  }

  @Post("dictionary/versions/:versionId/activate")
  async activateDictionary(@Param("versionId") versionId: string, @Req() request: Request) {
    const actor = await this.authorize(request, "execute", true);
    return this.commissions.activateDictionary(actor, versionId);
  }

  @Post("dictionary/import")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 0, parts: 1, headerPairs: 100 },
    }),
  )
  async importDictionary(@UploadedFile() file: Express.Multer.File, @Req() request: Request) {
    const actor = await this.authorize(request, "execute", true);
    if (!file) throw new BadRequestException("COMMISSION_WORKBOOK_REQUIRED");
    return this.commissions.importDictionary(actor, file);
  }

  @Patch("dictionary/drafts/:versionId/entries/:entryId")
  async editDictionary(
    @Param("versionId") versionId: string,
    @Param("entryId") entryId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const actor = await this.authorize(request, "execute", true);
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("CSRF_REQUIRED");
    return this.commissions.editDictionaryEntry(actor, versionId, entryId, body);
  }

  @Post("dictionary/drafts/:versionId/publish")
  async publishDictionary(
    @Param("versionId") versionId: string,
    @Body() body: { revision: number },
    @Req() request: Request,
  ) {
    const actor = await this.authorize(request, "execute", true);
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("CSRF_REQUIRED");
    return this.commissions.publishDictionary(actor, versionId, body.revision);
  }

  @Post("runs")
  @HttpCode(202)
  async createRun(
    @Body() body: { start: string; end: string; fileIds: string[]; idempotencyKey: string },
    @Req() request: Request,
  ) {
    const actor = await this.authorize(request, "execute", true);
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("CSRF_REQUIRED");
    return this.commissions.createRun(actor, body);
  }

  @Get("runs")
  async runs(@Req() request: Request) {
    const actor = await this.authorize(request, "view_results");
    return this.commissions.listRuns(actor);
  }

  @Get("runs/:runId")
  async run(@Param("runId") runId: string, @Req() request: Request) {
    const actor = await this.authorize(request, "view_results");
    return this.commissions.getRun(actor, runId);
  }

  @Post("runs/:runId/exports")
  async createExport(@Param("runId") runId: string, @Req() request: Request) {
    const actor = await this.authorize(request, "download_results", true);
    return this.commissions.createExport(actor, runId);
  }

  @Get("exports/:exportId/download")
  @Header("Cache-Control", "no-store")
  async downloadExport(@Param("exportId") exportId: string, @Req() request: Request) {
    const actor = await this.authorize(request, "download_results");
    const file = await this.commissions.downloadExport(actor, exportId);
    return new StreamableFile(file.bytes, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      disposition: `attachment; filename="${file.fileName}"`,
    });
  }

  @Post("runs/:runId/cancel")
  async cancel(@Param("runId") runId: string, @Req() request: Request) {
    const actor = await this.authorize(request, "execute", true);
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("CSRF_REQUIRED");
    return this.commissions.cancelRun(actor, runId);
  }

  @Post("runs/:runId/resolutions")
  async resolution(
    @Param("runId") runId: string,
    @Body() body: { findingKey: string; decisionCode: string; note?: string },
    @Req() request: Request,
  ) {
    const actor = await this.authorize(request, "execute", true);
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("CSRF_REQUIRED");
    return this.commissions.addResolution(actor, runId, body);
  }

  private async authorize(
    request: Request,
    capability: "execute" | "view_results" | "download_results",
    requireCsrf = false,
  ) {
    if (requireCsrf && !verifyCsrfRequest(request)) throw new ForbiddenException("CSRF_REQUIRED");
    const actor = readSessionPrincipal(request);
    if (!actor || !(await canAccessTool(actor, TOOL, capability)))
      throw new ForbiddenException("COMMISSION_TOOL_ACCESS_DENIED");
    return actor;
  }
}
