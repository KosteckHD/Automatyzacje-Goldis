import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Transaction } from "sequelize";
import type {
  ImportBatch,
  ImportPreparation,
  ImportPreparationStatus,
  ImportPreparedRow,
  PreparedRowStatus,
  SourceRow,
} from "../../infrastructure/database/db";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { canAccessTool } from "../authorization/public";
import { analyzePreparationRows, type PreparationSourceRow } from "./preparation-analysis";
import { buildPreparationWorkbook } from "./preparation-export";
import { parseCancelPreparationRequest, parseStartPreparationRequest } from "./preparations.dto";
import { ImportPreparationsRepository, requireCurrentSealedPreparation } from "./preparations.repository";

export { requireCurrentSealedPreparation };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const LEASE_MS = 10 * 60_000;
type Actor = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;

type PreparedSnapshot = Readonly<{
  companyName: string;
  decisionMakerName: string | null;
  nipRaw: string;
  address: string;
  mobile: string;
  phone: string;
  email: string;
  postalCode: string;
  city: string;
  regonRaw: string;
  regon: string | null;
  effectiveRegon: string | null;
  issues: string[];
  regonProvenance: "none" | "import" | "approved_correction" | "registry";
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function publicPreparation(preparation: ImportPreparation) {
  return {
    preparationId: preparation.preparationId,
    batchId: preparation.batchId,
    revision: preparation.revision,
    rulesVersion: preparation.rulesVersion,
    sourceFingerprint: preparation.sourceFingerprint,
    status: preparation.status,
    stage: preparation.stage,
    totalRows: preparation.totalRows,
    counts: {
      ready: preparation.readyCount,
      review: preparation.reviewCount,
      skippedNoIdentifiers: preparation.skippedCount,
      duplicates: preparation.duplicateCount,
      waitingRegistry: preparation.waitingRegistryCount,
    },
    version: preparation.version,
    errorCode: preparation.errorCode,
    createdAt: preparation.createdAt,
    updatedAt: preparation.updatedAt,
    finishedAt: preparation.finishedAt,
    sealedAt: preparation.sealedAt,
  };
}

function toAnalysisSource(row: ImportPreparedRow): PreparationSourceRow {
  const snapshot = row.sourceSnapshot as unknown as PreparedSnapshot;
  return {
    sourceRowId: row.sourceRowId,
    rowNumber: row.rowNumber,
    rowVersion: row.expectedRowVersion,
    companyName: snapshot.companyName,
    decisionMakerName: snapshot.decisionMakerName,
    mobile: snapshot.mobile ?? "",
    phone: snapshot.phone ?? "",
    email: snapshot.email ?? "",
    nipRaw: snapshot.nipRaw,
    address: snapshot.address,
    postalCode: snapshot.postalCode,
    city: snapshot.city,
    regonRaw: snapshot.regonRaw,
    regon: snapshot.regon,
    effectiveRegon: snapshot.effectiveRegon,
    issues: snapshot.issues,
  };
}

function provenanceFor(
  row: SourceRow,
  corrections: ReadonlyMap<string, string>,
  registry: ReadonlyMap<string, string>,
): PreparedSnapshot["regonProvenance"] {
  if (!row.effectiveRegon) return "none";
  if (corrections.get(row.id) === row.effectiveRegon) return "approved_correction";
  if (registry.get(row.id) === row.effectiveRegon) return "registry";
  return "import";
}

function finalStatus(counts: {
  review: number;
  skipped: number;
  duplicate: number;
  waitingRegistry: number;
}): ImportPreparationStatus {
  // Registry enrichment creates a fresh revision; this one seals with a clear attention state.
  return counts.review + counts.skipped + counts.duplicate + counts.waitingRegistry > 0
    ? "completed_with_attention"
    : "completed";
}

@Injectable()
export class ImportPreparationService implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ImportPreparationsRepository) private readonly repository: ImportPreparationsRepository,
  ) {}

  async requireExecutableBatch(batchId: string, actor: Actor, transaction?: Transaction): Promise<ImportBatch> {
    if (!UUID.test(batchId)) throw new NotFoundException("Nie znaleziono importu");
    const batch = await this.repository.findBatchByIdAndTenantForExecution(batchId, actor.tenantId, transaction);
    if (!batch) throw new NotFoundException("Nie znaleziono importu");
    await this.assertExecute(batch, actor, transaction);
    return batch;
  }

  async requireReadableBatch(batchId: string, actor: Actor): Promise<ImportBatch> {
    if (!UUID.test(batchId)) throw new NotFoundException("Nie znaleziono importu");
    const batch = await this.repository.findBatchByTenant(batchId, actor.tenantId);
    if (!batch) throw new NotFoundException("Nie znaleziono importu");
    await this.assertRead(batch, actor);
    return batch;
  }

  onModuleInit() {
    void this.processOne().catch(() => undefined);
    this.timer = setInterval(() => void this.processOne().catch(() => undefined), 1_500);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async assertExecute(batch: ImportBatch, actor: Actor, transaction?: Transaction) {
    if (
      !batch.tenantId ||
      batch.tenantId !== actor.tenantId ||
      (actor.role !== "admin" &&
        actor.role !== "manager" &&
        (actor.role !== "operator" || batch.ownerUserId !== actor.userId))
    ) {
      throw new NotFoundException("Nie znaleziono importu");
    }
    if (transaction) {
      const [user, membership] = await this.repository.findPreparationForExecution(
        actor.userId,
        actor.tenantId,
        transaction,
      );
      const [tool, grant] = await this.repository.findToolAccessForExecution(
        actor.userId,
        actor.tenantId,
        batch.toolId,
        transaction,
      );
      const allowed =
        membership?.status === "active" &&
        membership.role === actor.role &&
        user?.status === "active" &&
        tool?.status === "available" &&
        (actor.role === "admin" || Boolean(grant?.canExecute));
      if (!allowed) throw new NotFoundException("Brak prawa do przygotowania importu");
      return;
    }
    if (
      !(await canAccessTool(
        { tenantId: actor.tenantId, userId: actor.userId, role: actor.role },
        batch.toolId,
        "execute",
      ))
    ) {
      throw new NotFoundException("Brak prawa do przygotowania importu");
    }
  }

  private async assertRead(batch: ImportBatch, actor: Actor) {
    if (!batch.tenantId || batch.tenantId !== actor.tenantId) {
      throw new NotFoundException("Nie znaleziono importu");
    }
    if (
      !(await canAccessTool(
        { tenantId: actor.tenantId, userId: actor.userId, role: actor.role },
        batch.toolId,
        "view_results",
      ))
    ) {
      throw new NotFoundException("Brak prawa do odczytu importu");
    }
  }

  async start(batchId: string, body: unknown, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException("Nie znaleziono importu");
    const { idempotencyKey } = parseStartPreparationRequest(body);
    return this.repository.transaction(async (transaction) => {
      const batch = await this.repository.findBatchForStart(batchId, transaction);
      if (!batch) throw new NotFoundException("Nie znaleziono importu");
      await this.assertExecute(batch, actor, transaction);

      const existing = await this.repository.findIdempotentPreparation(
        actor.tenantId,
        batchId,
        actor.userId,
        idempotencyKey,
        transaction,
      );
      if (existing) return { ...publicPreparation(existing), replayed: true };

      const active = await this.repository.findActivePreparation(actor.tenantId, batchId, transaction);
      if (active) throw new ConflictException("Import ma już aktywne przygotowanie; odśwież jego stan");

      const rows = await this.repository.findSourceRowsForStart(batchId, transaction);
      if (rows.length !== batch.totalRows) throw new ConflictException("Liczba wierszy importu uległa zmianie");
      const rowIds = rows.map((row) => row.id);
      const approvedCorrections = await this.repository.findApprovedCorrections(rowIds, transaction);
      const registryAudits = await this.repository.findRegistryAuditSnapshots(rowIds, transaction);
      const correctionBySource = new Map<string, string>();
      for (const correction of approvedCorrections)
        if (!correctionBySource.has(correction.sourceRowId)) {
          correctionBySource.set(correction.sourceRowId, correction.proposedRegon);
        }
      const registryBySource = new Map(
        registryAudits.filter((audit) => audit.applied).map((audit) => [audit.sourceRowId, audit.effectiveRegonAfter]),
      );
      const now = new Date();
      const snapshots = rows.map((row) => {
        const sourceSnapshot: PreparedSnapshot = {
          companyName: row.companyName,
          decisionMakerName: row.decisionMakerName,
          mobile: row.mobile,
          phone: row.phone,
          email: row.email,
          nipRaw: row.nipRaw,
          address: row.address,
          postalCode: row.postalCode,
          city: row.city,
          regonRaw: row.regonRaw,
          regon: row.regon,
          effectiveRegon: row.effectiveRegon,
          issues: row.issues,
          regonProvenance: provenanceFor(row, correctionBySource, registryBySource),
        };
        return { row, sourceSnapshot };
      });
      const sourceFingerprint = digest(
        snapshots.map(({ row, sourceSnapshot }) => [row.id, row.rowNumber, row.rowVersion, sourceSnapshot]),
      );
      const previous = await this.repository.findLatestPreparation(actor.tenantId, batchId, transaction);
      const preparationId = randomUUID();
      const preparation = await this.repository.createPreparation(
        {
          preparationId,
          tenantId: actor.tenantId,
          batchId,
          actorUserId: actor.userId,
          revision: (previous?.revision ?? 0) + 1,
          rulesVersion: "preparation-v1",
          sourceFingerprint,
          status: "queued",
          stage: "first_deduplication",
          cursorRowNumber: 2,
          totalRows: rows.length,
          readyCount: 0,
          reviewCount: 0,
          skippedCount: 0,
          duplicateCount: 0,
          waitingRegistryCount: 0,
          version: 1,
          idempotencyKey,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
          sealedAt: null,
        },
        transaction,
      );
      for (let start = 0; start < snapshots.length; start += 500) {
        await this.repository.createPreparedRows(
          snapshots.slice(start, start + 500).map(({ row, sourceSnapshot }) => ({
            preparedRowId: randomUUID(),
            preparationId,
            batchId,
            sourceRowId: row.id,
            rowNumber: row.rowNumber,
            expectedRowVersion: row.rowVersion,
            sourceSnapshot,
            status: "pending",
            reasonCode: null,
            representativeRowNumber: null,
            normalizedName: null,
            normalizedNip: null,
            effectiveRegon: row.effectiveRegon,
            regonProvenance: sourceSnapshot.regonProvenance,
            registryFetchedAt: null,
            createdAt: now,
            updatedAt: now,
          })),
          transaction,
        );
      }
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "import.preparation.started",
          resourceType: "import",
          resourceId: batchId,
          outcome: "succeeded",
          metadata: {
            batchId,
            revision: preparation.revision,
            totalRows: rows.length,
            preparationId,
            sourceFingerprint,
          },
        },
        transaction,
      );
      return { ...publicPreparation(preparation), replayed: false };
    });
  }

  async listForBatch(batchId: string, actor: Actor) {
    if (!UUID.test(batchId)) throw new NotFoundException("Nie znaleziono importu");
    const batch = await this.repository.findBatch(batchId);
    if (!batch) throw new NotFoundException("Nie znaleziono importu");
    await this.assertRead(batch, actor);
    const preparations = await this.repository.listPreparations(actor.tenantId, batchId);
    return { preparations: preparations.map(publicPreparation) };
  }

  async get(batchId: string, preparationId: string, actor: Actor) {
    if (!UUID.test(batchId) || !UUID.test(preparationId)) throw new NotFoundException("Nie znaleziono przygotowania");
    const [batch, preparation] = await Promise.all([
      this.repository.findBatchByTenant(batchId, actor.tenantId),
      this.repository.findPreparation(batchId, preparationId, actor.tenantId),
    ]);
    if (!batch || !preparation) throw new NotFoundException("Nie znaleziono przygotowania");
    await this.assertRead(batch, actor);
    return publicPreparation(preparation);
  }

  async rows(batchId: string, preparationId: string, page: number, state: string | undefined, actor: Actor) {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100_000 ||
      (state !== undefined &&
        !["pending", "ready", "review", "skipped_no_identifiers", "duplicate", "waiting_registry", "excluded"].includes(
          state,
        ))
    ) {
      throw new BadRequestException("Nieprawidłowa strona lub filtr przygotowania");
    }
    const preparation = await this.get(batchId, preparationId, actor);
    const [items, total] = await this.repository.findPreparedPage(
      preparationId,
      state as PreparedRowStatus | undefined,
      page,
      PAGE_SIZE,
    );
    return {
      preparationId,
      status: preparation.status,
      page,
      pageSize: PAGE_SIZE,
      total,
      rows: items.map((item) => ({
        rowNumber: item.rowNumber,
        sourceRowId: item.sourceRowId,
        expectedRowVersion: item.expectedRowVersion,
        status: item.status,
        reasonCode: item.reasonCode,
        representativeRowNumber: item.representativeRowNumber,
        normalizedName: item.normalizedName,
        normalizedNip: item.normalizedNip,
        effectiveRegon: item.effectiveRegon,
        regonProvenance: item.regonProvenance,
      })),
    };
  }

  async exportWorkbook(batchId: string, preparationId: string, actor: Actor) {
    if (!UUID.test(batchId) || !UUID.test(preparationId)) throw new NotFoundException("Nie znaleziono przygotowania");
    const batch = await this.repository.findBatchByTenant(batchId, actor.tenantId);
    if (!batch || (actor.role === "operator" && batch.ownerUserId !== actor.userId)) {
      throw new NotFoundException("Nie znaleziono przygotowania");
    }
    if (
      !(await canAccessTool(
        { tenantId: actor.tenantId, userId: actor.userId, role: actor.role },
        batch.toolId,
        "download_results",
      ))
    ) {
      throw new NotFoundException("Brak prawa do pobrania zestawu");
    }
    const preparation = await this.repository.findPreparationForExport(preparationId, batchId, actor.tenantId);
    if (!preparation) throw new NotFoundException("Nie znaleziono przygotowania");
    if (!preparation.sealedAt || !["completed", "completed_with_attention"].includes(preparation.status)) {
      throw new ConflictException("Eksport jest dostępny dopiero po zamknięciu przygotowania");
    }
    const rows = await this.repository.findPreparedRows(preparationId, 10_000);
    if (rows.length !== preparation.totalRows || rows.some((row) => row.status === "pending")) {
      throw new ConflictException("Zamknięta rewizja ma niespójne wiersze; odśwież przygotowanie");
    }
    try {
      const workbook = await buildPreparationWorkbook({
        fileName: batch.fileName,
        revision: preparation.revision,
        rulesVersion: preparation.rulesVersion,
        sourceFingerprint: preparation.sourceFingerprint,
        sealedAt: preparation.sealedAt,
        counts: {
          ready: preparation.readyCount,
          review: preparation.reviewCount,
          skippedNoIdentifiers: preparation.skippedCount,
          duplicates: preparation.duplicateCount,
          waitingRegistry: preparation.waitingRegistryCount,
        },
        rows: rows.map((row) => ({
          rowNumber: row.rowNumber,
          expectedRowVersion: row.expectedRowVersion,
          sourceSnapshot: row.sourceSnapshot,
          status: row.status as
            | "ready"
            | "review"
            | "skipped_no_identifiers"
            | "duplicate"
            | "waiting_registry"
            | "excluded",
          reasonCode: row.reasonCode,
          representativeRowNumber: row.representativeRowNumber,
          normalizedNip: row.normalizedNip,
          effectiveRegon: row.effectiveRegon,
          regonProvenance: row.regonProvenance,
        })),
      });
      return { ...workbook, batchId, preparationId, revision: preparation.revision };
    } catch {
      throw new ConflictException("Nie można wyeksportować niespójnej rewizji przygotowania");
    }
  }

  async cancel(batchId: string, preparationId: string, body: unknown, actor: Actor) {
    const { expectedVersion } = parseCancelPreparationRequest(body);
    return this.repository.transaction(async (transaction) => {
      const batch = await this.repository.findBatchByTenantForUpdate(batchId, actor.tenantId, transaction);
      const preparation = await this.repository.findPreparationForUpdate(
        preparationId,
        batchId,
        actor.tenantId,
        transaction,
      );
      if (!batch || !preparation) throw new NotFoundException("Nie znaleziono przygotowania");
      await this.assertExecute(batch, actor, transaction);
      if (preparation.version !== expectedVersion) {
        throw new ConflictException("Przygotowanie zmieniło się; odśwież jego stan");
      }
      if (["completed", "completed_with_attention", "cancelled", "failed"].includes(preparation.status)) {
        return publicPreparation(preparation);
      }
      preparation.status = "cancelled";
      preparation.version += 1;
      preparation.updatedAt = new Date();
      preparation.leaseOwner = null;
      preparation.leaseExpiresAt = null;
      await this.repository.savePreparation(preparation, transaction);
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "import.preparation.cancelled",
          resourceType: "import",
          resourceId: batchId,
          outcome: "succeeded",
          metadata: { preparationId, revision: preparation.revision },
        },
        transaction,
      );
      return publicPreparation(preparation);
    });
  }

  private async claim(): Promise<string | null> {
    const now = new Date();
    return this.repository.transaction(async (transaction) => {
      const preparation = await this.repository.claimNextPreparation(now, transaction);
      if (!preparation) return null;
      preparation.status = "processing";
      preparation.stage = "first_deduplication";
      preparation.leaseOwner = this.workerId;
      preparation.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      preparation.version += 1;
      preparation.updatedAt = now;
      await this.repository.savePreparation(preparation, transaction);
      return preparation.preparationId;
    });
  }

  private async processClaim(preparationId: string) {
    const preparation = await this.repository.findPreparationById(preparationId);
    if (!preparation) return;
    const batch = await this.repository.findBatchById(preparation.batchId);
    if (!batch) throw new Error("PREPARATION_BATCH_MISSING");
    const [membership, user] = await this.repository.findPreparationActor(
      preparation.tenantId,
      preparation.actorUserId,
    );
    if (
      user?.status !== "active" ||
      !membership ||
      !["admin", "manager", "operator"].includes(membership.role) ||
      (membership.role === "operator" && batch.ownerUserId !== preparation.actorUserId) ||
      !(await canAccessTool(
        { tenantId: preparation.tenantId, userId: preparation.actorUserId, role: membership.role as Actor["role"] },
        batch.toolId,
        "execute",
      ))
    ) {
      await this.finishFailure(preparationId, "EXECUTION_PERMISSION_REVOKED");
      return;
    }
    const prepared = await this.repository.findPreparedRowsForAnalysis(preparationId);
    const sourceRows = prepared.map(toAnalysisSource);
    const analyses = analyzePreparationRows(sourceRows);
    const [corrections, conflicts] = await this.repository.findPreparationBlockers(
      prepared.map((row) => row.sourceRowId),
    );
    const blocked = new Map<string, string>();
    for (const row of corrections) blocked.set(row.sourceRowId, "CORRECTION_PENDING");
    for (const row of conflicts) blocked.set(row.sourceRowId, "GROUPING_CONFLICT");
    const outcomes = analyses.map((analysis) => {
      const blocker = blocked.get(analysis.sourceRowId);
      return blocker ? { ...analysis, status: "review" as const, reasonCode: blocker } : analysis;
    });
    const currentRows = await this.repository.findSourceRowVersionsForBatch(preparation.batchId);
    const currentVersions = new Map(currentRows.map((row) => [row.id, row.rowVersion]));
    const versionMismatch =
      currentRows.length !== prepared.length ||
      prepared.some((row) => currentVersions.get(row.sourceRowId) !== row.expectedRowVersion);
    if (versionMismatch) {
      await this.finishFailure(preparationId, "SOURCE_CHANGED_DURING_PREPARATION");
      return;
    }
    await this.repository.transaction(async (transaction) => {
      const current = await this.repository.findPreparationForProcessing(preparationId, transaction);
      if (current?.status !== "processing" || current.leaseOwner !== this.workerId) return;
      const now = new Date();
      const preparedBySourceId = new Map(prepared.map((row) => [row.sourceRowId, row]));
      for (let start = 0; start < outcomes.length; start += 500) {
        const batchOutcomes = outcomes.slice(start, start + 500);
        const updates = batchOutcomes.map((outcome) => {
          const prior = preparedBySourceId.get(outcome.sourceRowId);
          if (!prior) throw new Error("PREPARATION_ROW_MISSING");
          return {
            preparedRowId: prior.preparedRowId,
            preparationId,
            batchId: current.batchId,
            sourceRowId: outcome.sourceRowId,
            rowNumber: outcome.rowNumber,
            expectedRowVersion: outcome.expectedRowVersion,
            sourceSnapshot: prior.sourceSnapshot,
            status: outcome.status,
            reasonCode: outcome.reasonCode,
            representativeRowNumber: outcome.representativeRowNumber,
            normalizedName: outcome.normalizedName,
            normalizedNip: outcome.normalizedNip,
            effectiveRegon: outcome.effectiveRegon,
            regonProvenance: outcome.effectiveRegon
              ? prior.regonProvenance === "none"
                ? "import"
                : prior.regonProvenance
              : "none",
            registryFetchedAt: null,
            createdAt: prior.createdAt,
            updatedAt: now,
          };
        });
        await this.repository.updatePreparedRows(updates, transaction);
      }
      const counts = {
        ready: outcomes.filter((row) => row.status === "ready").length,
        review: outcomes.filter((row) => row.status === "review").length,
        skipped: outcomes.filter((row) => row.status === "skipped_no_identifiers").length,
        duplicate: outcomes.filter((row) => row.status === "duplicate").length,
        waitingRegistry: outcomes.filter((row) => row.status === "waiting_registry").length,
      };
      current.readyCount = counts.ready;
      current.reviewCount = counts.review;
      current.skippedCount = counts.skipped;
      current.duplicateCount = counts.duplicate;
      current.waitingRegistryCount = counts.waitingRegistry;
      current.status = finalStatus({
        review: counts.review,
        skipped: counts.skipped,
        duplicate: counts.duplicate,
        waitingRegistry: counts.waitingRegistry,
      });
      current.stage = "sealed";
      current.cursorRowNumber = current.totalRows + 2;
      current.leaseOwner = null;
      current.leaseExpiresAt = null;
      current.finishedAt = now;
      current.sealedAt = now;
      current.version += 1;
      current.updatedAt = now;
      await this.repository.savePreparation(current, transaction);
      await this.audit.record(
        {
          tenantId: current.tenantId,
          actorUserId: current.actorUserId,
          action: "import.preparation.completed",
          resourceType: "import",
          resourceId: current.batchId,
          outcome: "succeeded",
          metadata: { ...counts, preparationId: current.preparationId, revision: current.revision },
        },
        transaction,
      );
    });
  }

  private async finishFailure(preparationId: string, errorCode: string) {
    await this.repository.markPreparationFailed(preparationId, errorCode);
  }

  async processOne(): Promise<boolean> {
    if (this.processing) return false;
    this.processing = true;
    try {
      const preparationId = await this.claim();
      if (!preparationId) return false;
      try {
        await this.processClaim(preparationId);
      } catch {
        await this.finishFailure(preparationId, "PREPARATION_FAILED");
      }
      return true;
    } finally {
      this.processing = false;
    }
  }
}
