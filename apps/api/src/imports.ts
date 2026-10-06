import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { createHash, randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, UniqueConstraintError } from "sequelize";
import type { Request } from "express";
import { assessRegonEnrichmentEligibility, normalizeRegon } from "@goldis/core";
import {
  EntityGroupingConflict,
  ImportBatch,
  RegonCorrection,
  RegistryEnrichmentAudit,
  sequelize,
  SourceRow,
  Tool,
} from "./db";
import { readSessionClaims, SessionGuard, verifyCsrfRequest } from "./session";
import { PermissionGuard, RequirePermission } from "./authorization-guard";
import { readSessionPrincipal } from "./session";
import { parseTransportWorkbook } from "./workbook";
import { recordAuditEvent, type AuditActorContext } from "./audit";
import { sanitizePublicFileName, sanitizePublicText } from "./public-output";
import { HistoryService } from "./history";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RegonCorrectionRequest = Readonly<{
  proposedRegon: string;
  reason: string;
  expectedVersion: number;
}>;

@Injectable()
export class ImportService {
  async create(file: Express.Multer.File, tenantId: string, ownerUserId: string, toolId = "oc-policy-verification") {
    const tool = await Tool.findByPk(toolId, { attributes: ["toolId", "status"] });
    if (!tool || tool.status !== "available") throw new NotFoundException();
    const fileName = typeof file?.originalname === "string" ? sanitizePublicFileName(file.originalname, "") : "";
    if (!file?.buffer || !fileName.toLowerCase().endsWith(".xlsx")) throw new BadRequestException("Wybierz plik .xlsx");
    let rows;
    try {
      rows = await parseTransportWorkbook(file.buffer);
    } catch {
      throw new BadRequestException("Nie można odczytać pliku Excel lub wymaganych kolumn");
    }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const invalidRows = rows.filter((row) => row.issues.length > 0).length;
    const enrichment = rows.map((row) => assessRegonEnrichmentEligibility({
      regonRaw: row.regonRaw,
      effectiveRegon: row.effectiveRegon,
      nipRaw: row.nipRaw,
    }));
    const regonLookupReadyRows = enrichment.filter((result) => result.eligible).length;
    const regonLookupReviewRows = enrichment.filter((result) => !result.eligible && result.reasonCode !== "REGON_PRESENT").length;
    const batch = await sequelize.transaction(async (transaction) => {
      const created = await ImportBatch.create({
        tenantId, ownerUserId, toolId, fileName, sha256,
        totalRows: rows.length, invalidRows, createdAt: new Date(),
      }, { transaction });
      for (let start = 0; start < rows.length; start += 500) {
        await SourceRow.bulkCreate(rows.slice(start, start + 500).map((row) => ({
          batchId: created.id, rowNumber: row.rowNumber, companyName: row.companyName, decisionMakerName: row.decisionMakerName,
          nipRaw: row.nipRaw, address: row.address, postalCode: row.postalCode, city: row.city,
          regonRaw: row.regonRaw, regon: row.regon, effectiveRegon: row.effectiveRegon, issues: row.issues,
        })), { transaction });
      }
      await recordAuditEvent({
        tenantId, actorUserId: ownerUserId, action: "import.created", resourceType: "import",
        resourceId: created.id, outcome: "succeeded",
      }, transaction);
      return created;
    });
    return { id: batch.id, totalRows: rows.length, invalidRows, readyRows: rows.length - invalidRows, regonLookupReadyRows, regonLookupReviewRows, sha256 };
  }

  async get(id: string) {
    const batch = await ImportBatch.findByPk(id);
    if (!batch) throw new NotFoundException();
    return { id: batch.id, fileName: sanitizePublicFileName(batch.fileName), totalRows: batch.totalRows, invalidRows: batch.invalidRows, readyRows: batch.totalRows - batch.invalidRows, createdAt: batch.createdAt };
  }

  async rows(id: string, page: number, state: "all" | "ready" | "review") {
    await this.get(id);
    const limit = 50;
    const condition = state === "all" ? undefined : Sequelize.where(
      Sequelize.fn("jsonb_array_length", Sequelize.col("issues")),
      { [state === "ready" ? Op.eq : Op.gt]: 0 },
    );
    const result = await SourceRow.findAll({
      where: condition ? { [Op.and]: [{ batchId: id }, condition] } : { batchId: id },
      order: [["rowNumber", "ASC"]], limit, offset: (page - 1) * limit,
    });
    return result.map((row) => {
      const enrichment = assessRegonEnrichmentEligibility({
        regonRaw: row.regonRaw,
        effectiveRegon: row.effectiveRegon,
        nipRaw: row.nipRaw,
      });
      return {
        rowNumber: row.rowNumber,
        companyName: sanitizePublicText(row.companyName),
        decisionMakerName: row.decisionMakerName ? sanitizePublicText(row.decisionMakerName) : null,
        regon: sanitizePublicText(row.regonRaw),
        regonRaw: sanitizePublicText(row.regonRaw),
        effectiveRegon: row.effectiveRegon ? sanitizePublicText(row.effectiveRegon) : null,
        rowVersion: row.rowVersion,
        regonLookupEligibility: enrichment.eligible ? "eligible" as const : enrichment.reasonCode,
        issues: row.issues.map(sanitizePublicText),
      };
    });
  }

  async enrichmentReview(id: string, page: number) {
    if (!uuidPattern.test(id) || !Number.isInteger(page) || page < 1 || page > 100000) {
      throw new BadRequestException("Nieprawidłowy import lub strona przeglądu");
    }
    const batch = await this.get(id);
    const limit = 50;
    const [rows, missingRegonRows, pendingCorrectionRows, openConflictRows, lookupRows] = await Promise.all([
      SourceRow.findAll({
        where: { batchId: id }, order: [["rowNumber", "ASC"]], limit, offset: (page - 1) * limit,
      }),
      SourceRow.count({ where: { batchId: id, [Op.or]: [{ effectiveRegon: null }, { effectiveRegon: "" }] } }),
      RegonCorrection.count({
        where: { status: "pending" },
        include: [{ model: SourceRow, where: { batchId: id }, attributes: [], required: true }],
      }),
      EntityGroupingConflict.count({
        where: { status: "open" },
        include: [{ model: SourceRow, where: { batchId: id }, attributes: [], required: true }],
      }),
      sequelize.query<{ status: string; count: number }>(
        `SELECT latest.decision_status AS status, count(*)::int AS count
         FROM (
           SELECT DISTINCT ON (audit.source_row_id) audit.source_row_id, audit.decision_status
           FROM regon_enrichment_audits audit
           JOIN source_rows source ON source.id = audit.source_row_id
           WHERE source.batch_id = $1
           ORDER BY audit.source_row_id, audit.created_at DESC, audit.audit_id DESC
         ) latest
         GROUP BY latest.decision_status`,
        { bind: [id], type: QueryTypes.SELECT },
      ),
    ]);
    const sourceRowIds = rows.map((row) => row.id);
    const [corrections, audits, conflicts] = sourceRowIds.length === 0 ? [[], [], []] : await Promise.all([
      RegonCorrection.findAll({ where: { sourceRowId: sourceRowIds }, order: [["createdAt", "DESC"], ["correctionId", "DESC"]] }),
      RegistryEnrichmentAudit.findAll({ where: { sourceRowId: sourceRowIds }, order: [["createdAt", "DESC"], ["auditId", "DESC"]] }),
      EntityGroupingConflict.findAll({ where: { sourceRowId: sourceRowIds, status: "open" }, order: [["createdAt", "DESC"], ["conflictId", "DESC"]] }),
    ]);
    const firstBySource = <T extends { sourceRowId: string }>(items: readonly T[]) => {
      const latest = new Map<string, T>();
      for (const item of items) if (!latest.has(item.sourceRowId)) latest.set(item.sourceRowId, item);
      return latest;
    };
    const latestCorrection = firstBySource(corrections);
    const latestAudit = firstBySource(audits);
    const openConflict = firstBySource(conflicts);

    return {
      page,
      pageSize: limit,
      totalRows: batch.totalRows,
      summary: {
        missingRegonRows,
        pendingCorrectionRows,
        openConflictRows,
        lookupStatuses: Object.fromEntries(lookupRows.map(({ status, count }) => [status, count])),
      },
      rows: rows.map((row) => {
        const correction = latestCorrection.get(row.id);
        const audit = latestAudit.get(row.id);
        const conflict = openConflict.get(row.id);
        const appliedAudit = audit?.applied && audit.effectiveRegonAfter === row.effectiveRegon;
        const appliedCorrection = correction?.status === "approved" && correction.proposedRegon === row.effectiveRegon;
        const source = !row.effectiveRegon ? "missing"
          : appliedCorrection ? "manual"
            : appliedAudit ? "registry"
              : row.effectiveRegon === row.regon ? "import"
                : "unknown";
        const state = conflict ? "conflict"
          : correction?.status === "pending" ? "correction_pending"
            : row.issues.length > 0 ? "validation_review"
              : !row.effectiveRegon ? "missing_regon"
                : "ready";
        return {
          rowNumber: row.rowNumber,
          companyName: sanitizePublicText(row.companyName),
          decisionMakerName: row.decisionMakerName ? sanitizePublicText(row.decisionMakerName) : null,
          regonRaw: sanitizePublicText(row.regonRaw),
          effectiveRegon: row.effectiveRegon ? sanitizePublicText(row.effectiveRegon) : null,
          rowVersion: row.rowVersion,
          issues: row.issues.map(sanitizePublicText),
          state,
          source,
          correction: correction ? {
            correctionId: correction.correctionId,
            proposedRegon: sanitizePublicText(correction.proposedRegon),
            status: correction.status,
            reason: sanitizePublicText(correction.reason),
            createdAt: correction.createdAt,
          } : null,
          lookup: audit ? {
            status: audit.decisionStatus,
            reasonCode: audit.reasonCode,
            providerName: audit.providerName,
            providerVersion: audit.providerVersion,
            checkedAt: audit.createdAt,
          } : null,
          conflict: conflict ? {
            reasonCode: conflict.reasonCode,
            candidateCount: conflict.candidateEntityIds.length,
            createdAt: conflict.createdAt,
          } : null,
        };
      }),
    };
  }

  async proposeRegonCorrection(
    batchId: string,
    rowNumber: number,
    input: RegonCorrectionRequest,
    authorRef: string,
    actor?: AuditActorContext,
  ) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new BadRequestException("Brak danych korekty");
    }
    if (!uuidPattern.test(batchId) || !Number.isInteger(rowNumber) || rowNumber < 2
      || !Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 1) {
      throw new BadRequestException("Nieprawidłowy import, numer wiersza lub wersja danych");
    }
    if (typeof input.proposedRegon !== "string") throw new BadRequestException("REGON musi być tekstem");
    const normalized = normalizeRegon(input.proposedRegon);
    if (!normalized.normalized || normalized.issues.length > 0) throw new BadRequestException("Nieprawidłowy REGON");
    if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 1000) {
      throw new BadRequestException("Powód korekty musi mieć od 3 do 1000 znaków");
    }
    if (typeof authorRef !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(authorRef)) {
      throw new BadRequestException("Nieprawidłowy autor korekty");
    }

    try {
      return await sequelize.transaction(async (transaction) => {
        const row = await SourceRow.findOne({
          where: { batchId, rowNumber }, transaction, lock: transaction.LOCK.UPDATE,
        });
        if (!row) throw new NotFoundException("Nie znaleziono wiersza");
        if (row.rowVersion !== input.expectedVersion) {
          throw new ConflictException("Wiersz został zmieniony; odśwież dane przed kolejną korektą");
        }
        if (row.effectiveRegon === normalized.normalized) {
          throw new BadRequestException("Podany REGON jest już wartością operacyjną");
        }
        const pending = await RegonCorrection.findOne({
          where: { sourceRowId: row.id, status: "pending" }, transaction, lock: transaction.LOCK.UPDATE,
        });
        if (pending) throw new ConflictException("Wiersz ma już oczekującą korektę REGON");

        const createdAt = new Date();
        const correction = await RegonCorrection.create({
          correctionId: randomUUID(),
          sourceRowId: row.id,
          authorRef,
          reason: input.reason.trim(),
          previousRegon: row.effectiveRegon,
          proposedRegon: normalized.normalized,
          status: "pending",
          reviewerRef: null,
          reviewedAt: null,
          reviewReason: null,
          createdAt,
        }, { transaction });
        row.rowVersion += 1;
        await row.save({ transaction });
        if (actor) {
          await recordAuditEvent({
            tenantId: actor.tenantId, actorUserId: actor.actorUserId,
            action: "regon.correction.proposed", resourceType: "correction",
            resourceId: correction.correctionId, outcome: "succeeded",
          }, transaction);
        }
        return {
          correctionId: correction.correctionId,
          rowNumber: row.rowNumber,
          previousRegon: correction.previousRegon,
          proposedRegon: correction.proposedRegon,
          status: correction.status,
          rowVersion: row.rowVersion,
          createdAt: correction.createdAt,
        };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new ConflictException("Wiersz ma już oczekującą korektę REGON");
      }
      throw error;
    }
  }
}

@Controller("imports")
@UseGuards(SessionGuard, PermissionGuard)
export class ImportController {
  constructor(private readonly imports: ImportService, private readonly history: HistoryService) {}

  @Get()
  @RequirePermission("batch:read", "collection")
  list(@Req() request: Request, @Query() query: { toolId?: string; dataState?: string; from?: string; to?: string; cursor?: string; limit?: string }) {
    const actor = readSessionPrincipal(request);
    if (!actor) throw new ForbiddenException("Brak aktywnej sesji");
    return this.history.imports(actor, query);
  }

  @Post()
  @RequirePermission("batch:create", "new-batch")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 16 * 1024 * 1024 } }))
  create(@UploadedFile() file: Express.Multer.File, @Req() request: Request) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak uprawnień do utworzenia importu");
    return this.imports.create(file, principal.tenantId, principal.userId);
  }

  @Post("tool/:toolId")
  @RequirePermission("batch:create", "new-batch")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 16 * 1024 * 1024 } }))
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
    if (state !== "all" && state !== "ready" && state !== "review") throw new BadRequestException("Nieprawidłowy filtr");
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
    @Body() body: RegonCorrectionRequest,
    @Req() request: Request,
  ) {
    if (!verifyCsrfRequest(request)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const claims = readSessionClaims(request);
    if (!claims) throw new ForbiddenException("Brak uprawnień do korekty");
    const rowNumber = Number(rawRowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new BadRequestException("Nieprawidłowy numer wiersza");
    const principal = readSessionPrincipal(request);
    if (!principal) throw new ForbiddenException("Brak uprawnień do korekty");
    return this.imports.proposeRegonCorrection(id, rowNumber, body, claims.actorRef, {
      tenantId: principal.tenantId, actorUserId: principal.userId,
    });
  }
}
