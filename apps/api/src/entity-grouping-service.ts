import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Op, UniqueConstraintError, type Transaction } from "sequelize";
import { assessEntityGrouping } from "./entity-grouping";
import {
  CanonicalEntity,
  EntityGroupingConflict,
  RegistryEnrichmentAudit,
  sequelize,
  SourceEntityLink,
  SourceRow,
} from "./db";
import { normalizeNip, normalizeRegon } from "@goldis/core";
import { randomUUID } from "node:crypto";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function conflictResult(conflict: EntityGroupingConflict, row: SourceRow) {
  return {
    status: "conflict" as const,
    conflictId: conflict.conflictId,
    rowNumber: row.rowNumber,
    rowVersion: row.rowVersion,
    reasonCode: conflict.reasonCode,
    candidateEntityIds: conflict.candidateEntityIds,
  };
}

@Injectable()
export class EntityGroupingService {
  async resolveRelatedRows(batchId: string, rowNumber: number) {
    if (!uuidPattern.test(batchId) || !Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new BadRequestException("Nieprawidłowy import lub numer wiersza");
    }
    const selected = await SourceRow.findOne({ where: { batchId, rowNumber } });
    if (!selected) throw new NotFoundException("Nie znaleziono wiersza importu");

    const selectedNip = normalizeNip(selected.nipRaw).normalized;
    const selectedRegon = selected.effectiveRegon ? normalizeRegon(selected.effectiveRegon).normalized : null;
    const rows = await SourceRow.findAll({
      where: { batchId },
      attributes: ["id", "rowNumber", "nipRaw", "effectiveRegon"],
      order: [["rowNumber", "ASC"]],
    });
    const related = rows.filter((candidate) => candidate.id === selected.id
      || (selectedNip !== null && normalizeNip(candidate.nipRaw).normalized === selectedNip)
      || (selectedRegon !== null && candidate.effectiveRegon === selectedRegon));
    const outcomes = [];
    for (const candidate of related) outcomes.push(await this.resolveSourceRow(batchId, candidate.rowNumber));
    return outcomes;
  }

  async resolveSourceRow(batchId: string, rowNumber: number) {
    if (!uuidPattern.test(batchId) || !Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new BadRequestException("Nieprawidłowy import lub numer wiersza");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await sequelize.transaction(async (transaction) => {
          const row = await SourceRow.findOne({
            where: { batchId, rowNumber }, transaction, lock: transaction.LOCK.UPDATE,
          });
          if (!row) throw new NotFoundException("Nie znaleziono wiersza importu");
          const openConflict = await EntityGroupingConflict.findOne({
            where: { sourceRowId: row.id, status: "open" }, transaction, lock: transaction.LOCK.UPDATE,
          });
          if (openConflict) return conflictResult(openConflict, row);

          const nipNormalized = normalizeNip(row.nipRaw).normalized;
          const regon = row.effectiveRegon ? normalizeRegon(row.effectiveRegon).normalized : null;
          const identityConditions = [];
          if (nipNormalized) identityConditions.push({ nipNormalized });
          if (regon) identityConditions.push({ regon });
          let entities = identityConditions.length
            ? await CanonicalEntity.findAll({
              where: { [Op.or]: identityConditions },
              order: [["createdAt", "ASC"], ["canonicalEntityId", "ASC"]],
              transaction,
              lock: transaction.LOCK.UPDATE,
            })
            : [];
          const sourceLink = await SourceEntityLink.findByPk(row.id, { transaction, lock: transaction.LOCK.UPDATE });
          if (sourceLink && !entities.some((entity) => entity.canonicalEntityId === sourceLink.canonicalEntityId)) {
            const linkedEntity = await CanonicalEntity.findByPk(sourceLink.canonicalEntityId, { transaction, lock: transaction.LOCK.UPDATE });
            if (linkedEntity) entities = [...entities, linkedEntity];
          }

          const decision = assessEntityGrouping({
            nipRaw: row.nipRaw,
            effectiveRegon: row.effectiveRegon,
            companyName: row.companyName,
            candidates: entities.map((entity) => ({
              canonicalEntityId: entity.canonicalEntityId,
              nipNormalized: entity.nipNormalized,
              regon: entity.regon,
              businessName: entity.businessName,
            })),
          });
          if (decision.outcome === "conflict" || (sourceLink && (decision.outcome !== "link_existing"
            || decision.canonicalEntityId !== sourceLink.canonicalEntityId))) {
            const reasonCode = decision.outcome === "conflict" ? decision.reasonCode : "SOURCE_LINK_MISMATCH";
            const candidateEntityIds = decision.outcome === "conflict"
              ? decision.candidateEntityIds
              : sourceLink ? [sourceLink.canonicalEntityId] : [];
            const conflict = await EntityGroupingConflict.create({
              conflictId: randomUUID(), sourceRowId: row.id, reasonCode,
              candidateEntityIds, status: "open", resolutionNote: null, resolvedBy: null,
              resolvedAt: null, createdAt: new Date(),
            }, { transaction });
            row.rowVersion += 1;
            await row.save({ transaction });
            return conflictResult(conflict, row);
          }

          if (decision.outcome === "create_new") {
            const now = new Date();
            const entity = await CanonicalEntity.create({
              canonicalEntityId: randomUUID(), nipNormalized: decision.nipNormalized,
              regon: decision.regon, businessName: decision.businessName, createdAt: now, updatedAt: now,
            }, { transaction });
            await SourceEntityLink.create({
              sourceRowId: row.id, canonicalEntityId: entity.canonicalEntityId,
              matchMethod: await this.linkMethod(row, decision.nipNormalized, decision.regon, transaction), linkedAt: now,
            }, { transaction });
            row.rowVersion += 1;
            await row.save({ transaction });
            return {
              status: "linked" as const, rowNumber, sourceRowId: row.id,
              canonicalEntityId: entity.canonicalEntityId, rowVersion: row.rowVersion, created: true,
            };
          }

          const entity = await CanonicalEntity.findByPk(decision.canonicalEntityId, { transaction, lock: transaction.LOCK.UPDATE });
          if (!entity) throw new NotFoundException("Nie znaleziono encji kanonicznej");
          let entityUpdated = false;
          if (decision.fillMissingNip) {
            entity.nipNormalized = decision.nipNormalized;
            entityUpdated = true;
          }
          if (decision.fillMissingRegon) {
            entity.regon = decision.regon;
            entityUpdated = true;
          }
          if (entityUpdated) {
            entity.updatedAt = new Date();
            await entity.save({ transaction });
          }
          if (!sourceLink) {
            const now = new Date();
            await SourceEntityLink.create({
              sourceRowId: row.id, canonicalEntityId: entity.canonicalEntityId,
              matchMethod: await this.linkMethod(row, decision.nipNormalized, decision.regon, transaction), linkedAt: now,
            }, { transaction });
            row.rowVersion += 1;
            await row.save({ transaction });
          } else if (entityUpdated) {
            row.rowVersion += 1;
            await row.save({ transaction });
          }
          return {
            status: "linked" as const, rowNumber, sourceRowId: row.id,
            canonicalEntityId: entity.canonicalEntityId, rowVersion: row.rowVersion, created: false,
          };
        });
      } catch (error) {
        if (attempt === 0 && error instanceof UniqueConstraintError) continue;
        throw error;
      }
    }
    throw new Error("ENTITY_GROUP_RESOLUTION_FAILED");
  }

  private async linkMethod(row: SourceRow, nipNormalized: string | null, regon: string | null, transaction: Transaction) {
    if (await RegistryEnrichmentAudit.findOne({
      where: { sourceRowId: row.id, decisionStatus: "matched", applied: true }, transaction,
    })) return "registry_verified" as const;
    return nipNormalized && regon ? "nip_regon_exact" as const : "identifier_and_name_exact" as const;
  }
}
