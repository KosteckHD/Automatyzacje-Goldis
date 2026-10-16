import assert from "node:assert/strict";
import { test } from "node:test";
import type { OcPolicy } from "@goldis/core";
import ExcelJS from "exceljs";
import { type ExportInput, exportOcWorkbook } from "./export";

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

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    regon: "012345678",
    companyName: "Firma / Transport",
    decisionMakerName: "Jan Kowalski",
    mobile: "501123456",
    phone: "221234567",
    email: "jan@example.test",
    pesel: "01234567890",
    referenceDate: "2026-09-29",
    policies: [policy],
    ...overrides,
  };
}

async function readSheet(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Wynik OC");
  assert.ok(sheet);
  return sheet;
}

test("eksport zapisuje jeden wiersz firmy i osobne wiersze polis według ustalonego układu", async () => {
  const result = await exportOcWorkbook(
    input({
      policies: [
        { ...policy, sourceOrdinal: 17, coverageTo: "28.09.2026" },
        { ...policy, sourceOrdinal: 21, policyTypeAndNumber: "=1+1" },
      ],
    }),
  );
  assert.ok(result);
  assert.equal(result.policyCount, 1);
  assert.equal(result.fileName, "Firma _ Transport_012345678.xlsx");
  const sheet = await readSheet(result.bytes);
  assert.equal(sheet.getCell("A1").value, "Nazwa");
  assert.equal(sheet.getCell("G1").value, "PESEL");
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => sheet.getRow(2).getCell(index + 1).value),
    ["Firma / Transport", "012345678", "Jan Kowalski", "501123456", "221234567", "jan@example.test", "01234567890"],
  );
  assert.equal(sheet.getRow(2).getCell(2).numFmt, "@");
  assert.equal(sheet.getRow(2).getCell(7).numFmt, "@");
  assert.equal(sheet.getCell("A4").value, "Znalezione pojazdy i polisy OC");
  assert.deepEqual(
    Array.from({ length: 12 }, (_, index) => sheet.getRow(5).getCell(index + 1).value),
    [
      "L.p.",
      "Ubezpieczony",
      "Typ i nr polisy",
      "Rodzaj umowy",
      "Liczba szkód ubezpieczonego",
      "Nr rejestracyjny",
      "Grupa pojazdu",
      "Marka",
      "Model",
      "ZU",
      "Okres ub. od",
      "Okres ub. do",
    ],
  );
  assert.equal(sheet.rowCount, 6);
  assert.equal(sheet.getCell("A6").value, 1);
  assert.equal(sheet.getCell("C6").value, "'=1+1");
  assert.equal(sheet.getCell("F6").value, "RST22339");
  assert.equal(sheet.getCell("K6").value, "2026-01-01");
  assert.equal(sheet.getCell("L6").value, "2026-09-29");
  assert.equal(sheet.getCell("K6").numFmt, "@");
  assert.equal(sheet.getCell("L6").numFmt, "@");
});

test("brak polis nie tworzy pliku, a opcjonalna osoba kontaktowa może być pusta", async () => {
  assert.equal(await exportOcWorkbook(input({ policies: [{ ...policy, coverageTo: "28.09.2026" }] })), null);
  const withoutPerson = await exportOcWorkbook(input({ decisionMakerName: null }));
  assert.ok(withoutPerson);
  const sheet = await readSheet(withoutPerson.bytes);
  assert.equal(sheet.getCell("C2").value, "");
  await assert.rejects(
    exportOcWorkbook(input({ policies: [{ ...policy, coverageTo: "brak" }] })),
    /COVERAGE_TO_INVALID/,
  );
});

test("komórki tekstowe są zabezpieczone przed formułami także w danych firmy", async () => {
  const result = await exportOcWorkbook(
    input({
      companyName: "=1+1",
      decisionMakerName: "+Jan",
      mobile: "@SUM(A1:A2)",
      phone: "-123",
      email: '=HYPERLINK("x")',
      pesel: "@123",
      policies: [{ ...policy, insuredName: "=1", vehicleRegistration: "+1" }],
    }),
  );
  assert.ok(result);
  const sheet = await readSheet(result.bytes);
  assert.equal(sheet.getCell("A2").value, "'=1+1");
  assert.equal(sheet.getCell("C2").value, "'+Jan");
  assert.equal(sheet.getCell("D2").value, "'@SUM(A1:A2)");
  assert.equal(sheet.getCell("E2").value, "'-123");
  assert.equal(sheet.getCell("F2").value, '\'=HYPERLINK("x")');
  assert.equal(sheet.getCell("G2").value, "'@123");
  assert.equal(sheet.getCell("B6").value, "'=1");
  assert.equal(sheet.getCell("F6").value, "'+1");
});

test("długi snapshot polis eksportuje wszystkie dopasowane pozycje w kolejności źródłowej", async () => {
  const policies = Array.from({ length: 49 }, (_, index) => ({
    ...policy,
    sourceOrdinal: index + 1,
    policyTypeAndNumber: `OC SYNTH-${index + 1}`,
    vehicleRegistration: `OTHER${index + 1}`,
    coverageFrom: "2026-01-01",
    coverageTo: index < 46 ? "2026-10-08" : "2026-10-09",
  }));
  const result = await exportOcWorkbook(input({ companyName: "Firma testowa", referenceDate: "2026-10-09", policies }));
  assert.ok(result);
  assert.equal(result.policyCount, 3);
  const sheet = await readSheet(result.bytes);
  assert.equal(sheet.rowCount, 8);
  policies.slice(46).forEach((source, index) => {
    const row = sheet.getRow(index + 6);
    assert.deepEqual(
      Array.from({ length: 12 }, (_, column) => row.getCell(column + 1).value),
      [
        index + 1,
        source.insuredName,
        source.policyTypeAndNumber,
        source.contractType,
        source.insuredClaimCount,
        source.vehicleRegistration,
        source.vehicleGroup,
        source.vehicleMake,
        source.vehicleModel,
        source.insurer,
        source.coverageFrom,
        source.coverageTo,
      ],
    );
  });
});

test("filtr końcowej daty polisy zachowuje ustaloną regułę", async () => {
  const result = await exportOcWorkbook(
    input({
      referenceDate: "2026-10-09",
      policies: [
        { ...policy, sourceOrdinal: 1, coverageTo: "2026-10-08" },
        { ...policy, sourceOrdinal: 2, coverageTo: "2026-10-09" },
        { ...policy, sourceOrdinal: 3, coverageFrom: "2026-11-01", coverageTo: "2027-11-01" },
      ],
    }),
  );
  assert.ok(result);
  assert.equal(result.policyCount, 2);
  const sheet = await readSheet(result.bytes);
  assert.equal(sheet.getCell("A6").value, 1);
  assert.equal(sheet.getCell("A7").value, 2);
  assert.equal(sheet.getCell("L7").value, "2027-11-01");
});
