import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Transaction } from "sequelize";
import { sequelize, type ToolSettings } from "../../infrastructure/database/db";
import type { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import type { AdminMutationsService } from "./admin-mutations.service";
import type { AdminToolSettingsUpdate } from "./admin-tools.dto";
import type { AdminToolsRepository } from "./admin-tools.repository";
import { AdminToolsService } from "./admin-tools.service";

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ??= "postgres://synthetic:unused@127.0.0.1:5432/goldis_admin_tools_service_test";

after(async () => {
  await sequelize.close();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  role: "admin",
} as SessionPrincipal;
const input: AdminToolSettingsUpdate = {
  enabledForNewRuns: true,
  maxNewRunsPerHour: 15,
  allowedLocalStart: "08:00",
  allowedLocalEnd: "16:00",
  timezone: "Europe/Warsaw",
  expectedVersion: 4,
};

function createSettings(version = 4) {
  return {
    enabledForNewRuns: false,
    maxNewRunsPerHour: null,
    allowedLocalStart: null,
    allowedLocalEnd: null,
    timezone: "Europe/Warsaw",
    version,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as unknown as ToolSettings;
}

async function withTransaction<T>(run: (transaction: Transaction) => Promise<T>): Promise<T> {
  const database = sequelize as unknown as {
    transaction: (callback: (transaction: Transaction) => Promise<unknown>) => Promise<unknown>;
  };
  const previous = database.transaction;
  const transaction = { LOCK: { UPDATE: "UPDATE" } } as unknown as Transaction;
  database.transaction = async (callback) => callback(transaction);
  try {
    return await run(transaction);
  } finally {
    database.transaction = previous;
  }
}

test("AdminToolsService passes tenant scope through the repository and audits the saved change in its transaction", async () => {
  const settings = createSettings();
  let saved = false;
  let lockedActor: SessionPrincipal | undefined;
  let auditWrite: { event: unknown; transaction?: Transaction } | undefined;
  let transaction: Transaction | undefined;
  const repository = {
    transaction: async (work: (activeTransaction: Transaction) => Promise<unknown>) => sequelize.transaction(work),
    listTools: async () => [{ toolId: "oc", displayName: "OC", description: "Weryfikacja", status: "available" }],
    findSettings: async (tenantId: string, toolId: string, receivedTransaction?: Transaction, lock?: boolean) => {
      assert.equal(tenantId, actor.tenantId);
      assert.equal(toolId, "oc");
      assert.equal(receivedTransaction, transaction);
      assert.equal(lock, true);
      return settings;
    },
    saveSettings: async (
      receivedSettings: ToolSettings,
      actorUserId: string,
      update: AdminToolSettingsUpdate,
      receivedTransaction: Transaction,
    ) => {
      assert.equal(receivedSettings, settings);
      assert.equal(actorUserId, actor.userId);
      assert.deepEqual(update, input);
      assert.equal(receivedTransaction, transaction);
      Object.assign(settings, {
        enabledForNewRuns: update.enabledForNewRuns,
        maxNewRunsPerHour: update.maxNewRunsPerHour,
        allowedLocalStart: update.allowedLocalStart,
        allowedLocalEnd: update.allowedLocalEnd,
        timezone: update.timezone,
        version: settings.version + 1,
      });
      saved = true;
      return settings;
    },
  } as unknown as AdminToolsRepository;
  const mutations = {
    lockTenantAdminChanges: async (receivedActor: SessionPrincipal, receivedTransaction: Transaction) => {
      lockedActor = receivedActor;
      assert.equal(receivedTransaction, transaction);
    },
  } as unknown as AdminMutationsService;
  const audit = {
    record: async (event: unknown, receivedTransaction?: Transaction) => {
      auditWrite = { event, transaction: receivedTransaction };
    },
  } as unknown as AuditService;
  const service = new AdminToolsService(repository, audit, mutations);

  const result = await withTransaction(async (activeTransaction) => {
    transaction = activeTransaction;
    assert.deepEqual(await service.listTools(), {
      items: [{ toolId: "oc", displayName: "OC", description: "Weryfikacja", status: "available" }],
    });
    return service.updateSettings(actor, "oc", input);
  });

  assert.equal(lockedActor, actor);
  assert.equal(saved, true);
  assert.deepEqual(result, {
    toolId: "oc",
    enabledForNewRuns: true,
    maxNewRunsPerHour: 15,
    allowedLocalStart: "08:00",
    allowedLocalEnd: "16:00",
    timezone: "Europe/Warsaw",
    version: 5,
    updatedAt: settings.updatedAt,
  });
  assert.deepEqual(auditWrite?.event, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    action: "settings.updated",
    resourceType: "settings",
    resourceId: "oc",
    outcome: "succeeded",
    metadata: { version: 5, enabledForNewRuns: true, wasEnabled: false },
  });
  assert.equal(auditWrite?.transaction, transaction);
});

test("AdminToolsService refuses missing and stale settings before saving or auditing", async () => {
  let findResult: ToolSettings | null = null;
  let saves = 0;
  let audits = 0;
  const repository = {
    transaction: async (work: (activeTransaction: Transaction) => Promise<unknown>) => sequelize.transaction(work),
    findSettings: async () => findResult,
    saveSettings: async () => {
      saves += 1;
      return createSettings();
    },
  } as unknown as AdminToolsRepository;
  const service = new AdminToolsService(
    repository,
    {
      record: async () => {
        audits += 1;
      },
    } as unknown as AuditService,
    { lockTenantAdminChanges: async () => undefined } as unknown as AdminMutationsService,
  );

  await assert.rejects(service.getSettings(actor.tenantId, "missing"), NotFoundException);
  await withTransaction(async () => {
    await assert.rejects(service.updateSettings(actor, "oc", input), NotFoundException);
    findResult = createSettings(2);
    await assert.rejects(service.updateSettings(actor, "oc", input), ConflictException);
  });
  assert.equal(saves, 0);
  assert.equal(audits, 0);
});
