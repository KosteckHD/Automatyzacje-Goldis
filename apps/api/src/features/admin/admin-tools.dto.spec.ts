import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { parseAdminToolSettingsUpdate } from "./admin-tools.dto";

const validInput = {
  enabledForNewRuns: true,
  maxNewRunsPerHour: 12,
  allowedLocalStart: "08:30",
  allowedLocalEnd: "17:00",
  timezone: "Europe/Warsaw",
  expectedVersion: 3,
};

test("admin settings DTO preserves supported values and accepts an empty schedule", () => {
  assert.deepEqual(parseAdminToolSettingsUpdate(validInput), validInput);
  assert.deepEqual(
    parseAdminToolSettingsUpdate({
      ...validInput,
      maxNewRunsPerHour: null,
      allowedLocalStart: null,
      allowedLocalEnd: null,
    }),
    { ...validInput, maxNewRunsPerHour: null, allowedLocalStart: null, allowedLocalEnd: null },
  );
});

test("admin settings DTO rejects unknown fields, invalid limits and partial or invalid time windows", () => {
  const invalidInputs = [
    { ...validInput, root: true },
    { ...validInput, maxNewRunsPerHour: 0 },
    { ...validInput, maxNewRunsPerHour: 10001 },
    { ...validInput, allowedLocalStart: null },
    { ...validInput, allowedLocalStart: "25:00" },
    { ...validInput, allowedLocalStart: "08:00", allowedLocalEnd: "08:00" },
    { ...validInput, timezone: "Not/A_Timezone" },
    { ...validInput, expectedVersion: 0 },
  ];
  for (const input of invalidInputs) {
    assert.throws(() => parseAdminToolSettingsUpdate(input), BadRequestException);
  }
});
