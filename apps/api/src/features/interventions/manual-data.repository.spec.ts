import assert from "node:assert/strict";
import { test } from "node:test";

type TestTransaction = { LOCK: { UPDATE: string } };

test("ManualDataRepository keeps locked writes and audit in one transaction", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= "postgres://goldis:unused@127.0.0.1:5432/goldis";
  const [{ ManualDataRepository }, db] = await Promise.all([
    import("./manual-data.repository"),
    import("../../infrastructure/database/db"),
  ]);
  const originals = {
    transaction: db.sequelize.transaction,
    runFind: db.AutomationRun.findByPk,
    batchFind: db.ImportBatch.findByPk,
    interventionFind: db.ManualIntervention.findOne,
    sourceFind: db.SourceRow.findByPk,
    identityFind: db.RunIdentity.findByPk,
    overrideCreate: db.RunManualDataOverride.create,
    eventCreate: db.RunEvent.create,
    auditCreate: db.AuditEvent.create,
  };
  const transaction: TestTransaction = { LOCK: { UPDATE: "UPDATE" } };
  const operations: Array<{ operation: string; transaction?: unknown }> = [];
  const run = {
    id: "run-1",
    batchId: "batch-1",
    startedByUserId: "user-1",
    manualDataVersion: 2,
    status: "waiting_for_manual_data",
    lastSafeStep: null,
    externalCaseRef: null,
    sourceRowId: "source-1",
    async save(options: { transaction?: unknown }) {
      operations.push({ operation: "run.save", transaction: options.transaction });
    },
  };
  const incident = {
    fieldCode: "POSTAL_CODE",
    revision: 4,
    async save(options: { transaction?: unknown }) {
      operations.push({ operation: "incident.save", transaction: options.transaction });
    },
  };

  Reflect.set(db.sequelize, "transaction", async (work: (transaction: TestTransaction) => Promise<unknown>) =>
    work(transaction),
  );
  Reflect.set(db.AutomationRun, "findByPk", async (_id: string, options: { transaction: unknown; lock: string }) => {
    operations.push({ operation: "run.find", transaction: options.transaction });
    assert.equal(options.lock, "UPDATE");
    return run;
  });
  Reflect.set(db.ImportBatch, "findByPk", async (_id: string, options: { transaction: unknown }) => {
    operations.push({ operation: "batch.find", transaction: options.transaction });
    return { tenantId: "tenant-1" };
  });
  Reflect.set(db.ManualIntervention, "findOne", async (options: { transaction: unknown; lock: string }) => {
    operations.push({ operation: "intervention.find", transaction: options.transaction });
    assert.equal(options.lock, "UPDATE");
    return incident;
  });
  Reflect.set(db.SourceRow, "findByPk", async (_id: string, options: { transaction: unknown; lock: string }) => {
    operations.push({ operation: "source.find", transaction: options.transaction });
    assert.equal(options.lock, "UPDATE");
    return { decisionMakerName: null };
  });
  Reflect.set(db.RunIdentity, "findByPk", async () => null);
  Reflect.set(db.RunManualDataOverride, "create", async (_values: unknown, options: { transaction: unknown }) => {
    operations.push({ operation: "override.create", transaction: options.transaction });
  });
  Reflect.set(db.RunEvent, "create", async (_values: unknown, options: { transaction: unknown }) => {
    operations.push({ operation: "event.create", transaction: options.transaction });
  });
  Reflect.set(db.AuditEvent, "create", async (_values: unknown, options: { transaction: unknown }) => {
    operations.push({ operation: "audit.create", transaction: options.transaction });
  });

  try {
    const repository = new ManualDataRepository();
    const version = await repository.withTransaction(async (unitOfWork) => {
      const lockedRun = await unitOfWork.lockRun("run-1");
      assert.ok(lockedRun);
      assert.equal(await unitOfWork.batchTenantId(lockedRun.batchId), "tenant-1");
      assert.deepEqual(await unitOfWork.lockLatestOpenIntervention("run-1"), { fieldCode: "POSTAL_CODE" });
      assert.deepEqual(await unitOfWork.lockSourceDecisionMaker("source-1"), { decisionMakerName: null });
      assert.equal(
        await unitOfWork.applyCorrection({
          runId: "run-1",
          actorUserId: "user-1",
          field: "postalCode",
          fieldCode: "POSTAL_CODE",
          value: "12-345",
          reason: "Uzupełnienie kodu pocztowego",
        }),
        3,
      );
      await unitOfWork.recordAudit({
        tenantId: "tenant-1",
        actorUserId: "user-1",
        action: "run.manual_data_corrected",
        resourceType: "run",
        resourceId: "run-1",
        outcome: "succeeded",
      });
      return 3;
    });

    assert.equal(version, 3);
    assert.equal(run.manualDataVersion, 3);
    assert.equal(incident.revision, 5);
    assert.deepEqual(
      operations.map(({ operation }) => operation),
      [
        "run.find",
        "batch.find",
        "intervention.find",
        "source.find",
        "override.create",
        "run.save",
        "incident.save",
        "event.create",
        "audit.create",
      ],
    );
    assert.ok(operations.every((operation) => operation.transaction === transaction));
  } finally {
    db.sequelize.transaction = originals.transaction;
    db.AutomationRun.findByPk = originals.runFind;
    db.ImportBatch.findByPk = originals.batchFind;
    db.ManualIntervention.findOne = originals.interventionFind;
    db.SourceRow.findByPk = originals.sourceFind;
    db.RunIdentity.findByPk = originals.identityFind;
    db.RunManualDataOverride.create = originals.overrideCreate;
    db.RunEvent.create = originals.eventCreate;
    db.AuditEvent.create = originals.auditCreate;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
