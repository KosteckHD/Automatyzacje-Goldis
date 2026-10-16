import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { buildPreparationWorkbook, type PreparationExportInput } from "./preparation-export";

const baseInput = (): PreparationExportInput => ({
  fileName: "Import testowy.xlsx",
  revision: 3,
  rulesVersion: "preparation-v1",
  sourceFingerprint: "a".repeat(64),
  sealedAt: "2026-10-08T12:00:00.000Z",
  counts: { ready: 1, review: 1, skippedNoIdentifiers: 0, duplicates: 1, waitingRegistry: 0 },
  rows: [
    {
      rowNumber: 2,
      expectedRowVersion: 1,
      status: "ready",
      reasonCode: null,
      representativeRowNumber: null,
      normalizedNip: "0012345678",
      effectiveRegon: "012345678",
      regonProvenance: "import",
      sourceSnapshot: {
        companyName: '=HYPERLINK("https://example.invalid","kliknij")',
        decisionMakerName: "Jan Kowalski",
        mobile: "501123456",
        phone: "221234567",
        email: "jan@example.test",
        nipRaw: "0012345678",
        address: "Testowa 1",
        postalCode: "00-001",
        city: "Łódź 90010100016",
        regonRaw: "012345678",
        issues: [],
      },
    },
    {
      rowNumber: 3,
      expectedRowVersion: 1,
      status: "duplicate",
      reasonCode: "DUPLICATE_SOURCE_ROW",
      representativeRowNumber: 2,
      normalizedNip: "0012345678",
      effectiveRegon: "012345678",
      regonProvenance: "import",
      sourceSnapshot: {
        companyName: "Firma powtórzona",
        decisionMakerName: "Jan Kowalski",
        nipRaw: "0012345678",
        address: "Testowa 1",
        postalCode: "00-001",
        city: "Łódź",
        regonRaw: "012345678",
        issues: ["DUPLICATE_SOURCE_ROW"],
      },
    },
    {
      rowNumber: 4,
      expectedRowVersion: 2,
      status: "review",
      reasonCode: "IDENTITY_CONFLICT",
      representativeRowNumber: null,
      normalizedNip: "0012345678",
      effectiveRegon: null,
      regonProvenance: "none",
      sourceSnapshot: {
        companyName: "Firma do sprawdzenia",
        decisionMakerName: null,
        nipRaw: "0012345678",
        address: "",
        postalCode: "",
        city: "Warszawa",
        regonRaw: "",
        issues: ["REGON_EMPTY"],
      },
    },
  ],
});

test("eksport przygotowania oddziela zestaw roboczy od pełnej mapy decyzji i zachowuje reprezentanta", async () => {
  const result = await buildPreparationWorkbook(baseInput());
  assert.equal(result.fileName, "Import testowy_oczyszczony_r3.xlsx");
  assert.equal(result.rowCount, 3);
  assert.equal(result.includedCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.bytes as unknown as ExcelJS.Buffer);
  const workingSet = workbook.getWorksheet("Zestaw roboczy");
  const decisionMap = workbook.getWorksheet("Mapa i uwagi");
  const summary = workbook.getWorksheet("Informacje");
  assert.ok(workingSet);
  assert.ok(decisionMap);
  assert.ok(summary);
  assert.equal(workingSet.rowCount, 2, "tylko wiersze ready trafiają do zestawu do pracy");
  assert.equal(workingSet.getRow(2).getCell(1).value, 2);
  assert.equal(workingSet.getRow(2).getCell(3).value, '\'=HYPERLINK("https://example.invalid","kliknij")');
  assert.equal(workingSet.getRow(2).getCell(5).value, "501123456");
  assert.equal(workingSet.getRow(2).getCell(6).value, "221234567");
  assert.equal(workingSet.getRow(2).getCell(7).value, "jan@example.test");
  assert.equal(
    workingSet.getRow(2).getCell(8).value,
    "0012345678",
    "identyfikatory pozostają tekstem z zerami wiodącymi",
  );
  assert.equal(workingSet.getRow(2).getCell(13).value, "Łódź [ukryto]", "PESEL-podobne ciągi są maskowane");
  assert.equal(decisionMap.rowCount, 4, "mapa zawiera wszystkie wiersze źródłowe");
  assert.equal(decisionMap.getRow(3).getCell(4).value, "Powtórzona tożsamość; użyj wskazanego wiersza reprezentanta.");
  assert.equal(decisionMap.getRow(3).getCell(5).value, "DUPLICATE_SOURCE_ROW");
  assert.equal(decisionMap.getRow(3).getCell(6).value, 2, "duplikat wskazuje wiersz reprezentanta");
  assert.equal(decisionMap.getRow(3).getCell(7).value, "Nie");
  assert.equal(decisionMap.getRow(4).getCell(4).value, "Identyfikatory wskazują sprzeczne dane firmy.");
  assert.equal(summary.getCell("B3").value, 3);
  assert.equal(workingSet.autoFilter, "A1:M2");
  assert.equal(decisionMap.autoFilter, "A1:U4");
});

test("eksport przygotowania odrzuca niedomkniętą rewizję, niezgodne liczniki, status i niejednoznaczne mapowanie", async () => {
  const pending = baseInput();
  await assert.rejects(
    buildPreparationWorkbook({ ...pending, rows: [{ ...pending.rows[0], status: "pending" as never }] }),
    /PREPARATION_EXPORT_INPUT_INVALID/,
  );
  await assert.rejects(
    buildPreparationWorkbook({ ...pending, counts: { ...pending.counts, ready: 2 } }),
    /PREPARATION_EXPORT_COUNTS_MISMATCH/,
  );
  await assert.rejects(
    buildPreparationWorkbook({
      ...pending,
      rows: [pending.rows[0], { ...pending.rows[1], rowNumber: 2 }, pending.rows[2]],
    }),
    /PREPARATION_EXPORT_DUPLICATE_ROW/,
  );
  await assert.rejects(
    buildPreparationWorkbook({
      ...pending,
      rows: pending.rows.map((row, index) => (index === 0 ? { ...row, sourceSnapshot: { companyName: 12 } } : row)),
    }),
    /PREPARATION_EXPORT_SOURCE_INVALID/,
  );
});
