import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { SessionPrincipal } from "../auth/public";
import type { DeletionJobsRepository } from "./deletion-jobs.repository";
import { DeletionJobsService } from "./deletion-jobs.service";

const actor: SessionPrincipal = {
  exp: Date.now() + 60_000,
  csrf: "synthetic-csrf-token-for-deletion-jobs-test-1234567890",
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  actorRef: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  version: 2,
  role: "admin",
};

function serviceWithRepository() {
  const calls: string[] = [];
  const repository = {
    async findMembership() {
      calls.push("findMembership");
      return null;
    },
  } as unknown as DeletionJobsRepository;
  return { service: new DeletionJobsService(repository), calls };
}

test("DeletionJobsService rejects a missing active session before persistence", async () => {
  const { service, calls } = serviceWithRepository();
  const actorWithoutSession = { ...actor, sessionId: undefined };

  await assert.rejects(
    service.create(actorWithoutSession, {}),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.deepEqual(calls, []);
});

test("DeletionJobsService rejects malformed job commands before persistence", async () => {
  const { service, calls } = serviceWithRepository();

  await assert.rejects(
    service.create(actor, { previewId: "not-a-uuid", idempotencyKey: "short" }),
    (error: unknown) => error instanceof BadRequestException,
  );
  assert.deepEqual(calls, []);
});
