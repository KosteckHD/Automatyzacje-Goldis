import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { OcPolicy } from "@goldis/core";
import { exportOcWorkbook } from "./export";

const policy: OcPolicy = {
  sourceOrdinal: 17,
  insuredName: "Przykładowa Osoba",
  policyTypeAndNumber: "OC 001",
  contractType: "Nowa",
  insuredClaimCount: 0,
  vehicleRegistration: "RST22339",
  vehicleGroup: "Samochód",
  vehicleMake: "Marka",
  vehicleModel: "Model",
  insurer: "Przykładowy ZU",
  coverageFrom: "01.01.2026",
  coverageTo: "29.09.2026",
};

test("eksport zawiera dzień graniczny i zachowuje identyfikatory jako tekst", async () => {
  const result = await exportOcWorkbook({
    regon: "012345678", companyName: "Firma / Transport", decisionMakerName: "Jan Kowalski", pesel: "01234567890",
    referenceDate: "2026-09-29",
    policies: [{ ...policy, coverageTo: "28.09.2026" }, { ...policy, policyTypeAndNumber: "=1+1" }],
  });
  assert.ok(result);
  assert.equal(result.policyCount, 1);
  assert.equal(result.fileName, "012345678_Firma _ Transport_Jan Kowalski.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Polisy OC");
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getRow(2).getCell(1).value, "012345678");
  assert.equal(sheet.getRow(2).getCell(3).value, "01234567890");
  assert.equal(sheet.getRow(2).getCell(4).value, 17);
  assert.equal(sheet.getRow(2).getCell(6).value, "'=1+1");
  assert.equal(sheet.getRow(2).getCell(14).value, "2026-01-01");
  assert.equal(sheet.getRow(2).getCell(15).value, "2026-09-29");
  assert.equal(sheet.getRow(2).getCell(14).numFmt, "@");
  assert.equal(sheet.getRow(2).getCell(15).numFmt, "@");
});

test("brak aktualnych polis nie tworzy pliku, a zła data wymaga wyjaśnienia", async () => {
  const base = { regon: "012345678", companyName: "Firma", decisionMakerName: "Jan Kowalski", pesel: "01234567890", referenceDate: "2026-09-29" };
  assert.equal(await exportOcWorkbook({ ...base, policies: [{ ...policy, coverageTo: "28.09.2026" }] }), null);
  await assert.rejects(exportOcWorkbook({ ...base, policies: [{ ...policy, coverageTo: "brak" }] }), /COVERAGE_TO_INVALID/);
});

test("brak osoby decyzyjnej pomija ją w nazwie bez blokowania eksportu", async () => {
  const result = await exportOcWorkbook({
    regon: "012345678", companyName: "Firma", decisionMakerName: null,
    pesel: "01234567890", referenceDate: "2026-09-29", policies: [policy],
  });
  assert.ok(result);
  assert.equal(result.fileName, "012345678_Firma.xlsx");
  assert.equal(result.policyCount, 1);
});
