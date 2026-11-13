import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateCommissionDictionarySnapshotV1, validateCommissionEngineResultV1 } from "@goldis/core";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Transaction } from "sequelize";
import { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import { ArtifactCryptoError, decryptStoredArtifactBytes, encryptArtifactBytes } from "../results/public";
import { CommissionEngineClient } from "./commission-engine-client";
import { deleteCommissionFile, sha256, writeCommissionFile } from "./commission-file-store";
import {
  CommissionAgentModel,
  CommissionDictionaryGrantModel,
  CommissionDictionaryVersionModel,
  CommissionDispatchModel,
  CommissionExportModel,
  CommissionFileModel,
  CommissionResolutionModel,
  CommissionRunFileModel,
  CommissionRunModel,
  CommissionRunSnapshotModel,
} from "./commissions.model";
import { CommissionsRepository } from "./commissions.repository";
import { parseEditDictionaryEntryInput } from "./commission-dictionary-input";

const maxFileBytes = 16 * 1024 * 1024;
type Scope = Pick<SessionPrincipal, "tenantId" | "userId" | "role">;
type FileRow = {
  fileId: string;
  tenantId: string;
  sourceType: string;
  fileName: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  validationState: string;
  rowCount: number | null;
  parserVersion: string | null;
  uploadedBy: string;
  uploadedAt: Date;
  deletedAt: Date | null;
};
type DictionaryRow = {
  dictionaryVersionId: string;
  versionNumber: number;
  status: string;
  isActive: boolean;
  revision: number;
  snapshotCiphertext: Buffer;
  snapshotSha256: string;
  entryCount: number;
  previousVersionId: string | null;
  createdAt: Date;
  publishedAt: Date | null;
};
type RunRow = {
  runId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  status: string;
  progressStage: string;
  dictionaryVersionId: string;
  engineVersion: string;
  counters: Record<string, number>;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};
type DictionaryRateCell = {
  status: string;
  rate: number | null;
  changed?: boolean;
  rule_id?: string;
  raw?: unknown;
  number_format?: string;
  cell?: string;
};
type DictionaryEntry = {
  id: string;
  risk: string;
  source: string;
  sheet: string;
  variant?: string;
  agents: Record<"Ola" | "Maciek", DictionaryRateCell>;
};
type EditableDictionaryPreset = {
  client_dictionary?: { entries?: DictionaryEntry[] };
  rules: Record<string, Record<string, unknown>>;
};

@Injectable()
export class CommissionsService {
  private readonly engine = new CommissionEngineClient();

  constructor(
    @Inject(CommissionsRepository) private readonly repository: CommissionsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async canEditDictionary(scope: Scope): Promise<boolean> {
    if (scope.role === "admin") return true;
    return this.hasDictionaryGrant(scope.tenantId, scope.userId);
  }

  async hasDictionaryGrant(tenantId: string, userId: string): Promise<boolean> {
    return Boolean(await this.repository.findOne(CommissionDictionaryGrantModel, { where: { tenantId, userId } }));
  }

  async setDictionaryGrant(
    input: { tenantId: string; userId: string; grantedBy: string; granted: boolean },
    transaction: Transaction,
  ) {
    if (input.granted) {
      await this.repository.findOrCreate(CommissionDictionaryGrantModel, {
        where: { tenantId: input.tenantId, userId: input.userId },
        defaults: { tenantId: input.tenantId, userId: input.userId, grantedBy: input.grantedBy, createdAt: new Date() },
        transaction,
      });
    } else {
      await this.repository.destroy(CommissionDictionaryGrantModel, {
        where: { tenantId: input.tenantId, userId: input.userId },
        transaction,
      });
    }
    await this.audit.record(
      {
        tenantId: input.tenantId,
        actorUserId: input.grantedBy,
        action: "commission.dictionary.grant.updated",
        resourceType: "commission_dictionary",
        resourceId: input.userId,
        outcome: "succeeded",
        metadata: { granted: input.granted },
      },
      transaction,
    );
    return { userId: input.userId, granted: input.granted };
  }

  async listAgents(scope: Scope) {
    return this.repository.findAll(CommissionAgentModel, {
      where: { tenantId: scope.tenantId, isActive: true },
      attributes: ["agentId", "agentKey", "displayName", "aliases"],
      order: [["displayName", "ASC"]],
      raw: true,
    });
  }

  async listFiles(scope: Scope) {
    const rows = await this.repository.findAll(CommissionFileModel, {
      where: { tenantId: scope.tenantId, deletedAt: null },
      attributes: [
        "fileId",
        "sourceType",
        "fileName",
        "sha256",
        "sizeBytes",
        "validationState",
        "rowCount",
        "parserVersion",
        "uploadedAt",
      ],
      order: [["uploadedAt", "DESC"]],
      raw: true,
    });
    return rows;
  }

  async uploadFile(scope: Scope, file: Express.Multer.File, sourceType: "CRM" | "ASF" | "WARTA") {
    this.assertWorkbook(file, false);
    const fileId = randomUUID();
    const hash = sha256(file.buffer);
    const stored = await writeCommissionFile(fileId, file.buffer);
    try {
      await this.repository.create(CommissionFileModel, {
        fileId,
        tenantId: scope.tenantId,
        sourceType,
        fileName: file.originalname.slice(0, 255),
        storageKey: stored.storageKey,
        sha256: hash,
        sizeBytes: stored.sizeBytes,
        validationState: "ready",
        rowCount: null,
        parserVersion: "commission-engine-v1",
        uploadedBy: scope.userId,
        uploadedAt: new Date(),
        deletedAt: null,
      });
      await this.audit.record({
        tenantId: scope.tenantId,
        actorUserId: scope.userId,
        action: "commission.file.uploaded",
        resourceType: "commission_file",
        resourceId: fileId,
        outcome: "succeeded",
        metadata: { sourceType, sizeBytes: file.size },
      });
      return {
        fileId,
        sourceType,
        fileName: file.originalname,
        sizeBytes: file.size,
        sha256: hash,
        validationState: "ready",
      };
    } catch (error) {
      await deleteCommissionFile(stored.storageKey).catch(() => undefined);
      throw error;
    }
  }

  async deleteFile(scope: Scope, fileId: string) {
    const row = await this.repository.findOne(CommissionFileModel, {
      where: { fileId, tenantId: scope.tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException("COMMISSION_FILE_NOT_FOUND");
    const used = await this.repository.findOne(CommissionRunFileModel, { where: { tenantId: scope.tenantId, fileId } });
    if (used) throw new ConflictException("COMMISSION_FILE_USED_BY_RUN");
    row.deletedAt = new Date();
    row.validationState = "deleted";
    await this.repository.save(row);
    await deleteCommissionFile(row.storageKey);
    await this.audit.record({
      tenantId: scope.tenantId,
      actorUserId: scope.userId,
      action: "commission.file.deleted",
      resourceType: "commission_file",
      resourceId: fileId,
      outcome: "succeeded",
    });
    return { deleted: true };
  }

  async importDictionary(scope: Scope, file: Express.Multer.File) {
    if (!(await this.canEditDictionary(scope))) throw new ForbiddenException("COMMISSION_DICTIONARY_EDIT_REQUIRED");
    this.assertWorkbook(file, true);
    const active = await this.activeDictionaryRow(scope.tenantId);
    const previousPreset = active ? this.decryptPreset(active) : undefined;
    const fileId = randomUUID();
    const stored = await writeCommissionFile(fileId, file.buffer);
    const hash = sha256(file.buffer);
    let createdFile = false;
    try {
      await this.repository.create(CommissionFileModel, {
        fileId,
        tenantId: scope.tenantId,
        sourceType: "DICTIONARY",
        fileName: file.originalname.slice(0, 255),
        storageKey: stored.storageKey,
        sha256: hash,
        sizeBytes: file.size,
        validationState: "ready",
        rowCount: null,
        parserVersion: "commission-engine-v1",
        uploadedBy: scope.userId,
        uploadedAt: new Date(),
        deletedAt: null,
      });
      createdFile = true;
      const versionNumber = await this.nextDictionaryVersion(scope.tenantId);
      const result = await this.engine.execute<{ engineVersion: string; preset: Record<string, unknown> }>(
        "/internal/v1/dictionary/import",
        {
          schemaVersion: 1,
          requestId: randomUUID(),
          executionId: randomUUID(),
          attemptToken: randomUUID(),
          version: `client-${versionNumber}`,
          fileName: file.originalname,
          sha256: hash,
          contentBase64: file.buffer.toString("base64"),
          ...(previousPreset ? { previousPreset } : {}),
        },
      );
      const preset = validateCommissionDictionarySnapshotV1(result.preset);
      const dictionaryVersionId = randomUUID();
      const encrypted = encryptArtifactBytes(dictionaryVersionId, Buffer.from(JSON.stringify(preset), "utf8"));
      const now = new Date();
      const previousVersionId = active?.dictionaryVersionId ?? null;
      await this.repository.create(CommissionDictionaryVersionModel, {
        dictionaryVersionId,
        tenantId: scope.tenantId,
        versionNumber,
        status: "draft",
        isActive: false,
        revision: 1,
        sourceFileId: fileId,
        snapshotCiphertext: encrypted,
        snapshotSha256: sha256(Buffer.from(JSON.stringify(preset))),
        entryCount: (preset.client_dictionary as { entries: unknown[] }).entries.length,
        previousVersionId,
        createdBy: scope.userId,
        publishedBy: null,
        createdAt: now,
        publishedAt: null,
      });
      await this.audit.record({
        tenantId: scope.tenantId,
        actorUserId: scope.userId,
        action: "commission.dictionary.imported",
        resourceType: "commission_dictionary",
        resourceId: dictionaryVersionId,
        outcome: "succeeded",
        metadata: { entryCount: (preset.client_dictionary as { entries: unknown[] }).entries.length, versionNumber },
      });
      return {
        dictionaryVersionId,
        versionNumber,
        status: "draft",
        revision: 1,
        entryCount: (preset.client_dictionary as { entries: unknown[] }).entries.length,
        stats: (preset.client_dictionary as { stats: Record<string, unknown> }).stats,
      };
    } catch (error) {
      await deleteCommissionFile(stored.storageKey).catch(() => undefined);
      if (createdFile)
        await this.repository
          .destroy(CommissionFileModel, { where: { fileId, tenantId: scope.tenantId } })
          .catch(() => undefined);
      throw error;
    }
  }

  async listDictionaries(scope: Scope) {
    const rows = await this.repository.findAll(CommissionDictionaryVersionModel, {
      where: { tenantId: scope.tenantId },
      attributes: [
        "dictionaryVersionId",
        "versionNumber",
        "status",
        "isActive",
        "revision",
        "entryCount",
        "previousVersionId",
        "createdAt",
        "publishedAt",
      ],
      order: [["versionNumber", "DESC"]],
      raw: true,
    });
    return { items: rows, canEdit: await this.canEditDictionary(scope) };
  }

  async getDictionary(scope: Scope, versionId?: string) {
    const row = versionId
      ? await this.repository.findOne(CommissionDictionaryVersionModel, {
          where: { tenantId: scope.tenantId, dictionaryVersionId: versionId },
        })
      : await this.activeDictionaryRow(scope.tenantId);
    if (!row) throw new NotFoundException("COMMISSION_DICTIONARY_NOT_FOUND");
    return {
      version: {
        dictionaryVersionId: row.dictionaryVersionId,
        versionNumber: row.versionNumber,
        status: row.status,
        isActive: row.isActive,
        revision: row.revision,
        entryCount: row.entryCount,
      },
      preset: this.decryptPreset(row),
    };
  }

  async editDictionaryEntry(scope: Scope, versionId: string, entryId: string, input: unknown) {
    if (!(await this.canEditDictionary(scope))) throw new ForbiddenException("COMMISSION_DICTIONARY_EDIT_REQUIRED");
    const body = parseEditDictionaryEntryInput(input);
    return this.repository.transaction(async (transaction) => {
      const row = await this.repository.findOne(CommissionDictionaryVersionModel, {
        where: { tenantId: scope.tenantId, dictionaryVersionId: versionId, status: "draft" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw new NotFoundException("COMMISSION_DRAFT_NOT_FOUND");
      if (row.revision !== body.revision) throw new ConflictException("COMMISSION_DICTIONARY_REVISION_CONFLICT");
      let preset: EditableDictionaryPreset;
      try {
        preset = this.decryptPreset(row) as EditableDictionaryPreset;
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof ArtifactCryptoError && error.code === "ARTIFACT_DECRYPT_FAILED")
        ) throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
        throw error;
      }
      if (
        !preset ||
        typeof preset !== "object" ||
        Array.isArray(preset) ||
        !preset.rules ||
        typeof preset.rules !== "object" ||
        Array.isArray(preset.rules) ||
        !preset.client_dictionary ||
        typeof preset.client_dictionary !== "object" ||
        Array.isArray(preset.client_dictionary) ||
        !Array.isArray(preset.client_dictionary.entries)
      )
        throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
      const rules = preset.rules as Record<string, unknown>;
      const reservedRuleIds = new Set(["__proto__", "constructor", "prototype"]);
      const validRuleId = (value: string) => /^[A-Za-z0-9_-]{1,160}$/.test(value) && !reservedRuleIds.has(value);
      if (Object.keys(rules).some((key) => !validRuleId(key)))
        throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
      const entries = preset.client_dictionary.entries as unknown[];
      const entryValue = entries.find((item) =>
        Boolean(item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).id === entryId),
      );
      const entry = entryValue as Record<string, unknown> | undefined;
      if (!entry) throw new NotFoundException("COMMISSION_DICTIONARY_ENTRY_NOT_FOUND");
      if (
        !entry.agents ||
        typeof entry.agents !== "object" ||
        Array.isArray(entry.agents) ||
        !Object.hasOwn(entry.agents, body.agent)
      )
        throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
      const agents = entry.agents as Record<string, unknown>;
      const parsed = agents[body.agent];
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
      const cell = parsed as Record<string, unknown>;
      if (cell.rule_id !== undefined && cell.rule_id !== null && (typeof cell.rule_id !== "string" || !validRuleId(cell.rule_id)))
        throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
      if (
        typeof cell.status !== "string" ||
        (cell.rate !== null &&
          (typeof cell.rate !== "number" || !Number.isFinite(cell.rate) || cell.rate < 0 || cell.rate > 100))
      ) throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
      cell.status = body.status;
      cell.rate = body.status === "RATE" ? body.rate! : body.status === "NO_COMMISSION" ? 0 : null;
      cell.changed = true;
      const ruleId = cell.rule_id as string | null | undefined;
      if (ruleId && Object.hasOwn(rules, ruleId)) delete rules[ruleId];
      if (cell.rate !== null) {
        const nextRuleId = (cell.rule_id as string | null | undefined) ?? `CLIENT_${String(entry.id).replace(/-/g, "_")}_${body.agent.toUpperCase()}`;
        if (!validRuleId(nextRuleId)) throw new ConflictException("COMMISSION_DICTIONARY_SNAPSHOT_INVALID");
        cell.rule_id = nextRuleId;
        rules[nextRuleId] = {
          rate: cell.rate,
          label: entry.risk,
          source: entry.source,
          sheet: entry.sheet,
          cell: cell.cell,
          source_value: String(cell.raw ?? cell.rate),
          number_format: cell.number_format,
          owner: body.agent,
          entry_id: entry.id,
          variant: entry.variant,
          status: cell.status,
          origin: "client_dictionary",
        };
      } else {
        cell.rule_id = null;
      }
      const json = Buffer.from(JSON.stringify(preset), "utf8");
      row.snapshotCiphertext = encryptArtifactBytes(row.dictionaryVersionId, json);
      row.snapshotSha256 = sha256(json);
      row.revision += 1;
      await this.repository.save(row, { transaction });
      await this.audit.record(
        {
          tenantId: scope.tenantId,
          actorUserId: scope.userId,
          action: "commission.dictionary.edited",
          resourceType: "commission_dictionary",
          resourceId: versionId,
          outcome: "succeeded",
          metadata: { revision: row.revision, entryId, agent: body.agent, rateStatus: body.status },
        },
        transaction,
      );
      return { revision: row.revision, entry };
    });
  }

  async publishDictionary(scope: Scope, versionId: string, revision: number) {
    if (!(await this.canEditDictionary(scope))) throw new ForbiddenException("COMMISSION_DICTIONARY_EDIT_REQUIRED");
    return this.repository.transaction(async (transaction) => {
      const row = await this.repository.findOne(CommissionDictionaryVersionModel, {
        where: { tenantId: scope.tenantId, dictionaryVersionId: versionId, status: "draft" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw new NotFoundException("COMMISSION_DRAFT_NOT_FOUND");
      if (row.revision !== revision) throw new ConflictException("COMMISSION_DICTIONARY_REVISION_CONFLICT");
      await this.repository.update(
        CommissionDictionaryVersionModel,
        { isActive: false, status: "archived" },
        { where: { tenantId: scope.tenantId, isActive: true }, transaction },
      );
      row.status = "published";
      row.isActive = true;
      row.publishedBy = scope.userId;
      row.publishedAt = new Date();
      await this.repository.save(row, { transaction });
      await this.audit.record(
        {
          tenantId: scope.tenantId,
          actorUserId: scope.userId,
          action: "commission.dictionary.published",
          resourceType: "commission_dictionary",
          resourceId: versionId,
          outcome: "succeeded",
          metadata: { revision },
        },
        transaction,
      );
      return { dictionaryVersionId: versionId, status: row.status, isActive: row.isActive, revision: row.revision };
    });
  }

  async activateDictionary(scope: Scope, versionId: string) {
    if (!(await this.canEditDictionary(scope))) throw new ForbiddenException("COMMISSION_DICTIONARY_EDIT_REQUIRED");
    return this.repository.transaction(async (transaction) => {
      const target = await this.repository.findOne(CommissionDictionaryVersionModel, {
        where: { tenantId: scope.tenantId, dictionaryVersionId: versionId, status: "archived" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!target) throw new NotFoundException("COMMISSION_ARCHIVED_DICTIONARY_NOT_FOUND");
      await this.repository.update(
        CommissionDictionaryVersionModel,
        { isActive: false, status: "archived" },
        { where: { tenantId: scope.tenantId, isActive: true }, transaction },
      );
      target.status = "published";
      target.isActive = true;
      target.publishedBy = scope.userId;
      target.publishedAt = new Date();
      await this.repository.save(target, { transaction });
      await this.audit.record(
        {
          tenantId: scope.tenantId,
          actorUserId: scope.userId,
          action: "commission.dictionary.activated",
          resourceType: "commission_dictionary",
          resourceId: versionId,
          outcome: "succeeded",
          metadata: { versionNumber: target.versionNumber },
        },
        transaction,
      );
      return {
        dictionaryVersionId: versionId,
        versionNumber: target.versionNumber,
        status: target.status,
        isActive: true,
      };
    });
  }

  async createRun(scope: Scope, input: { start: string; end: string; fileIds: string[]; idempotencyKey: string }) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.end) ||
      input.end < input.start ||
      !/^[\w.:/-]{8,128}$/.test(input.idempotencyKey) ||
      !Array.isArray(input.fileIds) ||
      input.fileIds.length < 2 ||
      input.fileIds.length > 40
    )
      throw new BadRequestException("INVALID_COMMISSION_RUN");
    const active = await this.activeDictionaryRow(scope.tenantId);
    if (!active) throw new ConflictException("COMMISSION_DICTIONARY_REQUIRED");
    const files = (await this.repository.findAll(CommissionFileModel, {
      where: { tenantId: scope.tenantId, fileId: input.fileIds, deletedAt: null, validationState: "ready" },
      raw: true,
    })) as unknown as FileRow[];
    if (
      files.length !== new Set(input.fileIds).size ||
      !files.some((file) => file.sourceType === "CRM") ||
      !files.some((file) => file.sourceType === "ASF" || file.sourceType === "WARTA")
    )
      throw new BadRequestException("COMMISSION_INPUT_FILES_INCOMPLETE");
    const uniqueFiles = [
      ...new Map(
        files
          .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
          .map((file) => [`${file.sourceType}:${file.sha256}`, file]),
      ).values(),
    ];
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          start: input.start,
          end: input.end,
          dictionaryVersionId: active.dictionaryVersionId,
          files: uniqueFiles.map((file) => [file.sourceType, file.sha256]).sort(),
        }),
      )
      .digest("hex");
    const existing = await this.repository.findOne(CommissionRunModel, {
      where: { tenantId: scope.tenantId, ownerUserId: scope.userId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ConflictException("IDEMPOTENCY_KEY_REUSED");
      return { runId: existing.runId, status: existing.status, created: false };
    }
    const runId = randomUUID();
    const attemptToken = randomUUID();
    const now = new Date();
    try {
      await this.repository.transaction(async (transaction) => {
        await this.repository.create(
          CommissionRunModel,
          {
            runId,
            tenantId: scope.tenantId,
            ownerUserId: scope.userId,
            startDate: input.start,
            endDate: input.end,
            status: "queued",
            progressStage: "queued",
            dictionaryVersionId: active.dictionaryVersionId,
            engineVersion: "python-v1",
            requestHash,
            idempotencyKey: input.idempotencyKey,
            resultSha256: null,
            counters: {},
            activeAttemptToken: attemptToken,
            executionLeaseUntil: null,
            errorCode: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
          },
          { transaction },
        );
        await this.repository.bulkCreate(
          CommissionRunFileModel,
          uniqueFiles.map((file) => ({ tenantId: scope.tenantId, runId, fileId: file.fileId, createdAt: now })),
          { transaction },
        );
        await this.repository.create(
          CommissionDispatchModel,
          {
            dispatchId: randomUUID(),
            tenantId: scope.tenantId,
            runId,
            status: "pending",
            attemptCount: 0,
            claimedAt: null,
            claimedBy: null,
            nextAttemptAt: now,
            lastErrorCode: null,
            createdAt: now,
            updatedAt: now,
          },
          { transaction },
        );
        await this.audit.record(
          {
            tenantId: scope.tenantId,
            actorUserId: scope.userId,
            action: "commission.run.created",
            resourceType: "commission_run",
            resourceId: runId,
            outcome: "succeeded",
            metadata: {
              start: input.start,
              end: input.end,
              fileCount: uniqueFiles.length,
              dictionaryVersion: active.versionNumber,
            },
          },
          transaction,
        );
      });
      return { runId, status: "queued", created: true };
    } catch (error) {
      const duplicate = await this.repository.findOne(CommissionRunModel, {
        where: { tenantId: scope.tenantId, ownerUserId: scope.userId, idempotencyKey: input.idempotencyKey },
      });
      if (duplicate && duplicate.requestHash === requestHash)
        return { runId: duplicate.runId, status: duplicate.status, created: false };
      throw error;
    }
  }

  async listRuns(scope: Scope) {
    return {
      items: await this.repository.findAll(CommissionRunModel, {
        where: { tenantId: scope.tenantId },
        attributes: [
          "runId",
          "startDate",
          "endDate",
          "status",
          "progressStage",
          "counters",
          "errorCode",
          "createdAt",
          "startedAt",
          "finishedAt",
          "dictionaryVersionId",
        ],
        order: [["createdAt", "DESC"]],
        limit: 100,
        raw: true,
      }),
    };
  }

  async getRun(scope: Scope, runId: string) {
    const run = (await this.repository.findOne(CommissionRunModel, {
      where: { tenantId: scope.tenantId, runId },
    })) as unknown as RunRow | null;
    if (!run) throw new NotFoundException("COMMISSION_RUN_NOT_FOUND");
    const snapshot = await this.repository.findOne(CommissionRunSnapshotModel, {
      where: { tenantId: scope.tenantId, runId },
    });
    const result = snapshot
      ? (JSON.parse(decryptStoredArtifactBytes(runId, snapshot.snapshotCiphertext).bytes.toString("utf8")) as Record<
          string,
          unknown
        >)
      : null;
    if (result) validateCommissionEngineResultV1(result);
    return {
      run: {
        runId: run.runId,
        start: run.startDate,
        end: run.endDate,
        status: run.status,
        progress: run.progressStage,
        counters: run.counters,
        errorCode: run.errorCode,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        dictionaryVersionId: run.dictionaryVersionId,
      },
      result,
    };
  }

  async createExport(scope: Scope, runId: string) {
    const { result, run } = await this.getRun(scope, runId);
    if (!result || !["completed", "completed_with_findings"].includes(run.status))
      throw new ConflictException("COMMISSION_RESULT_NOT_READY");
    const exportId = randomUUID();
    const response = await this.engine.execute<{ workbookBase64: string; sha256: string }>("/internal/v1/export", {
      schemaVersion: 1,
      requestId: randomUUID(),
      executionId: exportId,
      attemptToken: randomUUID(),
      result,
    });
    const bytes = Buffer.from(response.workbookBase64, "base64");
    if (!bytes.length || bytes.length > 64 * 1024 * 1024 || sha256(bytes) !== response.sha256)
      throw new ConflictException("COMMISSION_EXPORT_INVALID");
    const root = process.env.API_EXPORT_DIR;
    if (!root) throw new ConflictException("COMMISSION_STORAGE_NOT_CONFIGURED");
    const storageKey = `artifacts/${exportId}.xlsx`;
    const target = resolve(root, storageKey);
    const temp = resolve(root, "artifacts", `.${exportId}.${randomUUID()}.tmp`);
    const stored = encryptArtifactBytes(exportId, bytes);
    const { mkdir, open, rename, unlink } = await import("node:fs/promises");
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await mkdir(resolve(root, "artifacts"), { recursive: true, mode: 0o700 });
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(stored);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, target);
      await this.repository.create(CommissionExportModel, {
        exportId,
        tenantId: scope.tenantId,
        runId,
        fileName: `porownanie-prowizji-${run.start}-${run.end}.xlsx`,
        storageKey,
        sha256: response.sha256,
        state: "ready",
        createdBy: scope.userId,
        createdAt: new Date(),
      });
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw new ConflictException("COMMISSION_EXPORT_STORE_FAILED");
    }
    await this.audit.record({
      tenantId: scope.tenantId,
      actorUserId: scope.userId,
      action: "commission.export.created",
      resourceType: "commission_export",
      resourceId: exportId,
      outcome: "succeeded",
      metadata: { runId, sizeBytes: bytes.length },
    });
    return { exportId, fileName: `porownanie-prowizji-${run.start}-${run.end}.xlsx`, sizeBytes: bytes.length };
  }

  async downloadExport(scope: Scope, exportId: string) {
    const row = await this.repository.findOne(CommissionExportModel, {
      where: { tenantId: scope.tenantId, exportId, state: "ready" },
    });
    if (!row || row.storageKey !== `artifacts/${exportId}.xlsx`)
      throw new NotFoundException("COMMISSION_EXPORT_NOT_FOUND");
    const root = process.env.API_EXPORT_DIR;
    if (!root) throw new ConflictException("COMMISSION_STORAGE_NOT_CONFIGURED");
    const stored = await readFile(resolve(root, row.storageKey)).catch(() => {
      throw new NotFoundException("COMMISSION_EXPORT_NOT_FOUND");
    });
    const bytes = decryptStoredArtifactBytes(exportId, stored).bytes;
    if (sha256(bytes) !== row.sha256) throw new ConflictException("COMMISSION_EXPORT_INTEGRITY_FAILED");
    await this.audit.record({
      tenantId: scope.tenantId,
      actorUserId: scope.userId,
      action: "commission.export.downloaded",
      resourceType: "commission_export",
      resourceId: exportId,
      outcome: "succeeded",
      metadata: { runId: row.runId, sizeBytes: bytes.length },
    });
    return { fileName: row.fileName, bytes };
  }

  async cancelRun(scope: Scope, runId: string) {
    const result = await this.repository.transaction(async (transaction) => {
      const row = await this.repository.findOne(CommissionRunModel, {
        where: { tenantId: scope.tenantId, runId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw new NotFoundException("COMMISSION_RUN_NOT_FOUND");
      if (["completed", "completed_with_findings", "failed", "cancelled", "cancel_requested"].includes(row.status))
        return { runId, status: row.status, attemptToken: null };

      const dispatch = await this.repository.findOne(CommissionDispatchModel, {
        where: { tenantId: scope.tenantId, runId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!dispatch) throw new ConflictException("COMMISSION_DISPATCH_NOT_FOUND");
      if (!["publishing", "published"].includes(dispatch.status))
        throw new ConflictException("COMMISSION_DISPATCH_NOT_ACTIVE");
      const now = new Date();
      const wasQueued = row.status === "queued";
      row.status = wasQueued ? "cancelled" : "cancel_requested";
      row.progressStage = row.status;
      if (wasQueued) {
        row.finishedAt = now;
        row.executionLeaseUntil = null;
        dispatch.status = "cancelled";
        dispatch.updatedAt = now;
        await this.repository.save(dispatch, { transaction });
      }
      await this.repository.save(row, { transaction });
      await this.audit.record(
        {
          tenantId: scope.tenantId,
          actorUserId: scope.userId,
          action: wasQueued ? "commission.run.cancelled" : "commission.run.cancel_requested",
          resourceType: "commission_run",
          resourceId: runId,
          outcome: "succeeded",
        },
        transaction,
      );
      return { runId, status: row.status, attemptToken: wasQueued ? null : row.activeAttemptToken };
    });
    if (result.status === "cancel_requested" && result.attemptToken)
      await this.engine.cancel(runId, result.attemptToken).catch(() => undefined);
    return { runId: result.runId, status: result.status };
  }

  async addResolution(scope: Scope, runId: string, body: { findingKey: string; decisionCode: string; note?: string }) {
    if (
      !/^[A-Za-z0-9:_-]{1,160}$/.test(body.findingKey) ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(body.decisionCode) ||
      (body.note?.length ?? 0) > 2000
    )
      throw new BadRequestException("INVALID_COMMISSION_RESOLUTION");
    const run = await this.repository.findOne(CommissionRunModel, { where: { tenantId: scope.tenantId, runId } });
    if (!run) throw new NotFoundException("COMMISSION_RUN_NOT_FOUND");
    const resolutionId = randomUUID();
    const noteCiphertext = body.note ? encryptArtifactBytes(resolutionId, Buffer.from(body.note, "utf8")) : null;
    await this.repository.create(CommissionResolutionModel, {
      resolutionId,
      tenantId: scope.tenantId,
      runId,
      findingKey: body.findingKey,
      decisionCode: body.decisionCode,
      noteCiphertext,
      actorUserId: scope.userId,
      createdAt: new Date(),
    });
    await this.audit.record({
      tenantId: scope.tenantId,
      actorUserId: scope.userId,
      action: "commission.resolution.created",
      resourceType: "commission_run",
      resourceId: runId,
      outcome: "succeeded",
      metadata: { findingKey: body.findingKey, decisionCode: body.decisionCode },
    });
    return { resolutionId, created: true };
  }

  private assertWorkbook(file: Express.Multer.File, macroAllowed: boolean): void {
    const extension = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf("."));
    if (
      !file.buffer?.length ||
      file.size > maxFileBytes ||
      file.mimetype === "application/x-msdownload" ||
      ![".xlsx", ...(macroAllowed ? [".xlsm"] : [])].includes(extension)
    )
      throw new BadRequestException("COMMISSION_WORKBOOK_INVALID");
    if (file.buffer.subarray(0, 2).toString("hex") !== "504b")
      throw new BadRequestException("COMMISSION_WORKBOOK_INVALID");
  }

  private async activeDictionaryRow(tenantId: string) {
    return this.repository.findOne(CommissionDictionaryVersionModel, {
      where: { tenantId, isActive: true, status: "published" },
    });
  }

  private decryptPreset(
    row: Pick<DictionaryRow, "dictionaryVersionId" | "snapshotCiphertext">,
  ): Record<string, unknown> {
    const bytes = decryptStoredArtifactBytes(row.dictionaryVersionId, row.snapshotCiphertext).bytes;
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  }

  private async nextDictionaryVersion(tenantId: string): Promise<number> {
    return this.repository.nextDictionaryVersion(tenantId);
  }
}
