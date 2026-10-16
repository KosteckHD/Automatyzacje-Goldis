import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { AuditService } from "../audit/public";
import type { SessionPrincipal } from "../auth";
import type { AdminMutationsService } from "./admin-mutations.service";
import { parseAdminCreateUserInput } from "./admin-users.dto";
import type { AdminUserListRow, AdminUsersRepository } from "./admin-users.repository";
import { AdminUsersService } from "./admin-users.service";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  role: "admin",
} as SessionPrincipal;

function makeService(repository: AdminUsersRepository): AdminUsersService {
  return new AdminUsersService(repository, {} as AdminMutationsService, {} as AuditService);
}

test("AdminUsersService scopes pages to the active tenant and signs the next page cursor to its filter", async () => {
  const first: AdminUserListRow = {
    userId: "22222222-2222-4222-8222-222222222222",
    username: "synthetic.user",
    status: "active",
    role: "operator",
    lastLoginAt: null,
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
    activeSessionCount: 1,
    hasVerifiedRecoveryEmail: true,
  };
  const second = { ...first, userId: "33333333-3333-4333-8333-333333333333" };
  const repository = {
    listPage: async (input: { tenantId: string; query: string; before: unknown; fetchLimit: number }) => {
      assert.equal(input.tenantId, actor.tenantId);
      assert.equal(input.query, "synthetic");
      assert.equal(input.before, null);
      assert.equal(input.fetchLimit, 2);
      return [first, second];
    },
  } as unknown as AdminUsersRepository;
  const service = makeService(repository);

  const page = await service.list(actor, { limit: 1, query: " Synthetic " });
  assert.deepEqual(page.items, [first]);
  assert.ok(page.nextCursor);
  const cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(cursor.userId, first.userId);
  assert.equal(cursor.createdAt, first.createdAt.toISOString());
  assert.equal(typeof cursor.filterHash, "string");
});

test("AdminUsersService rejects malformed cursors and control characters before repository access", async () => {
  let calls = 0;
  const service = makeService({
    listPage: async () => {
      calls += 1;
      return [];
    },
  } as unknown as AdminUsersRepository);

  await assert.rejects(service.list(actor, { limit: 10, query: "ok\ninvalid" }), BadRequestException);
  await assert.rejects(service.list(actor, { limit: 10, cursor: "not-a-cursor" }), BadRequestException);
  assert.equal(calls, 0);
});

test("AdminUsersService returns tenant-scoped grants with safe defaults", async () => {
  const calls: Array<[string, string]> = [];
  const service = makeService({
    findGrantMeta: async (tenantId: string, userId: string) => {
      calls.push([tenantId, userId]);
      return { role: "operator", canDeleteData: false, deletionGrantVersion: 3 };
    },
    listToolGrants: async (tenantId: string, userId: string) => {
      calls.push([tenantId, userId]);
      return [
        {
          toolId: "oc",
          displayName: "OC",
          status: "active",
          canDiscover: null,
          canExecute: null,
          canViewResults: true,
          canDownloadResults: null,
          version: null,
        },
      ];
    },
  } as unknown as AdminUsersRepository);

  const result = await service.grants(actor, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(calls, [
    [actor.tenantId, "22222222-2222-4222-8222-222222222222"],
    [actor.tenantId, "22222222-2222-4222-8222-222222222222"],
  ]);
  assert.deepEqual(result.items, [
    {
      toolId: "oc",
      displayName: "OC",
      status: "active",
      canDiscover: false,
      canExecute: false,
      canViewResults: true,
      canDownloadResults: false,
      version: 0,
    },
  ]);
  assert.equal(result.role, "operator");
  assert.equal(result.deletionGrantVersion, 3);
});

test("AdminUsersService returns tenant-scoped sessions and marks only the active session", async () => {
  const calls: unknown[][] = [];
  const session = {
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
    lastSeenAt: null,
    expiresAt: new Date("2026-01-01T11:00:00.000Z"),
    revokedAt: null,
    browserLabel: null,
  };
  const service = makeService({
    userExistsInTenant: async (...args: unknown[]) => {
      calls.push(args);
      return true;
    },
    listSessions: async (...args: unknown[]) => {
      calls.push(args);
      return [session, { ...session, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }];
    },
  } as unknown as AdminUsersRepository);

  const result = await service.sessions(
    { ...actor, sessionId: session.sessionId },
    "22222222-2222-4222-8222-222222222222",
  );
  assert.deepEqual(calls, [
    [actor.tenantId, "22222222-2222-4222-8222-222222222222"],
    [actor.tenantId, "22222222-2222-4222-8222-222222222222"],
  ]);
  assert.deepEqual(
    result.items.map((item) => item.isCurrent),
    [true, false],
  );
});

test("AdminUsersService returns not found when a target user is outside the active tenant", async () => {
  let sessionRead = false;
  const service = makeService({
    userExistsInTenant: async () => false,
    listSessions: async () => {
      sessionRead = true;
      return [];
    },
  } as unknown as AdminUsersRepository);

  await assert.rejects(service.sessions(actor, "22222222-2222-4222-8222-222222222222"), NotFoundException);
  assert.equal(sessionRead, false);
});

test("AdminUsersService rejects invalid create-user credentials before persistence", async () => {
  const service = makeService({
    createUser: async () => {
      throw new Error("PERSISTENCE_SHOULD_NOT_RUN");
    },
  } as unknown as AdminUsersRepository);

  await assert.rejects(
    service.createUser(
      actor,
      parseAdminCreateUserInput({
        username: "invalid\nusername",
        password: "strong-password-for-test-only",
        role: "operator",
      }),
    ),
    BadRequestException,
  );
});
