import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { ManualDataRepository, ManualDataUnitOfWork } from "./manual-data.repository";
import { ManualDataService } from "./manual-data.service";

const run = {
  id: "run-1",
  batchId: "batch-1",
  startedByUserId: "user-1",
  manualDataVersion: 2,
  status: "waiting_for_manual_data",
  lastSafeStep: null,
  externalCaseRef: null,
  sourceRowId: "source-1",
} as const;

function createService(overrides: Partial<ManualDataUnitOfWork> = {}) {
  const calls: string[] = [];
  const unitOfWork: ManualDataUnitOfWork = {
    lockRun: async () => {
      calls.push("lockRun");
      return run;
    },
    batchTenantId: async () => {
      calls.push("batchTenantId");
      return "tenant-1";
    },
    lockLatestOpenIntervention: async () => {
      calls.push("lockLatestOpenIntervention");
      return { fieldCode: "POSTAL_CODE" };
    },
    lockSourceDecisionMaker: async () => {
      calls.push("lockSourceDecisionMaker");
      return { decisionMakerName: null };
    },
    hasRunIdentity: async () => {
      calls.push("hasRunIdentity");
      return false;
    },
    applyCorrection: async () => {
      calls.push("applyCorrection");
      return 3;
    },
    recordAudit: async () => {
      calls.push("recordAudit");
    },
    ...overrides,
  };
  const repository = {
    withTransaction: <T>(work: (unitOfWork: ManualDataUnitOfWork) => Promise<T>) => work(unitOfWork),
  } as ManualDataRepository;
  return { service: new ManualDataService(repository), calls };
}

const actor = { actorUserId: "user-1", tenantId: "tenant-1" };
const validPatch = {
  expectedVersion: 2,
  fields: { postalCode: "12-345" },
  reason: "Uzupełnienie kodu pocztowego",
};

test("ManualDataService validates and persists a correction with audit inside the repository transaction", async () => {
  const { service, calls } = createService();
  assert.deepEqual(await service.patch("run-1", actor, validPatch), {
    runId: "run-1",
    manualDataVersion: 3,
    fieldCode: "POSTAL_CODE",
    canResumeReview: true,
  });
  assert.deepEqual(calls, [
    "lockRun",
    "batchTenantId",
    "lockLatestOpenIntervention",
    "lockSourceDecisionMaker",
    "applyCorrection",
    "recordAudit",
  ]);
});

test("ManualDataService rejects non-starters before writing a correction", async () => {
  const { service, calls } = createService({
    lockRun: async () => ({ ...run, startedByUserId: "someone-else" }),
  });
  await assert.rejects(() => service.patch("run-1", actor, validPatch), ForbiddenException);
  assert.deepEqual(calls, []);
});

test("ManualDataService blocks changing the expected person after identity has been recorded", async () => {
  const { service, calls } = createService({
    lockRun: async () => ({ ...run, status: "identity_review" }),
    lockLatestOpenIntervention: async () => ({ fieldCode: "EXPECTED_PERSON" }),
    hasRunIdentity: async () => {
      calls.push("hasRunIdentity");
      return true;
    },
  });
  await assert.rejects(
    () =>
      service.patch("run-1", actor, {
        expectedVersion: 2,
        fields: { expectedPersonName: "Ala Testowa" },
        reason: "Uzupełnienie oczekiwanej osoby",
      }),
    ConflictException,
  );
  assert.equal(calls.includes("applyCorrection"), false);
  assert.equal(calls.includes("recordAudit"), false);
});
