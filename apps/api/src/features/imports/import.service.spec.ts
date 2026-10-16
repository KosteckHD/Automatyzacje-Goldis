import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sequelize, Transaction } from "sequelize";
import type { AuditService } from "../audit/public";
import { ImportService } from "./import.service";
import type { ImportsRepository } from "./imports.repository";

test("ImportService keeps a correction, source version, and audit event in one transaction", async () => {
  const transaction = {} as Transaction;
  const calls: Array<{ kind: "repository" | "audit"; input?: unknown; transaction?: Transaction }> = [];
  const database = {
    transaction: async (callback: (transaction: Transaction) => Promise<unknown>) => callback(transaction),
  } as Sequelize;
  const repository = {
    async proposeRegonCorrection(input: unknown) {
      calls.push({ kind: "repository", input });
      return {
        kind: "created" as const,
        correction: {
          correctionId: "77777777-7777-4777-8777-777777777777",
          previousRegon: null,
          proposedRegon: "012345675",
          status: "pending" as const,
          createdAt: new Date("2026-10-16T10:00:00.000Z"),
        },
        row: { rowNumber: 18001, rowVersion: 2 },
      };
    },
  } as unknown as ImportsRepository;
  const audit = {
    async record(input: unknown, passedTransaction?: Transaction) {
      calls.push({ kind: "audit", input, transaction: passedTransaction });
    },
  } as unknown as AuditService;
  const service = new ImportService(database, repository, audit);

  const result = await service.proposeRegonCorrection(
    "12345678-1234-1234-1234-123456789abc",
    18001,
    { proposedRegon: "012345675", reason: "confirmed against registry", expectedVersion: 1 },
    "synthetic-operator",
    { tenantId: "99999999-9999-4999-8999-999999999999", actorUserId: "11111111-1111-4111-8111-111111111111" },
  );

  assert.equal(result.rowVersion, 2);
  assert.equal(calls[0]?.kind, "repository");
  assert.equal(calls[1]?.kind, "audit");
  assert.equal(calls[1]?.transaction, transaction);
});

test("ImportService maps a missing correction row to 404 without auditing", async () => {
  const database = {
    transaction: async (callback: (transaction: Transaction) => Promise<unknown>) => callback({} as Transaction),
  } as Sequelize;
  const repository = {
    async proposeRegonCorrection() {
      return { kind: "not_found" as const };
    },
  } as unknown as ImportsRepository;
  let audited = false;
  const audit = {
    async record() {
      audited = true;
    },
  } as unknown as AuditService;
  const service = new ImportService(database, repository, audit);

  await assert.rejects(
    service.proposeRegonCorrection(
      "12345678-1234-1234-1234-123456789abc",
      18001,
      { proposedRegon: "012345675", reason: "confirmed against registry", expectedVersion: 1 },
      "synthetic-operator",
    ),
    (error) => (error as { getStatus?: () => number }).getStatus?.() === 404,
  );
  assert.equal(audited, false);
});
