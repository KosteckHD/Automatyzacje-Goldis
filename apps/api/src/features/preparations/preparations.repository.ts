import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Op, QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import {
  EntityGroupingConflict,
  ImportBatch,
  ImportPreparation,
  ImportPreparedRow,
  RegonCorrection,
  SourceRow,
  sequelize,
  TenantMembership,
  Tool,
  ToolGrant,
  User,
} from "../../infrastructure/database/db";

@Injectable()
export class ImportPreparationsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  findBatch(batchId: string) {
    return ImportBatch.findByPk(batchId);
  }

  findBatchByTenant(batchId: string, tenantId: string) {
    return ImportBatch.findOne({ where: { id: batchId, tenantId } });
  }

  findBatchByTenantForUpdate(batchId: string, tenantId: string, transaction: Transaction) {
    return ImportBatch.findOne({ where: { id: batchId, tenantId }, transaction });
  }

  findBatchForStart(batchId: string, transaction: Transaction) {
    return ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  findBatchByIdAndTenantForExecution(batchId: string, tenantId: string, transaction?: Transaction) {
    return ImportBatch.findOne({
      where: { id: batchId, tenantId },
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findPreparationForExecution(actorUserId: string, tenantId: string, transaction: Transaction) {
    return Promise.all([
      User.findByPk(actorUserId, {
        attributes: ["status"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
      TenantMembership.findOne({
        where: { tenantId, userId: actorUserId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
    ]);
  }

  findToolAccessForExecution(userId: string, tenantId: string, toolId: string, transaction: Transaction) {
    return Promise.all([
      Tool.findByPk(toolId, { transaction, lock: transaction.LOCK.UPDATE }),
      ToolGrant.findOne({
        where: { tenantId, userId, toolId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
    ]);
  }

  findIdempotentPreparation(
    tenantId: string,
    batchId: string,
    actorUserId: string,
    idempotencyKey: string,
    transaction: Transaction,
  ) {
    return ImportPreparation.findOne({
      where: { tenantId, batchId, actorUserId, idempotencyKey },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findActivePreparation(tenantId: string, batchId: string, transaction: Transaction) {
    return ImportPreparation.findOne({
      where: { tenantId, batchId, status: ["queued", "processing", "waiting_registry"] },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findSourceRowsForStart(batchId: string, transaction: Transaction) {
    return SourceRow.findAll({
      where: { batchId },
      order: [["rowNumber", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findApprovedCorrections(sourceRowIds: readonly string[], transaction: Transaction) {
    if (sourceRowIds.length === 0) return Promise.resolve([]);
    return RegonCorrection.findAll({
      where: { sourceRowId: [...sourceRowIds], status: "approved" },
      order: [["createdAt", "DESC"]],
      transaction,
    });
  }

  findRegistryAuditSnapshots(sourceRowIds: readonly string[], transaction: Transaction) {
    if (sourceRowIds.length === 0)
      return Promise.resolve(
        [] as Array<{
          sourceRowId: string;
          effectiveRegonAfter: string;
          applied: boolean;
        }>,
      );
    return sequelize.query<{
      sourceRowId: string;
      effectiveRegonAfter: string;
      applied: boolean;
    }>(
      `SELECT DISTINCT ON (source_row_id) source_row_id AS "sourceRowId",
          effective_regon_after AS "effectiveRegonAfter", applied
       FROM regon_enrichment_audits WHERE source_row_id = ANY($1::uuid[])
       ORDER BY source_row_id, created_at DESC, audit_id DESC`,
      { bind: [[...sourceRowIds]], type: QueryTypes.SELECT, transaction },
    );
  }

  findLatestPreparation(tenantId: string, batchId: string, transaction: Transaction) {
    return ImportPreparation.findOne({
      where: { tenantId, batchId },
      order: [["revision", "DESC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  createPreparation(input: Parameters<typeof ImportPreparation.create>[0], transaction: Transaction) {
    return ImportPreparation.create(input, { transaction });
  }

  createPreparedRows(input: Parameters<typeof ImportPreparedRow.bulkCreate>[0], transaction: Transaction) {
    return ImportPreparedRow.bulkCreate(input, { transaction });
  }

  listPreparations(tenantId: string, batchId: string) {
    return ImportPreparation.findAll({
      where: { tenantId, batchId },
      order: [["revision", "DESC"]],
      limit: 20,
    });
  }

  findPreparation(batchId: string, preparationId: string, tenantId: string) {
    return ImportPreparation.findOne({ where: { preparationId, batchId, tenantId } });
  }

  findPreparedPage(preparationId: string, status: string | undefined, page: number, pageSize: number) {
    const where = { preparationId, ...(status ? { status } : {}) };
    return Promise.all([
      ImportPreparedRow.findAll({
        where,
        order: [["rowNumber", "ASC"]],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      ImportPreparedRow.count({ where }),
    ]);
  }

  findPreparationForExport(preparationId: string, batchId: string, tenantId: string) {
    return ImportPreparation.findOne({ where: { preparationId, batchId, tenantId } });
  }

  findPreparedRows(preparationId: string, limit?: number) {
    return ImportPreparedRow.findAll({
      where: { preparationId },
      order: [["rowNumber", "ASC"]],
      ...(limit ? { limit } : {}),
    });
  }

  findPreparationForUpdate(preparationId: string, batchId: string, tenantId: string, transaction: Transaction) {
    return ImportPreparation.findOne({
      where: { preparationId, batchId, tenantId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  savePreparation(preparation: ImportPreparation, transaction: Transaction) {
    return preparation.save({ transaction });
  }

  claimNextPreparation(now: Date, transaction: Transaction) {
    return ImportPreparation.findOne({
      where: { [Op.or]: [{ status: "queued" }, { status: "processing", leaseExpiresAt: { [Op.lte]: now } }] },
      order: [
        ["createdAt", "ASC"],
        ["preparationId", "ASC"],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
  }

  findPreparationById(preparationId: string) {
    return ImportPreparation.findByPk(preparationId);
  }

  findBatchById(batchId: string) {
    return ImportBatch.findByPk(batchId);
  }

  findPreparationActor(tenantId: string, actorUserId: string) {
    return Promise.all([
      TenantMembership.findOne({
        where: { tenantId, userId: actorUserId, status: "active" },
        attributes: ["role"],
      }),
      User.findByPk(actorUserId, { attributes: ["status"] }),
    ]);
  }

  findPreparedRowsForAnalysis(preparationId: string) {
    return ImportPreparedRow.findAll({ where: { preparationId }, order: [["rowNumber", "ASC"]] });
  }

  findPreparationBlockers(sourceRowIds: readonly string[]) {
    if (sourceRowIds.length === 0) return Promise.resolve([[], []] as const);
    return Promise.all([
      RegonCorrection.findAll({
        where: { sourceRowId: [...sourceRowIds], status: "pending" },
        attributes: ["sourceRowId"],
      }),
      EntityGroupingConflict.findAll({
        where: { sourceRowId: [...sourceRowIds], status: "open" },
        attributes: ["sourceRowId"],
      }),
    ] as const);
  }

  findSourceRowVersionsForBatch(batchId: string) {
    return SourceRow.findAll({ where: { batchId }, attributes: ["id", "rowVersion"] });
  }

  findPreparationForProcessing(preparationId: string, transaction: Transaction) {
    return ImportPreparation.findByPk(preparationId, { transaction, lock: transaction.LOCK.UPDATE });
  }

  updatePreparedRows(input: Parameters<typeof ImportPreparedRow.bulkCreate>[0], transaction: Transaction) {
    return ImportPreparedRow.bulkCreate(input, {
      transaction,
      updateOnDuplicate: [
        "status",
        "reasonCode",
        "representativeRowNumber",
        "normalizedName",
        "normalizedNip",
        "effectiveRegon",
        "regonProvenance",
        "updatedAt",
      ],
    });
  }

  markPreparationFailed(preparationId: string, errorCode: string) {
    const now = new Date();
    return ImportPreparation.update(
      {
        status: "failed",
        stage: "sealed",
        errorCode,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        sealedAt: null,
        version: sequelize.literal("version + 1"),
        updatedAt: now,
      },
      { where: { preparationId, status: ["queued", "processing"] } },
    );
  }
}

export async function requireCurrentSealedPreparation(
  batchId: string,
  selectedRows: readonly { id: string }[],
  transaction?: Transaction,
  requiredPreparationId?: string,
): Promise<Map<string, InstanceType<typeof ImportPreparedRow>>> {
  const latest = await ImportPreparation.findOne({
    where: { batchId },
    order: [["revision", "DESC"]],
    transaction,
  });
  if (!latest?.sealedAt || !["completed", "completed_with_attention"].includes(latest.status)) {
    throw new ConflictException("Najpierw zakończ przygotowanie danych dla całego importu");
  }
  if (requiredPreparationId && latest.preparationId !== requiredPreparationId) {
    throw new ConflictException("Zestaw należy do innej rewizji przygotowania; odśwież podsumowanie");
  }
  const [snapshotState] = await sequelize.query<{ changed: boolean }>(
    `SELECT (
       (SELECT count(*) FROM source_rows WHERE batch_id = $2) <>
       (SELECT count(*) FROM import_prepared_rows WHERE preparation_id = $1)
       OR EXISTS (
         SELECT 1 FROM import_prepared_rows prepared
         LEFT JOIN source_rows source ON source.id = prepared.source_row_id
         WHERE prepared.preparation_id = $1
           AND (source.id IS NULL OR source.row_version <> prepared.expected_row_version)
       )
     ) AS changed`,
    { bind: [latest.preparationId, batchId], type: QueryTypes.SELECT, transaction },
  );
  if (snapshotState?.changed) throw new ConflictException("Dane źródłowe zmieniły się; przygotuj import ponownie");
  const selected = selectedRows.length
    ? await ImportPreparedRow.findAll({
        where: { preparationId: latest.preparationId, sourceRowId: selectedRows.map((row) => row.id) },
        transaction,
      })
    : [];
  if (selected.length !== selectedRows.length)
    throw new ConflictException("Przygotowanie nie obejmuje wskazanych wierszy");
  return new Map(selected.map((row) => [row.sourceRowId, row]));
}
