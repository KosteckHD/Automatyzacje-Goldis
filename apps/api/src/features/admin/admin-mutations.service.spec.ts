import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import type { AdminMutationsRepository } from "./admin-mutations.repository";
import { AdminMutationsService } from "./admin-mutations.service";

test("AdminMutationsService rejects stale administrator sessions", async () => {
  const repository = {
    async lockTenantAdminChanges() {
      return { user: { status: "active", credentialRevision: 2 }, member: {}, session: null };
    },
  } as unknown as AdminMutationsRepository;
  const service = new AdminMutationsService(repository);

  await assert.rejects(
    service.lockTenantAdminChanges({ userId: "admin", tenantId: "tenant" } as never, {} as never),
    ForbiddenException,
  );
});

test("AdminMutationsService only unassigns entries rejected by the domain policy", async () => {
  const changed: string[] = [];
  const repository = {
    async findOpenAssignedInterventions() {
      return [
        {
          interventionId: "eligible",
          kind: "sms",
          role: "operator",
          toolStatus: "enabled",
          canViewResults: true,
          canExecute: true,
        },
        {
          interventionId: "disabled",
          kind: "sms",
          role: "admin",
          toolStatus: "disabled",
          canViewResults: true,
          canExecute: true,
        },
      ];
    },
    async unassignOpenIntervention(id: string) {
      changed.push(id);
      return true;
    },
  } as unknown as AdminMutationsRepository;
  const service = new AdminMutationsService(repository);

  const count = await service.unassignIneligibleInterventions({
    tenantId: "tenant",
    userId: "user",
    actorUserId: "admin",
    transaction: {} as never,
  });

  assert.equal(count, 1);
  assert.deepEqual(changed, ["disabled"]);
});

test("AdminMutationsService reports an exhausted deletion grant version", async () => {
  const repository = {
    async clearDeletionGrantForMembership() {
      return false;
    },
  } as unknown as AdminMutationsRepository;
  const service = new AdminMutationsService(repository);

  await assert.rejects(
    service.clearDeletionGrantForMembership("tenant", "user", {} as never),
    ServiceUnavailableException,
  );
});
