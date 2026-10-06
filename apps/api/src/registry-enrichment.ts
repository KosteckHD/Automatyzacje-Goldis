import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { QueryTypes, type Transaction } from "sequelize";
import { createHash, randomUUID } from "node:crypto";
import { assessRegonEnrichmentEligibility } from "@goldis/core";
import { ImportBatch, RegonCorrection, RegistryEnrichmentAudit, sequelize, SourceRow } from "./db";
import { RegistryProviderResult } from "./registry-provider";
import { assessRegistryResult } from "./registry-result";
import { EntityGroupingService } from "./entity-grouping-service";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const registryCacheTtlMs = 24 * 60 * 60 * 1000;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !value.includes("\0");
}

function validateProviderResult(value: RegistryProviderResult): void {
  if (!value || typeof value !== "object"
    || !boundedText(value.providerName, 120)
    || !boundedText(value.providerVersion, 80)
    || !(value.dataVersion === null || (typeof value.dataVersion === "string" && value.dataVersion.length <= 120 && !value.dataVersion.includes("\0")))
    || !(value.fetchedAt instanceof Date) || !Number.isFinite(value.fetchedAt.getTime())
    || !Array.isArray(value.candidates)
    || value.candidates.some((candidate) => !candidate || typeof candidate !== "object" || Array.isArray(candidate))) {
    throw new BadRequestException("Nieprawidłowy wynik dostawcy rejestru");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(result: RegistryProviderResult): string {
  try {
    return hash(JSON.stringify({
      providerName: result.providerName,
      providerVersion: result.providerVersion,
      dataVersion: result.dataVersion,
      fetchedAt: result.fetchedAt.toISOString(),
      candidates: result.candidates,
    }));
  } catch {
    throw new BadRequestException("Odpowiedź rejestru nie może zostać bezpiecznie odciskowana");
  }
}

@Injectable()
export class RegistryEnrichmentService {
  constructor(private readonly grouping: EntityGroupingService = new EntityGroupingService()) {}

  async recordResult(batchId: string, rowNumber: number, expectedRowVersion: number, result: RegistryProviderResult, parentTransaction?: Transaction) {
    if (!uuidPattern.test(batchId) || !Number.isInteger(rowNumber) || rowNumber < 2
      || !Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 1) {
      throw new BadRequestException("Nieprawidłowy import, wiersz lub wersja danych");
    }
    validateProviderResult(result);
    const responseFingerprint = fingerprint(result);
    const dataVersionLabel = result.dataVersion?.trim() || null;
    const dataVersionHash = hash(`${result.providerName}\0${result.providerVersion}\0${dataVersionLabel ?? "unversioned"}`);

    return sequelize.transaction(parentTransaction ? { transaction: parentTransaction } : {}, async (transaction) => {
      const batch = await ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!batch) throw new NotFoundException("Nie znaleziono importu");
      const row = await SourceRow.findOne({
        where: { batchId, rowNumber }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw new NotFoundException("Nie znaleziono wiersza importu");
      if (row.rowVersion !== expectedRowVersion) {
        throw new ConflictException("Wiersz został zmieniony; odśwież dane przed zapisaniem wzbogacenia");
      }
      const pendingCorrection = await RegonCorrection.findOne({
        where: { sourceRowId: row.id, status: "pending" }, transaction, lock: transaction.LOCK.UPDATE,
      });
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
      const existingRuns = await sequelize.query<{ id: string }>(
        `SELECT run.id FROM automation_runs AS run
          WHERE run.batch_id = $1 AND (run.source_row_id = $2 OR EXISTS (
            SELECT 1 FROM run_source_rows AS member WHERE member.run_id = run.id AND member.source_row_id = $2
          ))
          LIMIT 1 FOR UPDATE OF run`,
        { bind: [batchId, row.id], transaction, type: QueryTypes.SELECT },
      );
      if (existingRuns.length > 0) throw new ConflictException("Wiersz należy już do zadania; nie można zmienić jego tożsamości");

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
      await row.save({ transaction });

      const audit = await RegistryEnrichmentAudit.create({
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
      }, { transaction });

      await sequelize.query(
        `INSERT INTO registry_lookup_cache (
           lookup_id, nip_normalized, data_version, status, result_count, response_fingerprint,
           attempt_count, error_code, checked_at, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $8, $8)
         ON CONFLICT (nip_normalized, data_version) DO UPDATE SET
           status = EXCLUDED.status,
           result_count = EXCLUDED.result_count,
           response_fingerprint = EXCLUDED.response_fingerprint,
           attempt_count = LEAST(registry_lookup_cache.attempt_count + 1, 10),
           error_code = EXCLUDED.error_code,
           checked_at = EXCLUDED.checked_at,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at`,
        {
          bind: [randomUUID(), eligibility.nipNormalized, dataVersionHash, decision.status,
            result.candidates.length, responseFingerprint,
            "reasonCode" in decision ? decision.reasonCode : null,
            now, new Date(now.getTime() + registryCacheTtlMs)],
          transaction,
        },
      );

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
