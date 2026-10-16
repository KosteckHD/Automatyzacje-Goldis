import { todayInWarsaw } from "@goldis/core";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Op } from "sequelize";
import { lockUsersInTransaction } from "../../contracts/user-serialization";
import {
  AutomationRun,
  CanonicalEntity,
  ImportBatch,
  SourceRow,
  sequelize,
  TenantMembership,
  Tool,
  ToolGrant,
  ToolSettings,
  User,
  UserSession,
} from "../../infrastructure/database/db";
import type { AuditActorContext } from "../audit";
import { EntityGroupingService } from "../grouping/public";
import { requireCurrentSealedPreparation } from "../preparations";
import { CanonicalRunService, createLeadIdentityKey } from "./canonical-run-service";
import { RunDispatchService } from "./run-dispatch.service";
import { summarizeRun } from "./run-summary";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RunAdmissionService {
  constructor(
    @Inject(EntityGroupingService) private readonly entityGrouping: EntityGroupingService,
    @Inject(CanonicalRunService) private readonly canonicalRuns: CanonicalRunService,
    @Inject(RunDispatchService) private readonly dispatch: RunDispatchService,
  ) {}

  async create(batchId: string, rowNumber: number, actor: AuditActorContext & { sessionId?: string }) {
    if (!uuidPattern.test(batchId) || !Number.isInteger(rowNumber) || rowNumber < 2)
      throw new BadRequestException("Nieprawidłowy import lub numer wiersza");
    const run = await sequelize.transaction(async (transaction) => {
      // Keep single-row and batch admissions in the same lock order and share
      // the ToolSettings row lock that protects the rolling run limit.
      await lockUsersInTransaction([actor.actorUserId], transaction);
      const settings = await ToolSettings.findOne({
        where: { tenantId: actor.tenantId, toolId: "oc-policy-verification" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const user = await User.findByPk(actor.actorUserId, { transaction, lock: transaction.LOCK.UPDATE });
      const membership = await TenantMembership.findOne({
        where: { tenantId: actor.tenantId, userId: actor.actorUserId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const session = actor.sessionId
        ? await UserSession.findOne({
            where: { sessionId: actor.sessionId, tenantId: actor.tenantId, userId: actor.actorUserId, revokedAt: null },
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        : null;
      if (
        actor.sessionId &&
        (!session ||
          session.expiresAt.getTime() <= Date.now() ||
          session.credentialRevision !== user?.credentialRevision)
      ) {
        throw new ForbiddenException("Sesja wygasła lub jej poświadczenia zmieniły się");
      }
      const tool = await Tool.findByPk("oc-policy-verification", { transaction, lock: transaction.LOCK.UPDATE });
      const grant = await ToolGrant.findOne({
        where: { tenantId: actor.tenantId, userId: actor.actorUserId, toolId: "oc-policy-verification" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !settings ||
        user?.status !== "active" ||
        membership?.status !== "active" ||
        !tool ||
        tool.status !== "available" ||
        (membership.role !== "admin" &&
          ((membership.role !== "operator" && membership.role !== "manager") || !grant?.canExecute))
      ) {
        throw new ForbiddenException("Konto lub prawo uruchomienia nie jest już aktywne");
      }
      const batch = await ImportBatch.findByPk(batchId, { transaction, lock: transaction.LOCK.UPDATE });
      if (
        !batch ||
        batch.tenantId !== actor.tenantId ||
        batch.toolId !== tool.toolId ||
        (membership.role !== "admin" && membership.role !== "manager" && batch.ownerUserId !== actor.actorUserId)
      )
        throw new NotFoundException("Nie znaleziono importu");
      const grouping = await this.entityGrouping.resolveRelatedRows(batchId, rowNumber, transaction);
      const groupConflicts = grouping.filter((result) => result.status === "conflict");
      if (groupConflicts.length)
        throw new ConflictException("Rekordy powiązane wymagają rozstrzygnięcia przed uruchomieniem");
      const linkedGrouping = grouping.filter((result) => result.status === "linked");
      const selectedGroup = linkedGrouping.find((result) => result.rowNumber === rowNumber);
      if (!selectedGroup) throw new ConflictException("Nie udało się przypisać wiersza do grupy podmiotu");
      const initial = await SourceRow.findOne({ where: { batchId, rowNumber }, transaction });
      if (!initial) throw new NotFoundException("Nie znaleziono wiersza");
      const canonical = await CanonicalEntity.findOne({
        where: { canonicalEntityId: selectedGroup.canonicalEntityId, tenantId: actor.tenantId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!canonical) throw new ConflictException("Brak grupy kanonicznej dla wiersza");
      const linkedIds = linkedGrouping
        .filter((result) => result.canonicalEntityId === canonical.canonicalEntityId)
        .map((result) => result.sourceRowId);
      const linkedRows = await SourceRow.findAll({
        where: { id: linkedIds, batchId },
        order: [["rowNumber", "ASC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const leadIdentityKey = createLeadIdentityKey(canonical.canonicalEntityId, initial.decisionMakerName);
      const preparedRows = await requireCurrentSealedPreparation(batchId, linkedRows, transaction);
      if (preparedRows.get(initial.id)?.status !== "ready") {
        throw new ConflictException("Wiersz nie jest gotowy w ostatnim przygotowaniu importu");
      }
      const members = linkedRows.filter(
        (row) =>
          createLeadIdentityKey(canonical.canonicalEntityId, row.decisionMakerName) === leadIdentityKey &&
          preparedRows.get(row.id)?.status === "ready",
      );
      if (!members.some((row) => row.id === initial.id))
        throw new ConflictException("Wiersz nie należy do uruchamianej grupy osoby");
      if (
        !canonical.regon ||
        members.some((row) => !row.effectiveRegon || row.effectiveRegon !== canonical.regon || row.issues.length > 0)
      ) {
        throw new BadRequestException(
          "Wszystkie wiersze grupy muszą mieć zgodny, sprawdzony REGON i komplet wymaganych danych",
        );
      }
      const legacyActiveRun = await AutomationRun.findOne({
        where: {
          sourceRowId: members.map((row) => row.id),
          canonicalEntityId: null,
          status: { [Op.notIn]: ["completed", "failed", "no_matching_policies", "cancelled"] },
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (legacyActiveRun) throw new ConflictException("Wiersz ma już aktywne zadanie ze starszej wersji systemu");
      return this.canonicalRuns.createOrGet(
        batchId,
        canonical.canonicalEntityId,
        leadIdentityKey,
        members,
        actor,
        async (queuedRun, tx) => {
          await this.dispatch.ensureDispatch(queuedRun.id, "create", tx);
        },
        { transaction, referenceDate: todayInWarsaw() },
      );
    });
    void this.dispatch.publishOutbox();
    return summarizeRun(run);
  }
}
