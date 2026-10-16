import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { NotificationsRepository } from "./notifications.repository";
import { NotificationService } from "./notifications.service";

function createService(overrides: Record<string, (...args: never[]) => unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const repository = {
    hasActiveMembership: async (...args: never[]) => {
      calls.push({ name: "hasActiveMembership", args });
      return true;
    },
    list: async (...args: never[]) => {
      calls.push({ name: "list", args });
      return {
        unreadCount: 3,
        items: [
          {
            id: "n1",
            eventType: "result_ready",
            title: "gotowy",
            message: "treść",
            href: "/results",
            resultSetId: "r1",
            createdAt: "2026-10-16T10:00:00.000Z",
            readAt: null,
          },
        ],
      };
    },
    markRead: async (...args: never[]) => {
      calls.push({ name: "markRead", args });
      return { id: "aab17d94-386e-4f7b-9721-e92f55c4b37d", readAt: "2026-10-16T10:01:00.000Z" };
    },
    recordResultSetEvent: async (...args: never[]) => calls.push({ name: "recordResultSetEvent", args }),
    ...overrides,
  } as unknown as NotificationsRepository;
  return { service: new NotificationService(repository), calls };
}

test("NotificationService validates active membership, filters and count before persistence reads", async () => {
  const { service, calls } = createService({
    hasActiveMembership: async () => false,
  });
  await assert.rejects(() => service.list({ tenantId: "t1", userId: "u1" }), ForbiddenException);
  assert.equal(
    calls.some((call) => call.name === "list"),
    false,
  );

  const invalid = createService();
  await assert.rejects(() => invalid.service.list({ tenantId: "t1", userId: "u1" }, "101"), BadRequestException);
  assert.equal(
    invalid.calls.some((call) => call.name === "list"),
    false,
  );
});

test("NotificationService returns the existing notification response shape", async () => {
  const { service, calls } = createService();
  const result = await service.list({ tenantId: "tenant-1", userId: "user-1" }, "10", "true");
  assert.deepEqual(result, {
    unreadCount: 3,
    items: [
      {
        id: "n1",
        eventType: "result_ready",
        title: "gotowy",
        message: "treść",
        href: "/results",
        resultSetId: "r1",
        createdAt: "2026-10-16T10:00:00.000Z",
        readAt: null,
      },
    ],
  });
  assert.deepEqual(calls.find((call) => call.name === "list")?.args[0], {
    tenantId: "tenant-1",
    userId: "user-1",
    limit: 10,
    unreadOnly: true,
  });
});

test("NotificationService binds event links to the result set type and hides missing notifications", async () => {
  const { service, calls } = createService({ markRead: async () => null });
  await service.recordResultSetEvent(
    {
      resultSetId: "set-1",
      tenantId: "tenant-1",
      actorUserId: "user-1",
      sourceType: "run_submission",
      sourceId: "submission/1",
      batchId: null,
    } as never,
    "action_required",
    {} as never,
  );
  const eventCall = calls.find((call) => call.name === "recordResultSetEvent");
  assert.ok(eventCall);
  assert.equal((eventCall.args[2] as { href: string }).href, "/submissions/submission%2F1");
  await assert.rejects(
    () => service.markRead({ tenantId: "tenant-1", userId: "user-1" }, "aab17d94-386e-4f7b-9721-e92f55c4b37d"),
    NotFoundException,
  );
});
