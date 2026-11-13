import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { encodeLeadCursor, leadScopePredicate, leadScopeReplacements, normalizeLeadQuery } from "./lead-query";

const leadId = "11111111-1111-4111-8111-111111111111";
const resultSetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("normalizes one shared lead scope and preserves the legacy cursor payload", () => {
  const createdAt = "2026-10-22T09:10:11.000Z";
  const cursor = encodeLeadCursor(createdAt, leadId);
  assert.deepEqual(
    normalizeLeadQuery({
      scope: "mine",
      contactStatus: "not_contacted",
      resultSetId,
      search: "  Firma  ",
      cursor,
      direction: "previous",
    }),
    {
      scope: "mine",
      contactStatus: "not_contacted",
      resultSetId,
      search: "Firma",
      limit: 25,
      cursor: { createdAt, leadId },
      direction: "previous",
      includeSummary: false,
    },
  );
});

test("rejects malformed or repeated known query parameters instead of widening the scope", () => {
  for (const input of [
    { scope: ["mine", "pool"] },
    { scope: "everything" },
    { contactStatus: "finished" },
    { resultSetId: "not-a-uuid" },
    { search: "x".repeat(121) },
    { cursor: "%%%" },
    { direction: "previous" },
    { includeSummary: "yes" },
  ]) {
    assert.throws(() => normalizeLeadQuery(input), BadRequestException);
  }
});

test("escapes SQL wildcard characters and shares the restrictive ACL predicate", () => {
  const normalized = normalizeLeadQuery({ scope: "mine", search: String.raw`A_%\B` });
  const replacements = leadScopeReplacements({ tenantId: "tenant", userId: "user" }, normalized);
  assert.equal(replacements.search, String.raw`%A\_\%\\B%`);

  const predicate = leadScopePredicate();
  assert.match(predicate, /lead\.tenant_id = :tenantId/);
  assert.match(predicate, /lead\.tool_id = :toolId/);
  assert.match(predicate, /resource_tombstones/);
  assert.match(predicate, /source_owner_user_id <> lead\.assigned_to_user_id/);
  assert.match(predicate, /lead\.assigned_to_user_id = :userId/);
  assert.match(predicate, /contactStatus/);
  assert.match(predicate, /resultSetId/);
  assert.match(predicate, /search/);
});
