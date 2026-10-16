"use strict";

// A narrow acceptance input; preserve the Excel row number and original values.
// Customer values must never be printed or committed.
const fs = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { parseTransportWorkbook } = require("../apps/api/dist/features/imports/workbook.js");

async function main() {
  const rows = process.env.ACCEPTANCE_TWO_ROWS === "1" ? [18001, 18002] : [18001];
  const original = new ExcelJS.Workbook();
  await original.xlsx.readFile(path.resolve(__dirname, "../docs/BAZA TRANSPORTOWA.xlsx"));
  const source = original.getWorksheet("Realizacja");
  if (!source || !source.getRow(18001).hasValues) throw new Error("SOURCE_ROW_18001_MISSING");
  const output = new ExcelJS.Workbook();
  const sheet = output.addWorksheet("Realizacja");
  for (const number of [1, ...rows]) {
    if (!source.getRow(number).hasValues) throw new Error("SOURCE_ROW_MISSING");
    source.getRow(number).eachCell({ includeEmpty: false }, (cell, column) => {
      sheet.getRow(number).getCell(column).value = structuredClone(cell.value);
    });
  }
  const bytes = Buffer.from(await output.xlsx.writeBuffer());
  const parsed = await parseTransportWorkbook(bytes);
  if (parsed.length !== rows.length || parsed.some((row, index) => row.rowNumber !== rows[index])) throw new Error("ACCEPTANCE_ROW_NUMBER_CHANGED");
  const row = parsed[0];
  if (parsed.some(row => row.issues.length || !row.effectiveRegon || !row.decisionMakerName)) throw new Error("ACCEPTANCE_ROW_NOT_READY");
  const directory = path.resolve(__dirname, "../exports/live-acceptance");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, rows.length === 2 ? "input-18001-18002.xlsx" : "input-18001.xlsx"), bytes);
  console.log(JSON.stringify({ status: "ready", rowNumbers: rows, sourceRows: parsed.length,
    validationIssues: row.issues.length, hasRegon: true, hasExpectedPerson: true,
    hasAddress: Boolean(row.address), hasPostalCode: Boolean(row.postalCode), hasCity: Boolean(row.city) }));
}

main().catch((error) => {
  console.error(/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "ACCEPTANCE_INPUT_PREPARATION_FAILED");
  process.exitCode = 1;
});
