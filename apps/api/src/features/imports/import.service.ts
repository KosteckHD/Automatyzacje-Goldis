import { createHash } from "node:crypto";
import { assessRegonEnrichmentEligibility, normalizeRegon } from "@goldis/core";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { type Sequelize, UniqueConstraintError } from "sequelize";
import { isResourceTombstoned } from "../../contracts/deletion-barrier";
import { loadApiRuntimeConfig, loadApiSecretConfig } from "../../infrastructure/config";
import { API_DATABASE } from "../../infrastructure/database";
import { sanitizePublicFileName, sanitizePublicPhone, sanitizePublicText } from "../../infrastructure/http";
import { type AuditActorContext, AuditService } from "../audit/public";
import type { RegonCorrectionRequest } from "./import.dto";
import { ImportParserClientError, parseImportWorkbookRemotely } from "./import-parser-client";
import { ImportsRepository } from "./imports.repository";
import { parseTransportWorkbook } from "./workbook";
import { WorkbookArchiveError } from "./workbook-archive";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type { RegonCorrectionRequest } from "./import.dto";

@Injectable()
export class ImportService {
  constructor(
    @Inject(API_DATABASE) private readonly database: Sequelize,
    @Inject(ImportsRepository) private readonly repository: ImportsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(file: Express.Multer.File, tenantId: string, ownerUserId: string, toolId = "oc-policy-verification") {
    if (!(await this.repository.isToolAvailable(toolId))) throw new NotFoundException();
    const fileName = typeof file?.originalname === "string" ? sanitizePublicFileName(file.originalname, "") : "";
    if (!file?.buffer || !fileName.toLowerCase().endsWith(".xlsx")) throw new BadRequestException("Wybierz plik .xlsx");
    let rows: Awaited<ReturnType<typeof parseTransportWorkbook>>;
    try {
      const runtimeConfig = loadApiRuntimeConfig();
      if (runtimeConfig.importParserUrl)
        rows = await parseImportWorkbookRemotely(file.buffer, {
          APP_ENV: runtimeConfig.appEnvironment,
          IMPORT_PARSER_URL: runtimeConfig.importParserUrl,
          IMPORT_PARSER_SHARED_SECRET: loadApiSecretConfig().importParserSharedSecret,
        });
      else if (runtimeConfig.appEnvironment === "production")
        throw new ImportParserClientError("IMPORT_PARSER_UNAVAILABLE");
      else rows = await parseTransportWorkbook(file.buffer);
    } catch (error) {
      if (error instanceof ImportParserClientError) {
        if (error.code === "IMPORT_LIMITS_EXCEEDED")
          throw new PayloadTooLargeException("Plik przekracza bezpieczne limity importu");
        if (error.code === "IMPORT_CAPACITY_EXCEEDED")
          throw new HttpException(
            {
              message: "Import jest chwilowo zajęty",
              retryAfterSeconds: error.retryAfterSeconds ?? 2,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        if (error.code === "IMPORT_PARSE_TIMEOUT")
          throw new UnprocessableEntityException("Przekroczono czas odczytu pliku");
        if (error.code === "IMPORT_PARSER_UNAVAILABLE")
          throw new ServiceUnavailableException("Odczyt importu jest chwilowo niedostępny");
      }
      if (error instanceof WorkbookArchiveError) {
        if (error.code === "IMPORT_LIMITS_EXCEEDED")
          throw new PayloadTooLargeException("Plik przekracza bezpieczne limity importu");
        if (error.code === "IMPORT_CAPACITY_EXCEEDED")
          throw new HttpException("Import jest chwilowo zajęty", HttpStatus.TOO_MANY_REQUESTS);
        if (error.code === "IMPORT_PARSE_TIMEOUT")
          throw new UnprocessableEntityException("Przekroczono czas odczytu pliku");
      }
      throw new UnprocessableEntityException("Nie można odczytać pliku Excel lub wymaganych kolumn");
    }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const invalidRows = rows.filter((row) => row.issues.length > 0).length;
    const enrichment = rows.map((row) =>
      assessRegonEnrichmentEligibility({
        regonRaw: row.regonRaw,
        effectiveRegon: row.effectiveRegon,
        nipRaw: row.nipRaw,
      }),
    );
    const regonLookupReadyRows = enrichment.filter((result) => result.eligible).length;
    const regonLookupReviewRows = enrichment.filter(
      (result) => !result.eligible && result.reasonCode !== "REGON_PRESENT",
    ).length;
    const batch = await this.database.transaction(async (transaction) => {
      const created = await this.repository.createBatch(
        {
          tenantId,
          ownerUserId,
          toolId,
          fileName,
          sha256,
          totalRows: rows.length,
          invalidRows,
          createdAt: new Date(),
        },
        transaction,
      );
      await this.repository.createRows(
        created.id,
        rows.map((row) => ({
          rowNumber: row.rowNumber,
          companyName: row.companyName,
          decisionMakerName: row.decisionMakerName,
          mobile: row.mobile ?? "",
          phone: row.phone ?? "",
          email: row.email ?? "",
          nipRaw: row.nipRaw,
          address: row.address,
          postalCode: row.postalCode,
          city: row.city,
          regonRaw: row.regonRaw,
          regon: row.regon,
          effectiveRegon: row.effectiveRegon,
          issues: row.issues,
        })),
        transaction,
      );
      await this.audit.record(
        {
          tenantId,
          actorUserId: ownerUserId,
          action: "import.created",
          resourceType: "import",
          resourceId: created.id,
          outcome: "succeeded",
        },
        transaction,
      );
      return created;
    });
    return {
      id: batch.id,
      totalRows: rows.length,
      invalidRows,
      readyRows: rows.length - invalidRows,
      regonLookupReadyRows,
      regonLookupReviewRows,
      sha256,
    };
  }

  async get(id: string) {
    const batch = await this.repository.findBatch(id);
    if (!batch || (await isResourceTombstoned("import", id))) throw new NotFoundException();
    return {
      id: batch.id,
      fileName: sanitizePublicFileName(batch.fileName),
      totalRows: batch.totalRows,
      invalidRows: batch.invalidRows,
      readyRows: batch.totalRows - batch.invalidRows,
      createdAt: batch.createdAt,
    };
  }

  async rows(id: string, page: number, state: "all" | "ready" | "review") {
    await this.get(id);
    const result = await this.repository.findRows(id, page, state);
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
        mobile: sanitizePublicPhone(row.mobile),
        phone: sanitizePublicPhone(row.phone),
        email: sanitizePublicText(row.email),
        regon: sanitizePublicText(row.regonRaw),
        regonRaw: sanitizePublicText(row.regonRaw),
        effectiveRegon: row.effectiveRegon ? sanitizePublicText(row.effectiveRegon) : null,
        rowVersion: row.rowVersion,
        regonLookupEligibility: enrichment.eligible ? ("eligible" as const) : enrichment.reasonCode,
        issues: row.issues.map(sanitizePublicText),
      };
    });
  }

  async enrichmentReview(id: string, page: number) {
    if (!uuidPattern.test(id) || !Number.isInteger(page) || page < 1 || page > 100000) {
      throw new BadRequestException("Nieprawidłowy import lub strona przeglądu");
    }
    const batch = await this.get(id);
    const {
      rows,
      missingRegonRows,
      pendingCorrectionRows,
      openConflictRows,
      lookupRows,
      corrections,
      audits,
      conflicts,
    } = await this.repository.findEnrichmentReview(id, page);
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
      pageSize: 50,
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
        const source = !row.effectiveRegon
          ? "missing"
          : appliedCorrection
            ? "manual"
            : appliedAudit
              ? "registry"
              : row.effectiveRegon === row.regon
                ? "import"
                : "unknown";
        const state = conflict
          ? "conflict"
          : correction?.status === "pending"
            ? "correction_pending"
            : row.issues.length > 0
              ? "validation_review"
              : !row.effectiveRegon
                ? "missing_regon"
                : "ready";
        return {
          rowNumber: row.rowNumber,
          companyName: sanitizePublicText(row.companyName),
          decisionMakerName: row.decisionMakerName ? sanitizePublicText(row.decisionMakerName) : null,
          mobile: sanitizePublicPhone(row.mobile),
          phone: sanitizePublicPhone(row.phone),
          email: sanitizePublicText(row.email),
          regonRaw: sanitizePublicText(row.regonRaw),
          effectiveRegon: row.effectiveRegon ? sanitizePublicText(row.effectiveRegon) : null,
          rowVersion: row.rowVersion,
          issues: row.issues.map(sanitizePublicText),
          state,
          source,
          correction: correction
            ? {
                correctionId: correction.correctionId,
                proposedRegon: sanitizePublicText(correction.proposedRegon),
                status: correction.status,
                reason: sanitizePublicText(correction.reason),
                createdAt: correction.createdAt,
              }
            : null,
          lookup: audit
            ? {
                status: audit.decisionStatus,
                reasonCode: audit.reasonCode,
                providerName: audit.providerName,
                providerVersion: audit.providerVersion,
                checkedAt: audit.createdAt,
              }
            : null,
          conflict: conflict
            ? {
                reasonCode: conflict.reasonCode,
                candidateCount: conflict.candidateEntityIds.length,
                createdAt: conflict.createdAt,
              }
            : null,
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
    if (
      !uuidPattern.test(batchId) ||
      !Number.isInteger(rowNumber) ||
      rowNumber < 2 ||
      !Number.isSafeInteger(input?.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new BadRequestException("Nieprawidłowy import, numer wiersza lub wersja danych");
    }
    if (typeof input.proposedRegon !== "string") throw new BadRequestException("REGON musi być tekstem");
    const normalized = normalizeRegon(input.proposedRegon);
    if (!normalized.normalized || normalized.issues.length > 0) throw new BadRequestException("Nieprawidłowy REGON");
    const normalizedRegon = normalized.normalized;
    if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 1000) {
      throw new BadRequestException("Powód korekty musi mieć od 3 do 1000 znaków");
    }
    if (typeof authorRef !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(authorRef)) {
      throw new BadRequestException("Nieprawidłowy autor korekty");
    }

    try {
      return await this.database.transaction(async (transaction) => {
        const result = await this.repository.proposeRegonCorrection({
          batchId,
          rowNumber,
          authorRef,
          reason: input.reason.trim(),
          proposedRegon: normalizedRegon,
          expectedVersion: input.expectedVersion,
          transaction,
        });
        if (result.kind === "not_found") throw new NotFoundException("Nie znaleziono wiersza");
        if (result.kind === "stale")
          throw new ConflictException("Wiersz został zmieniony; odśwież dane przed kolejną korektą");
        if (result.kind === "same_regon") throw new BadRequestException("Podany REGON jest już wartością operacyjną");
        if (result.kind === "pending") throw new ConflictException("Wiersz ma już oczekującą korektę REGON");
        const { correction, row } = result;
        if (actor) {
          await this.audit.record(
            {
              tenantId: actor.tenantId,
              actorUserId: actor.actorUserId,
              action: "regon.correction.proposed",
              resourceType: "correction",
              resourceId: correction.correctionId,
              outcome: "succeeded",
            },
            transaction,
          );
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
