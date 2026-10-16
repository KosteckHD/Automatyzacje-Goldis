import { Injectable } from "@nestjs/common";
import type { Transaction } from "sequelize";
import type {
  AutomationRun as AutomationRunInstance,
  ManualIntervention as ManualInterventionInstance,
} from "../../infrastructure/database/db";
import {
  AutomationRun,
  ImportBatch,
  ManualIntervention,
  RunEvent,
  RunIdentity,
  RunManualDataOverride,
  SourceRow,
  sequelize,
} from "../../infrastructure/database/db";
import { recordAuditEvent } from "../audit/public";
import type { ManualDataField } from "./manual-data.contract";

export type ManualDataRunState = Readonly<{
  id: string;
  batchId: string;
  startedByUserId: string | null;
  manualDataVersion: number;
  status: string;
  lastSafeStep: string | null;
  externalCaseRef: string | null;
  sourceRowId: string;
}>;

export type ManualDataInterventionState = Readonly<{ fieldCode: string | null }>;

export type ManualDataUnitOfWork = Readonly<{
  lockRun(runId: string): Promise<ManualDataRunState | null>;
  batchTenantId(batchId: string): Promise<string | null>;
  lockLatestOpenIntervention(runId: string): Promise<ManualDataInterventionState | null>;
  lockSourceDecisionMaker(sourceRowId: string): Promise<{ decisionMakerName: string | null } | null>;
  hasRunIdentity(runId: string): Promise<boolean>;
  applyCorrection(input: {
    runId: string;
    actorUserId: string;
    field: ManualDataField;
    fieldCode: string;
    value: string;
    reason: string;
  }): Promise<number>;
  recordAudit(input: Parameters<typeof recordAuditEvent>[0]): Promise<void>;
}>;

class ManualDataTransaction implements ManualDataUnitOfWork {
  private run: AutomationRunInstance | null = null;
  private incident: ManualInterventionInstance | null = null;

  constructor(private readonly transaction: Transaction) {}

  async lockRun(runId: string): Promise<ManualDataRunState | null> {
    this.run = (await AutomationRun.findByPk(runId, {
      transaction: this.transaction,
      lock: this.transaction.LOCK.UPDATE,
    })) as AutomationRunInstance | null;
    if (!this.run) return null;
    return {
      id: this.run.id,
      batchId: this.run.batchId,
      startedByUserId: this.run.startedByUserId,
      manualDataVersion: this.run.manualDataVersion,
      status: this.run.status,
      lastSafeStep: this.run.lastSafeStep,
      externalCaseRef: this.run.externalCaseRef,
      sourceRowId: this.run.sourceRowId,
    };
  }

  async batchTenantId(batchId: string) {
    const batch = await ImportBatch.findByPk(batchId, {
      attributes: ["tenantId"],
      transaction: this.transaction,
    });
    return batch?.tenantId ?? null;
  }

  async lockLatestOpenIntervention(runId: string): Promise<ManualDataInterventionState | null> {
    this.incident = (await ManualIntervention.findOne({
      where: { runId, status: "open" },
      order: [["createdAt", "DESC"]],
      transaction: this.transaction,
      lock: this.transaction.LOCK.UPDATE,
    })) as ManualInterventionInstance | null;
    return this.incident ? { fieldCode: this.incident.fieldCode } : null;
  }

  async lockSourceDecisionMaker(sourceRowId: string) {
    const source = await SourceRow.findByPk(sourceRowId, {
      attributes: ["decisionMakerName"],
      transaction: this.transaction,
      lock: this.transaction.LOCK.UPDATE,
    });
    return source ? { decisionMakerName: source.decisionMakerName } : null;
  }

  async hasRunIdentity(runId: string) {
    return (
      (await RunIdentity.findByPk(runId, { transaction: this.transaction, lock: this.transaction.LOCK.UPDATE })) !==
      null
    );
  }

  async applyCorrection(input: {
    runId: string;
    actorUserId: string;
    field: ManualDataField;
    fieldCode: string;
    value: string;
    reason: string;
  }) {
    if (!this.run || !this.incident)
      throw new Error("Manual data correction requires locked run and intervention rows");

    const version = this.run.manualDataVersion + 1;
    const now = new Date();
    await RunManualDataOverride.create(
      {
        runId: input.runId,
        version,
        source: "admin_correction",
        fields: { [input.field]: input.value },
        reason: input.reason,
        createdBy: input.actorUserId,
        createdAt: now,
      },
      { transaction: this.transaction },
    );
    this.run.manualDataVersion = version;
    await this.run.save({ transaction: this.transaction });
    this.incident.revision += 1;
    this.incident.updatedAt = now;
    await this.incident.save({ transaction: this.transaction });
    await RunEvent.create(
      {
        runId: input.runId,
        status: this.run.status,
        step: "manual_data_corrected",
        errorCode: null,
        actorId: input.actorUserId,
        metadata: { fieldCode: input.fieldCode, version },
        createdAt: now,
      },
      { transaction: this.transaction },
    );
    return version;
  }

  recordAudit(input: Parameters<typeof recordAuditEvent>[0]) {
    return recordAuditEvent(input, this.transaction);
  }
}

@Injectable()
export class ManualDataRepository {
  withTransaction<T>(work: (unitOfWork: ManualDataUnitOfWork) => Promise<T>) {
    return sequelize.transaction((transaction) => work(new ManualDataTransaction(transaction)));
  }
}
