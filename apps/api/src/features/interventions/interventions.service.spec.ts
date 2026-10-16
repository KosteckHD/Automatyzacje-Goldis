import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { InterventionListRow, InterventionRepository } from "./interventions.repository";
import { InterventionService } from "./interventions.service";

const baseRow = (overrides: Partial<InterventionListRow> = {}): InterventionListRow => ({
  interventionId: "c2a1b3e0-cf64-4fad-ae96-e6b3355f39a1",
  runId: "ff07af66-2b4c-4898-a902-b28b2f56c1d2",
  batchId: "bf47caef-f1da-4d05-bb4b-d39b70053c8a",
  rowNumber: 1,
  runStatus: "waiting_for_sms",
  kind: "sms",
  portal: "pzu",
  reasonCode: "SMS_REQUIRED",
  status: "open",
  revision: 2,
  createdAt: new Date("2026-10-16T10:00:00.000Z"),
  updatedAt: new Date("2026-10-16T10:01:00.000Z"),
  challengeId: "aab17d94-386e-4f7b-9721-e92f55c4b37d",
  challengeStatus: "active",
  expiresAt: new Date(Date.now() + 60_000),
  attemptCount: 1,
  attemptLimit: 3,
  seenRevision: 1,
  fieldCode: "EXPECTED_PERSON",
  manualDataVersion: 1,
  lastSafeStep: null,
  externalCaseRef: null,
  assigneeUserId: "user-1",
  assigneeUsername: "operator",
  priority: "normal",
  dueAt: null,
  canViewResults: true,
  canExecute: true,
  overrideVersion: null,
  overrideFields: null,
  errorCode: null,
  retryCount: 0,
  ownerUserId: "user-1",
  startedByUserId: "user-1",
  ...overrides,
});

function createService(rows: InterventionListRow[]) {
  const calls: unknown[] = [];
  const repository = {
    list: async (query: unknown) => {
      calls.push(query);
      return rows;
    },
    summary: async () => null,
    markRead: async () => null,
  } as unknown as InterventionRepository;
  return { service: new InterventionService(repository), calls };
}

test("InterventionService rejects invalid filters and cursors before repository access", async () => {
  const { service, calls } = createService([]);
  await assert.rejects(
    () => service.list({ tenantId: "t", userId: "u", role: "operator" }, { limit: "101" }),
    BadRequestException,
  );
  await assert.rejects(
    () => service.list({ tenantId: "t", userId: "u", role: "operator" }, { cursor: "not-base64-json" }),
    BadRequestException,
  );
  assert.equal(calls.length, 0);
});

test("InterventionService maps repository rows to the redacted paginated response contract", async () => {
  const { service, calls } = createService([
    baseRow({ canViewResults: false, fieldCode: "EXPECTED_PERSON" }),
    baseRow({
      interventionId: "f51b7922-c455-4a90-98c1-c17d0f74426a",
      createdAt: new Date("2026-10-15T10:00:00.000Z"),
    }),
  ]);
  const response = await service.list({ tenantId: "tenant-1", userId: "user-1", role: "operator" }, { limit: "1" });
  const [firstItem] = response.items;

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    tenantId: "tenant-1",
    userId: "user-1",
    role: "operator",
    status: "open",
    portal: null,
    kind: null,
    cursorCreated: null,
    cursorId: null,
    fetchLimit: 2,
  });
  assert.equal(response.items.length, 1);
  assert.equal(firstItem?.fieldCode, null);
  assert.equal(firstItem?.canSubmitSms, true);
  assert.ok(firstItem);
  assert.ok(firstItem.challenge && typeof firstItem.challenge === "object");
  assert.equal((firstItem.challenge as { challengeId: string }).challengeId, "aab17d94-386e-4f7b-9721-e92f55c4b37d");
  assert.ok(response.nextCursor);
  assert.equal(JSON.stringify(response).includes("overrideFields"), false);
});

test("InterventionService normalizes empty summary counts", async () => {
  const { service } = createService([]);
  assert.deepEqual(await service.summary({ tenantId: "tenant-1", userId: "user-1", role: "operator" }), {
    openCount: 0,
    unreadCount: 0,
    smsCount: 0,
  });
});
