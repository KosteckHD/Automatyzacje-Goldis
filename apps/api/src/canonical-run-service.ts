import { BadRequestException, ConflictException, HttpException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Op, QueryTypes, UniqueConstraintError } from "sequelize";
import { todayInWarsaw } from "@goldis/core";
import { normalizeBusinessName } from "./registry-result";
import { AutomationRun, CanonicalEntity, ImportBatch, RunEvent, RunSourceRow, sequelize, SourceEntityLink, SourceRow, ToolSettings } from "./db";
import { recordAuditEvent, type AuditActorContext } from "./audit";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminalStatuses = ["completed", "failed", "no_matching_policies", "cancelled"];

function isInsideRunWindow(now: Date, timezone: string, start: string | null, end: string | null): boolean {
  if (!start || !end) return true;
  let parts: Record<string, string> = {};
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((part) => [part.type, part.value]));
  } catch { throw new ConflictException("Nieprawidłowa strefa czasowa ustawień narzędzia"); }
  const current = Number(parts.hour) * 60 + Number(parts.minute);
  const parse = (value: string) => {
    const match = /^(\d{2}):(\d{2})/.exec(value);
    if (!match) throw new ConflictException("Nieprawidłowe okno pracy narzędzia");
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const from = parse(start);
  const to = parse(end);
  return from < to ? current >= from && current < to : current >= from || current < to;
}

export function createLeadIdentityKey(canonicalEntityId: string, decisionMakerName: string | null): string {
  const normalizedName = normalizeBusinessName(decisionMakerName);
  return createHash("sha256").update(JSON.stringify([canonicalEntityId, normalizedName]), "utf8").digest("hex");
}

@Injectable()
export class CanonicalRunService {
  async createOrGet(
    batchId: string,
    canonicalEntityId: string,
    leadIdentityKey: string,
    sourceRows: readonly SourceRow[],
    actor?: AuditActorContext,
    ensureQueuedDispatch?: (run: AutomationRun, transaction: import("sequelize").Transaction) => Promise<void>,
  ) {
    if (!uuidPattern.test(batchId) || !uuidPattern.test(canonicalEntityId)
      || !/^[0-9a-f]{64}$/.test(leadIdentityKey) || sourceRows.length === 0
      || sourceRows.some((row) => row.batchId !== batchId || !row.effectiveRegon || row.issues.length > 0)) {
      throw new BadRequestException("Nieprawidłowa grupa źródłowa dla zadania");
    }
    try {
      return await sequelize.transaction(async (transaction) => {
        const requestedIds = [...new Set(sourceRows.map((row) => row.id))];
        if (requestedIds.length !== sourceRows.length) throw new BadRequestException("Lista wierszy grupy zawiera duplikaty");
        const members = await SourceRow.findAll({
          where: { id: requestedIds, batchId }, order: [["rowNumber", "ASC"]],
          transaction, lock: transaction.LOCK.UPDATE,
        });
        if (members.length !== requestedIds.length) throw new BadRequestException("Wiersz grupy nie należy do tego importu");
        const canonical = await CanonicalEntity.findByPk(canonicalEntityId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!canonical?.regon || members.some((row) => !row.effectiveRegon || row.effectiveRegon !== canonical.regon
          || row.issues.length > 0 || normalizeBusinessName(row.companyName) !== normalizeBusinessName(canonical.businessName)
          || createLeadIdentityKey(canonicalEntityId, row.decisionMakerName) !== leadIdentityKey)) {
          throw new BadRequestException("Wiersze nie mają zgodnej firmy, REGON-u i osoby decyzyjnej");
        }
        const links = await SourceEntityLink.findAll({
          where: { sourceRowId: requestedIds }, transaction, lock: transaction.LOCK.UPDATE,
        });
        if (links.length !== requestedIds.length || links.some((link) => link.canonicalEntityId !== canonicalEntityId)) {
          throw new BadRequestException("Wiersze nie są powiązane z tą samą grupą kanoniczną");
        }

        const existing = await AutomationRun.findOne({
          where: {
            batchId, canonicalEntityId, leadIdentityKey,
            status: { [Op.notIn]: terminalStatuses },
          },
          order: [["createdAt", "ASC"]],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (existing) {
          if (existing.status === "queued") await ensureQueuedDispatch?.(existing, transaction);
          return existing;
        }

        if (actor) {
          const batch = await ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
          if (!batch || batch.tenantId !== actor.tenantId || batch.toolId !== "oc-policy-verification") {
            throw new BadRequestException("Import nie należy do wskazanego narzędzia");
          }
          const settings = await ToolSettings.findOne({
            where: { tenantId: actor.tenantId, toolId: batch.toolId },
            transaction, lock: transaction.LOCK.UPDATE,
          });
          if (!settings || !settings.enabledForNewRuns) {
            throw new ConflictException("Administrator wstrzymał nowe uruchomienia tego narzędzia");
          }
          const now = new Date();
          if (!isInsideRunWindow(now, settings.timezone, settings.allowedLocalStart, settings.allowedLocalEnd)) {
            throw new ConflictException("Uruchomienia tego narzędzia są teraz poza dozwolonymi godzinami");
          }
          if (settings.maxNewRunsPerHour !== null) {
            const recentCount = await sequelize.query<{ count: number }>(
              `SELECT count(*)::int AS count
               FROM automation_runs r JOIN import_batches b ON b.id = r.batch_id
               WHERE b.tenant_id = :tenantId AND b.tool_id = :toolId AND r.created_at >= :since`,
              { replacements: { tenantId: actor.tenantId, toolId: batch.toolId,
                since: new Date(now.getTime() - 60 * 60 * 1000) }, type: QueryTypes.SELECT, transaction },
            );
            if (Number(recentCount[0]?.count ?? 0) >= settings.maxNewRunsPerHour) {
              throw new HttpException("Osiągnięto godzinowy limit nowych uruchomień narzędzia", 429);
            }
          }
        }

        const primary = members[0];
        const now = new Date();
        const run = await AutomationRun.create({
          batchId,
          sourceRowId: primary.id,
          canonicalEntityId,
          leadIdentityKey,
          rowNumber: primary.rowNumber,
          toolId: "oc-policy-verification",
          status: "queued",
          currentStep: "queued",
          referenceDate: todayInWarsaw(),
          errorCode: null,
          createdAt: now,
          updatedAt: now,
        }, { transaction });
        await RunEvent.create({
          runId: run.id, status: "queued", step: "queued", errorCode: null, createdAt: now,
        }, { transaction });
        await RunSourceRow.bulkCreate(members.map((row) => ({
          runId: run.id,
          sourceRowId: row.id,
          rowNumber: row.rowNumber,
          isPrimary: row.id === primary.id,
          createdAt: now,
        })), { transaction });
        if (actor) {
          await recordAuditEvent({
            tenantId: actor.tenantId, actorUserId: actor.actorUserId,
            action: "run.created", resourceType: "run", resourceId: run.id, outcome: "succeeded",
          }, transaction);
        }
        await ensureQueuedDispatch?.(run, transaction);
        return run;
      });
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) throw error;
      const concurrent = await AutomationRun.findOne({
        where: {
          batchId, canonicalEntityId, leadIdentityKey,
          status: { [Op.notIn]: terminalStatuses },
        },
        order: [["createdAt", "ASC"]],
      });
      if (concurrent) return concurrent;
      throw error;
    }
  }
}
