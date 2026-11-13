import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictException } from "@nestjs/common";
import type { AuditService } from "../audit/public";
import { decryptStoredArtifactBytes, encryptArtifactBytes } from "../results/public";
import { CommissionDictionaryVersionModel, CommissionDispatchModel, CommissionRunModel } from "./commissions.model";
import type { CommissionsRepository } from "./commissions.repository";
import { CommissionsService } from "./commissions.service";

const dictionaryVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const key = Buffer.alloc(32, 7).toString("base64");
const cryptoEnvironment = {
  APP_ENV: "test",
  ARTIFACT_REQUIRE_ENCRYPTION: "1",
  ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
  ARTIFACT_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": key }), "utf8").toString("base64"),
};

function encryptedSnapshot(value: unknown): Buffer {
  return encryptArtifactBytes(dictionaryVersionId, Buffer.from(JSON.stringify(value), "utf8"), cryptoEnvironment);
}

function readSnapshot(ciphertext: Buffer): Record<string, unknown> {
  return JSON.parse(decryptStoredArtifactBytes(dictionaryVersionId, ciphertext, cryptoEnvironment).bytes.toString("utf8"));
}

function snapshot() {
  return {
    client_dictionary: {
      entries: [{
        id: "SL-0001",
        risk: "OC",
        source: "synthetic.xlsx",
        sheet: "Synthetic",
        variant: "A",
        agents: {
          Ola: { status: "RATE", rate: 10, rule_id: "CLIENT_SL_0001_OLA", cell: "D8", raw: 10 },
          Maciek: { status: "RATE", rate: 12, rule_id: "CLIENT_SL_0001_MACIEK", cell: "E8", raw: 12 },
        },
      }],
    },
    rules: {
      CLIENT_SL_0001_OLA: { rate: 10 },
      CLIENT_SL_0001_MACIEK: { rate: 12 },
    },
  };
}

function makeHarness(initialSnapshot: unknown, auditShouldFail = false) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(cryptoEnvironment)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  const transaction = { LOCK: { UPDATE: Symbol("UPDATE") } };
  const row = {
    dictionaryVersionId,
    tenantId,
    status: "draft",
    revision: 1,
    snapshotCiphertext: encryptedSnapshot(initialSnapshot),
    snapshotSha256: "before",
  };
  let saves = 0;
  let audits = 0;
  let auditTransaction: unknown;
  const repository = {
    transaction: async <T>(work: (tx: typeof transaction) => Promise<T>) => work(transaction),
    findOne: async (model: unknown, options: Record<string, unknown>) => {
      assert.equal(model, CommissionDictionaryVersionModel);
      assert.deepEqual(options.where, { tenantId, dictionaryVersionId, status: "draft" });
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, transaction.LOCK.UPDATE);
      return row;
    },
    save: async (saved: typeof row, options: { transaction: unknown }) => {
      assert.equal(saved, row);
      assert.equal(options.transaction, transaction);
      saves += 1;
      return saved;
    },
  } as unknown as CommissionsRepository;
  const audit = {
    record: async (_event: unknown, tx: unknown) => {
      audits += 1;
      auditTransaction = tx;
      if (auditShouldFail) throw new Error("SYNTHETIC_AUDIT_FAILURE");
    },
  } as unknown as AuditService;
  return {
    service: new CommissionsService(repository, audit),
    row,
    transaction,
    get saves() { return saves; },
    get audits() { return audits; },
    get auditTransaction() { return auditTransaction; },
    cleanup() {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

test("edycja słownika zapisuje snapshot, rewizję i audyt w tej samej transakcji", async () => {
  const harness = makeHarness(snapshot());
  try {
    const result = await harness.service.editDictionaryEntry(
      { tenantId, userId, role: "admin" },
      dictionaryVersionId,
      "SL-0001",
      { revision: 1, agent: "Ola", status: "RATE", rate: 25 },
    );
    assert.equal(result.revision, 2);
    assert.equal(result.entry.id, "SL-0001");
    assert.equal(harness.row.revision, 2);
    assert.equal(harness.saves, 1);
    assert.equal(harness.audits, 1);
    assert.notEqual(harness.row.snapshotSha256, "before");
    assert.equal(harness.auditTransaction, harness.transaction);
    const saved = readSnapshot(harness.row.snapshotCiphertext);
    const entry = (saved.client_dictionary as { entries: Array<{ agents: Record<string, { rate: number }> }> }).entries[0];
    assert.equal(entry.agents.Ola.rate, 25);
    assert.equal(entry.agents.Maciek.rate, 12);
    assert.equal((saved.rules as Record<string, { rate: number }>).CLIENT_SL_0001_OLA.rate, 25);
  } finally {
    harness.cleanup();
  }
});

test("niepoprawny zaszyfrowany snapshot jest odrzucany bez save ani audytu", async () => {
  const malformed = snapshot();
  (malformed.client_dictionary.entries[0] as unknown as { agents: Record<string, unknown> }).agents = {
    Maciek: { status: "RATE", rate: 12, rule_id: "CLIENT_SL_0001_MACIEK", cell: "E8", raw: 12 },
  };
  const harness = makeHarness(malformed);
  try {
    await assert.rejects(
      harness.service.editDictionaryEntry(
        { tenantId, userId, role: "admin" },
        dictionaryVersionId,
        "SL-0001",
        { revision: 1, agent: "Ola", status: "RATE", rate: 25 },
      ),
      (error: unknown) => error instanceof ConflictException && error.message.includes("COMMISSION_DICTIONARY_SNAPSHOT_INVALID"),
    );
    assert.equal(harness.row.revision, 1);
    assert.equal(harness.saves, 0);
    assert.equal(harness.audits, 0);
  } finally {
    harness.cleanup();
  }
});

test("zastrzeżona nazwa reguły w snapshotcie nie trafia do prototypu ani do zapisu", async () => {
  const malformed = snapshot();
  malformed.client_dictionary.entries[0].agents.Ola.rule_id = "__proto__";
  Object.defineProperty(malformed.rules, "__proto__", {
    value: { rate: 10 }, enumerable: true, configurable: true, writable: true,
  });
  const harness = makeHarness(malformed);
  try {
    await assert.rejects(
      harness.service.editDictionaryEntry(
        { tenantId, userId, role: "admin" },
        dictionaryVersionId,
        "SL-0001",
        { revision: 1, agent: "Ola", status: "RATE", rate: 25 },
      ),
      (error: unknown) => error instanceof ConflictException && error.message.includes("COMMISSION_DICTIONARY_SNAPSHOT_INVALID"),
    );
    assert.equal(harness.row.revision, 1);
    assert.equal(harness.saves, 0);
    assert.equal(harness.audits, 0);
  } finally {
    harness.cleanup();
  }
});

test("awaria audytu propaguje się, a repozytorium przekazuje tę samą transakcję do obu zapisów", async () => {
  const harness = makeHarness(snapshot(), true);
  try {
    await assert.rejects(
      harness.service.editDictionaryEntry(
        { tenantId, userId, role: "admin" },
        dictionaryVersionId,
        "SL-0001",
        { revision: 1, agent: "Ola", status: "RATE", rate: 25 },
      ),
      /SYNTHETIC_AUDIT_FAILURE/,
    );
    assert.equal(harness.saves, 1);
    assert.equal(harness.audits, 1);
    assert.equal(harness.auditTransaction, harness.transaction);
  } finally {
    harness.cleanup();
  }
});

function cancellationHarness(status: string) {
  const transaction = { LOCK: { UPDATE: Symbol("UPDATE") } };
  const run = { runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", tenantId, status, progressStage: status, finishedAt: null, executionLeaseUntil: new Date() };
  const dispatch = { tenantId, runId: run.runId, status: "published", updatedAt: new Date() };
  const saves: Array<{ model: unknown; transaction: unknown }> = [];
  const audits: Array<{ action: string; transaction: unknown }> = [];
  const repository = {
    transaction: async <T>(work: (tx: typeof transaction) => Promise<T>) => work(transaction),
    findOne: async (model: unknown, options: Record<string, unknown>) => {
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, transaction.LOCK.UPDATE);
      return model === CommissionRunModel ? run : model === CommissionDispatchModel ? dispatch : null;
    },
    save: async (model: unknown, options: { transaction: unknown }) => {
      saves.push({ model, transaction: options.transaction });
      return model;
    },
  } as unknown as CommissionsRepository;
  const audit = {
    record: async (event: { action: string }, tx: unknown) => audits.push({ action: event.action, transaction: tx }),
  } as unknown as AuditService;
  return { service: new CommissionsService(repository, audit), transaction, run, dispatch, saves, audits };
}

test("anulowanie kolejki atomowo zamyka dispatch i audytuje zmianę", async () => {
  const harness = cancellationHarness("queued");
  const result = await harness.service.cancelRun({ tenantId, userId, role: "admin" }, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.deepEqual(result, { runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "cancelled" });
  assert.equal(harness.run.status, "cancelled");
  assert.equal(harness.dispatch.status, "cancelled");
  assert.deepEqual(harness.saves.map((item) => item.model), [harness.dispatch, harness.run]);
  assert.ok(harness.saves.every((item) => item.transaction === harness.transaction));
  assert.deepEqual(harness.audits, [{ action: "commission.run.cancelled", transaction: harness.transaction }]);
});

test("anulowanie działającej próby zapisuje żądanie z audytem, a powtórzenie jest idempotentne", async () => {
  const harness = cancellationHarness("running");
  const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  assert.deepEqual(await harness.service.cancelRun({ tenantId, userId, role: "admin" }, runId), {
    runId,
    status: "cancel_requested",
  });
  assert.equal(harness.run.status, "cancel_requested");
  assert.equal(harness.dispatch.status, "published");
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].transaction, harness.transaction);
  assert.equal(harness.audits[0].action, "commission.run.cancel_requested");
  assert.deepEqual(await harness.service.cancelRun({ tenantId, userId, role: "admin" }, runId), {
    runId,
    status: "cancel_requested",
  });
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.audits.length, 1);
});
