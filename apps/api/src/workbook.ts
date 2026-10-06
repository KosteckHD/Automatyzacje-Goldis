import ExcelJS from "exceljs";
import { deriveEffectiveRegon, normalizeRegon, type SourceRow } from "@goldis/core";

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "richText" in value) return value.richText.map((part) => part.text).join("").trim();
  if (typeof value === "object" && "text" in value) return String(value.text).trim();
  return "";
}

export async function parseTransportWorkbook(buffer: Buffer): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Realizacja");
  if (!sheet) throw new Error("SHEET_REALIZACJA_MISSING");
  const header = sheet.getRow(1);
  const columns = new Map<string, number>();
  header.eachCell((cell, col) => columns.set(cellText(cell.value).toLocaleLowerCase("pl-PL"), col));
  const nameCol = columns.get("nazwa");
  const regonCol = columns.get("regon");
  const decisionMakerCol = columns.get("osoba decyzyjna");
  const nipCol = columns.get("nip");
  const addressCol = columns.get("adres");
  const postalCodeCol = columns.get("kod pocztowy");
  const cityCol = columns.get("miasto");
  if (!nameCol || !regonCol) throw new Error("REQUIRED_COLUMNS_MISSING");

  const rows: SourceRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = cellText(row.getCell(nameCol).value);
    const decisionMakerName = decisionMakerCol ? cellText(row.getCell(decisionMakerCol).value) || null : null;
    const nipRaw = nipCol ? cellText(row.getCell(nipCol).value) : "";
    const address = addressCol ? cellText(row.getCell(addressCol).value) : "";
    const postalCode = postalCodeCol ? cellText(row.getCell(postalCodeCol).value) : "";
    const city = cityCol ? cellText(row.getCell(cityCol).value) : "";
    const regonCell = row.getCell(regonCol);
    const isFormula = regonCell.type === ExcelJS.ValueType.Formula;
    const normalized = isFormula
      ? { raw: "", normalized: null, issues: ["REGON_FORMULA_NOT_ALLOWED"] }
      : normalizeRegon(regonCell.value);
    const issues = [...normalized.issues];
    if (!name) issues.push("NAME_EMPTY");
    const regon = deriveEffectiveRegon({ regonRaw: normalized.raw, importedRegon: normalized.normalized });
    rows.push({ rowNumber, companyName: name, decisionMakerName, nipRaw, address, postalCode, city, regonRaw: regon.regonRaw, regon: normalized.normalized, effectiveRegon: regon.effectiveRegon, issues });
  });
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.effectiveRegon || !row.companyName) continue;
    const key = `${row.effectiveRegon}|${row.companyName.toLocaleLowerCase("pl-PL")}`;
    if (seen.has(key)) row.issues.push("DUPLICATE_SOURCE_ROW");
    else seen.add(key);
  }
  return rows;
}
