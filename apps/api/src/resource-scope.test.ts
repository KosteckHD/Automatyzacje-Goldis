import assert from "node:assert/strict";
import { test } from "node:test";
import { operationalCollectionScope } from "./resource-scope";

test("zakres kolekcji wymaga tenant, ownership i view_results według roli", () => {
  const admin = operationalCollectionScope("admin");
  const operator = operationalCollectionScope("operator");
  const reviewer = operationalCollectionScope("reviewer");
  const auditor = operationalCollectionScope("auditor");

  assert.match(admin, /b\.tenant_id = :tenantId/);
  assert.doesNotMatch(admin, /tool_grants|owner_user_id/);
  assert.match(operator, /b\.tenant_id = :tenantId/);
  assert.match(operator, /b\.owner_user_id = :userId/);
  assert.match(operator, /tg\.can_view_results = TRUE OR tg\.can_download_results = TRUE/);
  assert.match(reviewer, /b\.tenant_id = :tenantId/);
  assert.doesNotMatch(reviewer, /owner_user_id/);
  assert.match(reviewer, /tool_grants/);
  assert.equal(auditor, "FALSE");
  for (const predicate of [operator, reviewer]) assert.match(predicate, /t\.status <> 'disabled'/);
});
