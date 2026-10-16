import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { TeamRepository } from "./team.repository";
import { TeamService } from "./team.service";

test("TeamService rejects invalid search input before querying persistence", async () => {
  let calls = 0;
  const repository = {
    async listMembers() {
      calls += 1;
      return [];
    },
  } as unknown as TeamRepository;
  const service = new TeamService({ record: async () => undefined } as never, repository);

  await assert.rejects(service.list({ tenantId: "tenant" } as never, "bad\u0000query"), BadRequestException);
  assert.equal(calls, 0);
});

test("TeamService normalizes a valid search and formats repository rows", async () => {
  let query = "";
  const repository = {
    async listMembers(_tenantId: string, _toolId: string, value: string) {
      query = value;
      return [
        {
          userId: "user-1",
          username: "Operator",
          status: "active",
          membershipStatus: "active",
          createdAt: new Date("2026-01-02T03:04:05.000Z"),
          lastLoginAt: null,
          activeSessionCount: "2",
          leadCount: 3,
          canExecuteOc: 1,
          hasVerifiedRecoveryEmail: false,
        },
      ];
    },
  } as unknown as TeamRepository;
  const service = new TeamService({ record: async () => undefined } as never, repository);

  const result = await service.list({ tenantId: "tenant" } as never, "  OpErAtOr  ");

  assert.equal(query, "operator");
  assert.deepEqual(result.items[0], {
    userId: "user-1",
    username: "Operator",
    status: "active",
    membershipStatus: "active",
    createdAt: "2026-01-02T03:04:05.000Z",
    lastLoginAt: null,
    activeSessionCount: 2,
    leadCount: 3,
    canExecuteOc: true,
    hasVerifiedRecoveryEmail: false,
  });
});
