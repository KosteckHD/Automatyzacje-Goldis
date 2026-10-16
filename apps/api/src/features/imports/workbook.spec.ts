import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { assessRegonEnrichmentEligibility } from "@goldis/core";
import ExcelJS from "exceljs";
import { parseTransportWorkbook } from "./workbook";
import { validateWorkbookArchive, WorkbookArchiveError } from "./workbook-archive";

function zipEntry(name: string, content: Buffer, declaredSize = content.length): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const localRecord = Buffer.concat([local, nameBytes, compressed]);
  const centralRecord = Buffer.concat([central, nameBytes]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

function zipArchive(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const localRecord = Buffer.concat([local, nameBytes, compressed]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localRecords.push(localRecord);
    centralRecords.push(Buffer.concat([central, nameBytes]));
    localOffset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

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

test("import accepts NIP-only sheets and marks a valid NIP for REGON enrichment", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["  NAZWA  ", "NIP"]);
  sheet.addRow(["Firma tylko z NIP", "123-456-32-18"]);
  const rows = await parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].regon, null);
  assert.equal(rows[0].nipRaw, "123-456-32-18");
  assert.deepEqual(rows[0].issues, ["REGON_EMPTY"]);
  assert.deepEqual(
    assessRegonEnrichmentEligibility({
      regonRaw: rows[0].regonRaw,
      effectiveRegon: rows[0].effectiveRegon,
      nipRaw: rows[0].nipRaw,
    }),
    { eligible: true, nipNormalized: "1234563218" },
  );
});

test("import keeps Komórka and Telefon as separate text fields", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "REGON", "Osoba Decyzyjna", "Komórka", "Telefon", "Email"]);
  sheet.addRow(["Firma A", "012345678", "Jan Kowalski", "501123456", "221234567", "jan@example.test"]);
  const rows = await parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.deepEqual([rows[0].mobile, rows[0].phone, rows[0].email], ["501123456", "221234567", "jan@example.test"]);
});

test("ten sam REGON i nazwa z inną osobą nie są duplikatem", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "REGON", "Osoba Decyzyjna"]);
  sheet.addRow(["Firma A", "012345678", "Anna Nowak"]);
  sheet.addRow(["Firma A", "012345678", "Jan Kowalski"]);
  const rows = await parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(rows[0].issues.includes("DUPLICATE_SOURCE_ROW"), false);
  assert.equal(rows[1].issues.includes("DUPLICATE_SOURCE_ROW"), false);
});

test("NIP dedup removes only an exact business duplicate from the working set", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "NIP", "REGON"]);
  sheet.addRow(["Firma Testowa Sp. z o.o.", "1234563218", ""]);
  sheet.addRow(["  FIRMA TESTOWA sp. z o.o. ", "123-456-32-18", ""]);
  sheet.addRow(["Firma Testowa Sp. z o.o.", "1234563218", "001234567"]);
  sheet.addRow(["FIRMA TESTOWA sp. z o.o.", "1234563218", "001234567"]);
  const rows = await parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(rows[0].issues.includes("DUPLICATE_SOURCE_ROW"), false);
  assert.equal(rows[1].issues.includes("DUPLICATE_SOURCE_ROW"), true);
  assert.equal(rows[2].issues.includes("DUPLICATE_SOURCE_ROW"), false);
  assert.equal(rows[3].issues.includes("DUPLICATE_SOURCE_ROW"), true);
});

test("import rejects duplicate key headers instead of silently selecting the last column", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Realizacja");
  sheet.addRow(["Nazwa", "NIP", "nip", "REGON"]);
  sheet.addRow(["Firma A", "1234563218", "1234563218", "012345678"]);
  await assert.rejects(parseTransportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer())), /DUPLICATE_KEY_COLUMNS/);
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

test("XLSX preflight rejects invalid ZIP paths, over-expansion, and actual output above declared size", async () => {
  await assert.rejects(
    validateWorkbookArchive(Buffer.from("not-a-zip")),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "INVALID_WORKBOOK",
  );
  await assert.rejects(
    validateWorkbookArchive(zipEntry("../xl/sharedStrings.xml", Buffer.from("safe"))),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "INVALID_WORKBOOK",
  );
  await assert.rejects(
    validateWorkbookArchive(zipEntry("xl/data.bin", Buffer.from("A".repeat(300_000))), { maxExpansionRatio: 5 }),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "IMPORT_LIMITS_EXCEEDED",
  );
  await assert.rejects(
    validateWorkbookArchive(zipEntry("xl/data.bin", Buffer.from("bounded-output".repeat(32)), 4), {
      maxUncompressedBytes: 64,
      maxXmlBytes: 64,
      maxExpansionRatio: 100_000,
    }),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "IMPORT_LIMITS_EXCEEDED",
  );
});

test("XLSX preflight bounds merged-cell expansion before ExcelJS reads the workbook", async () => {
  const oversized = zipEntry(
    "xl/worksheets/sheet1.xml",
    Buffer.from('<worksheet><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>'),
  );
  await assert.rejects(
    validateWorkbookArchive(oversized),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "IMPORT_LIMITS_EXCEEDED",
  );

  const malformed = zipEntry(
    "xl/worksheets/sheet1.xml",
    Buffer.from('<worksheet><mergeCells><mergeCell ref="A1:ZZZZ99999999"/></mergeCells></worksheet>'),
  );
  await assert.rejects(
    validateWorkbookArchive(malformed),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "INVALID_WORKBOOK",
  );

  const bounded = zipEntry(
    "xl/worksheets/sheet1.xml",
    Buffer.from('<worksheet><mergeCells><mergeCell ref="A1:B2"/></mergeCells></worksheet>'),
  );
  await assert.doesNotReject(validateWorkbookArchive(bounded));
});

test("XLSX preflight blocks DTD, formula elements, and external relationships", async () => {
  const dtd = Buffer.from("<!DOCTYPE x [<!ENTITY external SYSTEM 'file:///private'>]><x>&external;</x>");
  const formula = Buffer.from(
    "<worksheet><sheetData><row><c r='A1'><f>1+1</f><v>2</v></c></row></sheetData></worksheet>",
  );
  const relationship = Buffer.from(
    "<Relationships><Relationship Id='r1' Target='https://attacker.invalid' TargetMode='External'/></Relationships>",
  );
  for (const [label, archive] of [
    ["DTD", zipEntry("xl/one.xml", dtd)],
    ["formula", zipEntry("xl/worksheets/sheet1.xml", formula)],
    ["external relationship", zipEntry("xl/_rels/workbook.xml.rels", relationship)],
  ] as const) {
    await assert.rejects(
      validateWorkbookArchive(archive),
      (error: unknown) => error instanceof WorkbookArchiveError && error.code === "INVALID_WORKBOOK",
      label,
    );
  }
});

test("XLSX preflight rejects ExcelJS column expansion and malformed column attributes", async () => {
  const archive = (xml: string) => zipEntry("xl/worksheets/sheet1.xml", Buffer.from(xml));
  for (const [xml, code] of [
    ['<worksheet><cols><col min="1" max="25000"/></cols></worksheet>', "INVALID_WORKBOOK"],
    ['<worksheet><cols><col min="1e0" max="2"/></cols></worksheet>', "INVALID_WORKBOOK"],
    ['<worksheet><cols><col min="" max="2"/></cols></worksheet>', "INVALID_WORKBOOK"],
    ['<worksheet><cols><col min="4" max="3"/></cols></worksheet>', "INVALID_WORKBOOK"],
    ['<worksheet><cols><col min="1" max="999999999999999999999"/></cols></worksheet>', "INVALID_WORKBOOK"],
  ] as const) {
    await assert.rejects(
      validateWorkbookArchive(archive(xml)),
      (error: unknown) => error instanceof WorkbookArchiveError && error.code === code,
    );
  }

  const repeatedDefinitions = Array.from({ length: 257 }, () => '<col min="1" max="1"/>').join("");
  await assert.rejects(
    validateWorkbookArchive(archive(`<worksheet><cols>${repeatedDefinitions}</cols></worksheet>`)),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "IMPORT_LIMITS_EXCEEDED",
  );

  const overlapping = '<worksheet><cols><col min="1" max="12000"/><col min="1" max="12000"/></cols></worksheet>';
  await assert.rejects(
    validateWorkbookArchive(archive(overlapping)),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "IMPORT_LIMITS_EXCEEDED",
  );
  await assert.doesNotReject(
    validateWorkbookArchive(
      archive('<worksheet><cols><col min="1" max="16384"/></cols><dimension ref="A1:XFD2"/></worksheet>'),
    ),
  );
});

test("XLSX preflight bounds worksheet paths, dimensions, rows, and cell coordinates", async () => {
  const sheet = (name: string, xml: string) => ({ name, content: Buffer.from(xml) });
  const fourSheets = zipArchive(
    Array.from({ length: 4 }, (_, index) =>
      sheet(`xl/worksheets/custom-${index}.xml`, '<worksheet><cols><col min="1" max="16384"/></cols></worksheet>'),
    ),
  );
  await assert.rejects(
    validateWorkbookArchive(fourSheets),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "IMPORT_LIMITS_EXCEEDED",
  );

  const tooFar = zipEntry(
    "xl/worksheets/custom-sheet.xml",
    Buffer.from(
      '<worksheet><dimension ref="A1:B40001"/><sheetData><row r="40001"><c r="A40001"><v>1</v></c></row></sheetData></worksheet>',
    ),
  );
  await assert.rejects(
    validateWorkbookArchive(tooFar),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "IMPORT_LIMITS_EXCEEDED",
  );

  const mismatch = zipEntry(
    "xl/worksheets/sheet1.xml",
    Buffer.from('<worksheet><sheetData><row r="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>'),
  );
  await assert.rejects(
    validateWorkbookArchive(mismatch),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "INVALID_WORKBOOK",
  );

  const illegalPath = zipEntry("xl/worksheets/nested/sheet1.xml", Buffer.from("<worksheet/>"));
  await assert.rejects(
    validateWorkbookArchive(illegalPath),
    (error: unknown) => error instanceof WorkbookArchiveError && error.code === "INVALID_WORKBOOK",
  );
});
