import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { hashPassword } from "../auth";
import type { DeletionStepUpRepository } from "./deletion-step-up.repository";
import { DeletionStepUpService } from "./deletion-step-up.service";

const actor = {
  exp: Date.now() + 60_000,
  csrf: "synthetic-csrf-token-for-deletion-step-up-test-1234567890",
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  actorRef: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  version: 2 as const,
  role: "admin" as const,
};

test("DeletionStepUpService verifies the current password and asks the repository to issue a scoped grant", async () => {
  const password = "Synthetic current password 2026!";
  const passwordHash = await hashPassword(password);
  const issued: Array<Record<string, unknown>> = [];
  const repository = {
    async findIdentity(userId: string, tenantId: string) {
      assert.equal(userId, actor.userId);
      assert.equal(tenantId, actor.tenantId);
      return {
        status: "active",
        passwordHash,
        credentialRevision: 7,
        mustChangePassword: false,
        role: "admin",
        canDeleteData: false,
        deletionGrantVersion: 3,
      };
    },
    async issueGrant(input: Record<string, unknown>) {
      issued.push(input);
      return "synthetic-step-up-token";
    },
  };
  const service = new DeletionStepUpService(repository as unknown as DeletionStepUpRepository);
  const result = await service.request({
    actor,
    previewId: "33333333-3333-4333-8333-333333333333",
    currentPassword: password,
  });

  assert.equal(result.stepUpToken, "synthetic-step-up-token");
  assert.ok(Math.abs(Date.parse(result.expiresAt) - Date.now() - 5 * 60_000) < 2_000);
  assert.equal(issued.length, 1);
  assert.equal(issued[0].actor, actor);
  assert.equal(issued[0].previewId, "33333333-3333-4333-8333-333333333333");
  assert.equal(issued[0].expectedPasswordHash, passwordHash);
  assert.equal(issued[0].expectedCredentialRevision, 7);
  assert.equal("currentPassword" in issued[0], false);
});

test("DeletionStepUpService rejects wrong credentials and deletion access before writing a grant", async () => {
  const passwordHash = await hashPassword("Synthetic current password 2026!");
  let issued = 0;
  const repository = {
    async findIdentity() {
      return {
        status: "active",
        passwordHash,
        credentialRevision: 7,
        mustChangePassword: false,
        role: "manager",
        canDeleteData: false,
        deletionGrantVersion: 3,
      };
    },
    async issueGrant() {
      issued += 1;
      return "unexpected-token";
    },
  };
  const service = new DeletionStepUpService(repository as unknown as DeletionStepUpRepository);

  await assert.rejects(
    service.request({ actor, previewId: "33333333-3333-4333-8333-333333333333", currentPassword: "wrong" }),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(issued, 0);

  const permittedRepository = {
    ...repository,
    async findIdentity() {
      return { ...(await repository.findIdentity()), role: "admin" };
    },
  };
  const permittedService = new DeletionStepUpService(permittedRepository as unknown as DeletionStepUpRepository);
  await assert.rejects(
    permittedService.request({
      actor,
      previewId: "33333333-3333-4333-8333-333333333333",
      currentPassword: "wrong",
    }),
    (error: unknown) => error instanceof UnauthorizedException,
  );
  assert.equal(issued, 0);
});
