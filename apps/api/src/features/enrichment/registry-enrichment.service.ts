import { createHash, randomUUID } from "node:crypto";
import { assessRegonEnrichmentEligibility } from "@goldis/core";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { assessRegistryResult } from "../../contracts/registry-result";
import { EntityGroupingService } from "../grouping/public";
import { RegistryEnrichmentRepository } from "./registry-enrichment.repository";
import type { RegistryProviderResult } from "./registry-provider";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const registryCacheTtlMs = 24 * 60 * 60 * 1000;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !value.includes("\0");
}

function validateProviderResult(value: RegistryProviderResult): void {
  if (
    !value ||
    typeof value !== "object" ||
    !boundedText(value.providerName, 120) ||
    !boundedText(value.providerVersion, 80) ||
    !(
      value.dataVersion === null ||
      (typeof value.dataVersion === "string" && value.dataVersion.length <= 120 && !value.dataVersion.includes("\0"))
    ) ||
    !(value.fetchedAt instanceof Date) ||
    !Number.isFinite(value.fetchedAt.getTime()) ||
    !Array.isArray(value.candidates) ||
    value.candidates.some((candidate) => !candidate || typeof candidate !== "object" || Array.isArray(candidate))
  ) {
    throw new BadRequestException("Nieprawidłowy wynik dostawcy rejestru");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(result: RegistryProviderResult): string {
  try {
    return hash(
      JSON.stringify({
        providerName: result.providerName,
        providerVersion: result.providerVersion,
        dataVersion: result.dataVersion,
        fetchedAt: result.fetchedAt.toISOString(),
        candidates: result.candidates,
      }),
    );
  } catch {
    throw new BadRequestException("Odpowiedź rejestru nie może zostać bezpiecznie odciskowana");
  }
}

@Injectable()
export class RegistryEnrichmentService {
  constructor(
    private readonly grouping: EntityGroupingService = new EntityGroupingService(),
    private readonly repository: RegistryEnrichmentRepository = new RegistryEnrichmentRepository(),
  ) {}

  async recordResult(
    batchId: string,
    rowNumber: number,
    expectedRowVersion: number,
    result: RegistryProviderResult,
    parentTransaction?: Transaction,
  ) {
    if (
      !uuidPattern.test(batchId) ||
      !Number.isInteger(rowNumber) ||
      rowNumber < 2 ||
      !Number.isSafeInteger(expectedRowVersion) ||
      expectedRowVersion < 1
    ) {
      throw new BadRequestException("Nieprawidłowy import, wiersz lub wersja danych");
    }
    validateProviderResult(result);
    const responseFingerprint = fingerprint(result);
    const dataVersionLabel = result.dataVersion?.trim() || null;
    const dataVersionHash = hash(
      `${result.providerName}\0${result.providerVersion}\0${dataVersionLabel ?? "unversioned"}`,
    );

    return this.repository.transaction(parentTransaction, async (transaction) => {
      const batch = await this.repository.findBatchForUpdate(batchId, transaction);
      if (!batch) throw new NotFoundException("Nie znaleziono importu");
      const row = await this.repository.findSourceRowForUpdate(batchId, rowNumber, transaction);
      if (!row) throw new NotFoundException("Nie znaleziono wiersza importu");
      if (row.rowVersion !== expectedRowVersion) {
        throw new ConflictException("Wiersz został zmieniony; odśwież dane przed zapisaniem wzbogacenia");
      }
      const pendingCorrection = await this.repository.findPendingCorrectionForUpdate(row.id, transaction);
      if (pendingCorrection) {
        throw new ConflictException("Najpierw rozstrzygnij oczekującą korektę REGON");
      }
      const eligibility = assessRegonEnrichmentEligibility({
        regonRaw: row.regonRaw,
        effectiveRegon: row.effectiveRegon,
        nipRaw: row.nipRaw,
      });
      if (!eligibility.eligible) {
        throw new ConflictException("Wiersz nie kwalifikuje się już do wzbogacenia NIP → REGON");
      }
      if (await this.repository.hasRunForSourceRow(batchId, row.id, transaction)) {
        throw new ConflictException("Wiersz należy już do zadania; nie można zmienić jego tożsamości");
      }

      const decision = assessRegistryResult({
        expectedNip: eligibility.nipNormalized,
        expectedCompanyName: row.companyName,
        result,
      });
      const before = row.effectiveRegon;
      const applied = decision.status === "matched";
      const proposedRegon = applied ? decision.regon : null;
      const after = applied ? decision.regon : before;
      const rowVersionBefore = row.rowVersion;
      const rowVersionAfter = rowVersionBefore + 1;
      const now = new Date();

      if (applied) {
        row.effectiveRegon = decision.regon;
        row.issues = row.issues.filter((issue) => issue !== "REGON_EMPTY");
      }
      row.rowVersion = rowVersionAfter;
      await this.repository.saveSourceRow(row, transaction);

      const audit = await this.repository.createAudit(
        {
          auditId: randomUUID(),
          sourceRowId: row.id,
          nipNormalized: eligibility.nipNormalized,
          providerName: result.providerName.trim(),
          providerVersion: result.providerVersion.trim(),
          dataVersionLabel,
          dataVersionHash,
          responseFingerprint,
          candidateCount: result.candidates.length,
          decisionStatus: decision.status,
          reasonCode: "reasonCode" in decision ? decision.reasonCode : null,
          proposedRegon,
          effectiveRegonBefore: before,
          effectiveRegonAfter: after,
          applied,
          rowVersionBefore,
          rowVersionAfter,
          createdAt: now,
        },
        transaction,
      );

      await this.repository.upsertLookupCache({
        lookupId: randomUUID(),
        nipNormalized: eligibility.nipNormalized,
        dataVersionHash,
        status: decision.status,
        candidateCount: result.candidates.length,
        responseFingerprint,
        errorCode: "reasonCode" in decision ? decision.reasonCode : null,
        now,
        expiresAt: new Date(now.getTime() + registryCacheTtlMs),
        transaction,
      });

      if (applied) await this.grouping.resolveSourceRow(batchId, rowNumber, transaction, false);

      return {
        auditId: audit.auditId,
        rowNumber: row.rowNumber,
        rowVersion: rowVersionAfter,
        decision,
        effectiveRegon: row.effectiveRegon,
      };
    });
  }
}
