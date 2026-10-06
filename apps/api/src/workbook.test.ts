import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseTransportWorkbook } from "./workbook";

test("import maps headers and flags uncertain REGON without guessing", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["REGON", "Nazwa", "Osoba Decyzyjna"]);
  sheet.addRow(["012345678", "Firma A", "Jan Kowalski"]);
  sheet.addRow([12345678, "Firma B", "Anna Nowak"]);
  sheet.addRow(["  ", "Firma C", "Piotr Zieliński"]);
  sheet.addRow(["012345678", "Firma A", "Jan Kowalski"]);
  const bytes = await workbook.xlsx.writeBuffer();
  const rows = await parseTransportWorkbook(Buffer.from(bytes));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].regon, "012345678");
  assert.equal(rows[0].effectiveRegon, "012345678");
  assert.equal(rows[0].regonRaw, "012345678");
  assert.equal(rows[0].companyName, "Firma A");
  assert.equal(rows[0].decisionMakerName, "Jan Kowalski");
  assert.equal(rows[1].regon, null);
  assert.equal(rows[1].effectiveRegon, null);
  assert.deepEqual(rows[1].issues, ["REGON_POSSIBLE_LOST_LEADING_ZERO"]);
  assert.deepEqual(rows[2].issues, ["REGON_EMPTY"]);
  assert.deepEqual(rows[3].issues, ["DUPLICATE_SOURCE_ROW"]);
});

test("brak osoby decyzyjnej nie blokuje wiersza", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Osoba Decyzyjna", "Nazwa", "REGON"]);
  sheet.addRow(["", "Firma A", "012345678"]);
  const rows = await parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(rows[0].decisionMakerName, null);
  assert.deepEqual(rows[0].issues, []);
});

test("import zachowuje NIP i pola adresowe jako tekst bez zmiany zer wiodących", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "NIP", "REGON", "Adres", "Kod Pocztowy", "Miasto"]);
  sheet.addRow(["Firma A", "0123456789", "012345678", "ul. Przykładowa 1", "00-001", "Warszawa"]);
  const rows = await parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(rows[0].nipRaw, "0123456789");
  assert.equal(rows[0].address, "ul. Przykładowa 1");
  assert.equal(rows[0].postalCode, "00-001");
  assert.equal(rows[0].city, "Warszawa");
});

test("brak kolumny osoby decyzyjnej nie blokuje importu", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "REGON"]);
  sheet.addRow(["Firma A", "012345678"]);
  const rows = await parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(rows[0].decisionMakerName, null);
  assert.deepEqual(rows[0].issues, []);
});

test("missing required header fails before any row is imported", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Realizacja").addRow(["Nazwa"]);
  const bytes = await workbook.xlsx.writeBuffer();
  await assert.rejects(parseTransportWorkbook(Buffer.from(bytes)), /REQUIRED_COLUMNS_MISSING/);
});
