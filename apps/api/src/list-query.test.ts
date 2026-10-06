import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { createListCursor, filterFingerprint, parseIsoDateTime, parseListCursor, parseListLimit, parseToolId, parseUuidFilter, validateDateRange } from "./list-query";

const id = "11111111-1111-4111-8111-111111111111";

test("historia waliduje limit, UUID, identyfikator narzędzia i jawny czas ISO", () => {
  assert.equal(parseListLimit(undefined), 50);
  assert.equal(parseListLimit("100"), 100);
  assert.throws(() => parseListLimit("101"), BadRequestException);
  assert.equal(parseUuidFilter(id.toUpperCase(), "batchId"), id);
  assert.throws(() => parseUuidFilter("not-a-uuid", "batchId"), BadRequestException);
  assert.equal(parseToolId("oc-policy-verification"), "oc-policy-verification");
  assert.throws(() => parseToolId("../../private"), BadRequestException);
  assert.equal(parseIsoDateTime("2026-10-05T12:00:00+02:00", "from"), "2026-10-05T10:00:00.000Z");
  assert.throws(() => parseIsoDateTime("2026-10-05", "from"), BadRequestException);
  assert.throws(() => parseIsoDateTime("2026-02-31T12:00:00Z", "from"), BadRequestException);
  assert.throws(() => parseIsoDateTime("2026-10-05T12:00:00+15:00", "from"), BadRequestException);
  assert.throws(() => validateDateRange("2026-10-06T00:00:00Z", "2026-10-05T00:00:00Z"), BadRequestException);
});

test("kursor listy wiąże kolejność z fingerprintem filtrów i odrzuca zmieniony payload", () => {
  const first = filterFingerprint("runs", { toolId: "oc-policy-verification", status: "completed", limit: 50 });
  const sameFilters = filterFingerprint("runs", { status: "completed", limit: 50, toolId: "oc-policy-verification" });
  const differentFilters = filterFingerprint("runs", { toolId: "oc-policy-verification", status: "failed", limit: 50 });
  assert.equal(first, sameFilters);
  assert.notEqual(first, differentFilters);
  const cursor = createListCursor("2026-10-05T12:00:00.000Z", id, first);
  assert.deepEqual(parseListCursor(cursor, first), { createdAt: "2026-10-05T12:00:00.000Z", id });
  assert.throws(() => parseListCursor(cursor, differentFilters), BadRequestException);
  assert.throws(() => parseListCursor(Buffer.from(JSON.stringify({ v: 1, t: "2026-10-05T12:00:00Z", i: id, f: first, extra: true })).toString("base64url"), first), BadRequestException);
});
