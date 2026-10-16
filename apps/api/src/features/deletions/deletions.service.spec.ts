import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { DeletionsPreviewRepository } from "./deletions.repository";
import { DeletionsService } from "./deletions.service";

const actor = {
  exp: Date.now() + 60_000,
  csrf: "synthetic-csrf-token-for-deletions-test-1234567890",
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  actorRef: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  version: 2 as const,
  role: "admin" as const,
};

function repositoryStub(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; input?: Record<string, unknown> }> = [];
  const repository = {
    async findMembership(tenantId: string, userId: string) {
      calls.push({ method: "findMembership", input: { tenantId, userId } });
      return { role: "admin", canDeleteData: false };
    },
    async withRepeatableRead(work: (transaction: object) => Promise<unknown>) {
      calls.push({ method: "withRepeatableRead" });
      return work({ id: "synthetic-transaction" });
    },
    async loadSnapshot(input: Record<string, unknown>) {
      calls.push({ method: "loadSnapshot", input });
      return {
        summary: { targetType: input.targetType, targetId: input.targetId, counts: { imports: 1 }, blockers: [] },
        sourceVersion: "synthetic-source-version",
      };
    },
    async replacePreview(input: Record<string, unknown>, transaction: object) {
      calls.push({ method: "replacePreview", input: { ...input, transaction } });
    },
    ...overrides,
  };
  return { repository: repository as unknown as DeletionsPreviewRepository, calls };
}

test("DeletionsService creates a scoped preview in one repeatable-read transaction", async () => {
  const { repository, calls } = repositoryStub();
  const service = new DeletionsService(repository);
  const result = await service.preview({
    actor,
    body: { targetType: "import", targetId: "33333333-3333-4333-8333-333333333333" },
  });

  assert.equal(result.targetType, "import");
  assert.equal(result.targetId, "33333333-3333-4333-8333-333333333333");
  assert.equal(result.requiresStepUp, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["findMembership", "withRepeatableRead", "loadSnapshot", "replacePreview"],
  );
  const persisted = calls.find((call) => call.method === "replacePreview")?.input;
  assert.equal(persisted?.sessionId, actor.sessionId);
  assert.match(String(persisted?.fingerprint), /^[0-9a-f]{64}$/);
  assert.equal(persisted?.targetType, "import");
});

test("DeletionsService rejects malformed scope before touching persistence", async () => {
  const { repository, calls } = repositoryStub();
  const service = new DeletionsService(repository);

  await assert.rejects(
    service.preview({ actor, body: { targetType: "run", targetId: "not-a-uuid", extra: true } }),
    (error: unknown) => error instanceof BadRequestException,
  );
  assert.deepEqual(calls, []);
});

test("DeletionsService enforces membership role and target policy before creating a preview", async () => {
  const noMembership = repositoryStub({
    async findMembership() {
      return null;
    },
  });
  await assert.rejects(
    new DeletionsService(noMembership.repository).preview({
      actor,
      body: { targetType: "run", targetId: "33333333-3333-4333-8333-333333333333" },
    }),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(
    noMembership.calls.some((call) => call.method === "withRepeatableRead"),
    false,
  );

  const nonAdminTenant = repositoryStub({
    async findMembership() {
      return { role: "manager", canDeleteData: true };
    },
  });
  await assert.rejects(
    new DeletionsService(nonAdminTenant.repository).preview({ actor, body: { targetType: "tenant" } }),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(
    nonAdminTenant.calls.some((call) => call.method === "withRepeatableRead"),
    false,
  );

  const operatorRun = repositoryStub({
    async findMembership() {
      return { role: "operator", canDeleteData: false };
    },
  });
  await assert.rejects(
    new DeletionsService(operatorRun.repository).preview({
      actor,
      body: { targetType: "run", targetId: "33333333-3333-4333-8333-333333333333" },
    }),
    (error: unknown) => error instanceof NotFoundException,
  );
  assert.equal(
    operatorRun.calls.some((call) => call.method === "replacePreview"),
    false,
  );
});
