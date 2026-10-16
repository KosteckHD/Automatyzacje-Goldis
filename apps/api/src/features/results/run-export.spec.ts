import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRunInputSnapshotForExport } from "./run-export-snapshot";

const sourceRowId = "22222222-2222-4222-8222-222222222222";
const snapshot = {
  schemaVersion: 1,
  sourceRowId,
  rowVersion: 4,
  companyName: "Firma ze snapshotu",
  decisionMakerName: "Jan Kowalski",
  effectiveRegon: "012345678",
  issues: [],
};
const snapshotV2 = {
  ...snapshot,
  schemaVersion: 2,
  mobile: "501123456",
  phone: "221234567",
  email: "jan@example.test",
};

test("eksport waliduje i zachowuje tożsamość z niezmiennego snapshotu wejściowego", () => {
  assert.deepEqual(validateRunInputSnapshotForExport(snapshot, sourceRowId), snapshot);
  assert.equal(validateRunInputSnapshotForExport(snapshot, sourceRowId).companyName, "Firma ze snapshotu");
  assert.deepEqual(validateRunInputSnapshotForExport(snapshotV2, sourceRowId), snapshotV2);
});

test("eksport blokuje brak snapshotu, obcy wiersz, błędny REGON i snapshot z nierozstrzygniętymi problemami", () => {
  for (const candidate of [
    null,
    { ...snapshot, sourceRowId: "33333333-3333-4333-8333-333333333333" },
    { ...snapshot, effectiveRegon: "nie-regon" },
    { ...snapshot, issues: ["REGON_INVALID"] },
    { ...snapshotV2, mobile: null },
  ]) {
    assert.throws(() => validateRunInputSnapshotForExport(candidate, sourceRowId), /RUN_INPUT_SNAPSHOT_INVALID/);
  }
});
