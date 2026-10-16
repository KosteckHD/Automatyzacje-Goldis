import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionPrincipal } from "../auth";
import type { ToolCatalogRepository } from "./tool-catalog.repository";
import { ToolsService } from "./tools.service";

const principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "99999999-9999-4999-8999-999999999999",
  role: "operator",
} as SessionPrincipal;

test("ToolsService joins visible catalog entries with access snapshots", async () => {
  const access = [
    {
      toolId: "oc-policy-verification",
      canDiscover: true,
      canExecute: false,
      canViewResults: true,
      canDownloadResults: true,
    },
  ];
  const repository = {
    listAccess: async (current: SessionPrincipal) => {
      assert.equal(current, principal);
      return access;
    },
    findCatalogRows: async (ids: readonly string[]) => {
      assert.deepEqual(ids, ["oc-policy-verification"]);
      return [
        {
          toolId: "oc-policy-verification",
          displayName: "OC",
          description: "Weryfikacja polis",
          status: "available",
        },
      ];
    },
  } as unknown as ToolCatalogRepository;
  const service = new ToolsService(repository);

  assert.deepEqual(await service.list(principal), {
    items: [
      {
        toolId: "oc-policy-verification",
        displayName: "OC",
        description: "Weryfikacja polis",
        status: "available",
        access: access[0],
      },
    ],
  });
});

test("ToolsService does not query the catalog when no tool is visible", async () => {
  const repository = {
    listAccess: async () => [],
    findCatalogRows: async () => assert.fail("catalog query must be skipped"),
  } as unknown as ToolCatalogRepository;
  const service = new ToolsService(repository);

  assert.deepEqual(await service.list(principal), { items: [] });
});
