import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { parseRegonCorrectionRequest } from "./import.dto";

test("REGON correction DTO accepts only the supported transport fields", () => {
  assert.deepEqual(
    parseRegonCorrectionRequest({ proposedRegon: "123456785", reason: "verified source", expectedVersion: 2 }),
    { proposedRegon: "123456785", reason: "verified source", expectedVersion: 2 },
  );
  assert.throws(
    () =>
      parseRegonCorrectionRequest({
        proposedRegon: "123456785",
        reason: "verified source",
        expectedVersion: 2,
        tenantId: "other",
      }),
    (error) => error instanceof BadRequestException && error.message === "Nieprawidłowe dane korekty",
  );
});

test("REGON correction DTO rejects malformed bodies before invoking the use case", () => {
  for (const body of [null, [], "text", { proposedRegon: "123456785", reason: "x", expectedVersion: 0 }]) {
    assert.throws(() => parseRegonCorrectionRequest(body), BadRequestException);
  }
});
