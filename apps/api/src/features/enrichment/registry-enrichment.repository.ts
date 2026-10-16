import { Inject, Injectable } from "@nestjs/common";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import {
  ImportBatch,
  RegistryEnrichmentAudit,
  RegonCorrection,
  SourceRow,
  sequelize,
} from "../../infrastructure/database/db";

@Injectable()
export class RegistryEnrichmentRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize = sequelize) {}

  transaction<T>(parentTransaction: Transaction | undefined, work: (transaction: Transaction) => Promise<T>) {
    return this.database.transaction(parentTransaction ? { transaction: parentTransaction } : {}, work);
  }

  findBatchForUpdate(batchId: string, transaction: Transaction) {
    return ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  findSourceRowForUpdate(batchId: string, rowNumber: number, transaction: Transaction) {
    return SourceRow.findOne({ where: { batchId, rowNumber }, transaction, lock: transaction.LOCK.UPDATE });
  }

  findPendingCorrectionForUpdate(sourceRowId: string, transaction: Transaction) {
    return RegonCorrection.findOne({
      where: { sourceRowId, status: "pending" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  async hasRunForSourceRow(batchId: string, sourceRowId: string, transaction: Transaction) {
    const rows = await this.database.query<{ id: string }>(
      `SELECT run.id FROM automation_runs AS run
        WHERE run.batch_id = $1 AND (run.source_row_id = $2 OR EXISTS (
          SELECT 1 FROM run_source_rows AS member WHERE member.run_id = run.id AND member.source_row_id = $2
        ))
        LIMIT 1 FOR UPDATE OF run`,
      { bind: [batchId, sourceRowId], transaction, type: QueryTypes.SELECT },
    );
    return rows.length > 0;
  }

  saveSourceRow(row: SourceRow, transaction: Transaction) {
    return row.save({ transaction });
  }

  createAudit(input: Parameters<typeof RegistryEnrichmentAudit.create>[0], transaction: Transaction) {
    return RegistryEnrichmentAudit.create(input, { transaction });
  }

  upsertLookupCache(input: {
    lookupId: string;
    nipNormalized: string;
    dataVersionHash: string;
    status: string;
    candidateCount: number;
    responseFingerprint: string;
    errorCode: string | null;
    now: Date;
    expiresAt: Date;
    transaction: Transaction;
  }) {
    return this.database.query(
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
        bind: [
          input.lookupId,
          input.nipNormalized,
          input.dataVersionHash,
          input.status,
          input.candidateCount,
          input.responseFingerprint,
          input.errorCode,
          input.now,
          input.expiresAt,
        ],
        transaction: input.transaction,
      },
    );
  }
}
