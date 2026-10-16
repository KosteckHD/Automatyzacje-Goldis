import { deriveEffectiveRegon, normalizeNip, normalizeRegon, type SourceRow } from "@goldis/core";
import ExcelJS from "exceljs";
import { normalizeBusinessName } from "../../contracts/registry-result";
import { validateWorkbookArchive, withWorkbookParserCapacity } from "./workbook-archive";

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "richText" in value)
    return value.richText
      .map((part) => part.text)
      .join("")
      .trim();
  if (typeof value === "object" && "text" in value) return String(value.text).trim();
  return "";
}

function contactPhoneText(value: string): string {
  const text = value.trim().slice(0, 40);
  const digits = text.replace(/\D/g, "");
  const allowed = /^[+\d\s()./-]+$/.test(text);
  const polish = digits.length === 9 || (digits.length === 11 && digits.startsWith("48"));
  const international = text.startsWith("+") && digits.length >= 8 && digits.length <= 15;
  return allowed && (polish || international) ? text : "";
}

async function parseTransportWorkbookUnsafe(buffer: Buffer): Promise<SourceRow[]> {
  await validateWorkbookArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Realizacja");
  if (!sheet) throw new Error("SHEET_REALIZACJA_MISSING");
  const header = sheet.getRow(1);
  const columns = new Map<string, number[]>();
  header.eachCell((cell, col) => {
    const key = cellText(cell.value).normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pl-PL");
    if (!key) return;
    columns.set(key, [...(columns.get(key) ?? []), col]);
  });
  for (const key of ["nazwa", "nip", "regon"]) {
    if ((columns.get(key)?.length ?? 0) > 1) throw new Error("DUPLICATE_KEY_COLUMNS");
  }
  const mobileHeaders = ["komórka", "komorka"];
  const phoneHeaders = ["telefon", "nr telefonu", "numer telefonu"];
  const emailHeaders = ["email", "e-mail", "adres e-mail"];
  if (
    mobileHeaders.filter((name) => columns.has(name)).length > 1 ||
    phoneHeaders.filter((name) => columns.has(name)).length > 1 ||
    emailHeaders.filter((name) => columns.has(name)).length > 1
  )
    throw new Error("DUPLICATE_CONTACT_COLUMNS");
  const column = (name: string) => columns.get(name)?.[0];
  const nameCol = column("nazwa");
  const regonCol = column("regon");
  const decisionMakerCol = column("osoba decyzyjna");
  const mobileCol = column("komórka") ?? column("komorka");
  const phoneCol = column("telefon") ?? column("nr telefonu") ?? column("numer telefonu");
  const emailCol = column("email") ?? column("e-mail") ?? column("adres e-mail");
  const nipCol = column("nip");
  const addressCol = column("adres");
  const postalCodeCol = column("kod pocztowy");
  const cityCol = column("miasto");
  if (!nameCol || (!regonCol && !nipCol)) throw new Error("REQUIRED_COLUMNS_MISSING");

  const rows: SourceRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = cellText(row.getCell(nameCol).value);
    const decisionMakerName = decisionMakerCol ? cellText(row.getCell(decisionMakerCol).value) || null : null;
    const mobile = mobileCol ? contactPhoneText(cellText(row.getCell(mobileCol).value)) : "";
    const phone = phoneCol ? contactPhoneText(cellText(row.getCell(phoneCol).value)) : "";
    const email = emailCol ? cellText(row.getCell(emailCol).value) : "";
    const nipRaw = nipCol ? cellText(row.getCell(nipCol).value) : "";
    const address = addressCol ? cellText(row.getCell(addressCol).value) : "";
    const postalCode = postalCodeCol ? cellText(row.getCell(postalCodeCol).value) : "";
    const city = cityCol ? cellText(row.getCell(cityCol).value) : "";
    const regonCell = regonCol ? row.getCell(regonCol) : null;
    const isFormula = regonCell?.type === ExcelJS.ValueType.Formula;
    const normalized = !regonCell
      ? { raw: "", normalized: null, issues: ["REGON_EMPTY"] }
      : isFormula
        ? { raw: "", normalized: null, issues: ["REGON_FORMULA_NOT_ALLOWED"] }
        : normalizeRegon(regonCell.value);
    const issues = [...normalized.issues];
    if (!name) issues.push("NAME_EMPTY");
    const regon = deriveEffectiveRegon({ regonRaw: normalized.raw, importedRegon: normalized.normalized });
    rows.push({
      rowNumber,
      companyName: name,
      decisionMakerName,
      mobile,
      phone,
      email,
      nipRaw,
      address,
      postalCode,
      city,
      regonRaw: regon.regonRaw,
      regon: normalized.normalized,
      effectiveRegon: regon.effectiveRegon,
      issues,
    });
  });
  const seenByRegonAndName = new Set<string>();
  const seenByNipAndName = new Map<string, Set<string | null>>();
  for (const row of rows) {
    const name = normalizeBusinessName(row.companyName);
    if (!name) continue;
    const person = normalizeBusinessName(row.decisionMakerName ?? "");
    let duplicate = false;
    if (row.effectiveRegon) {
      const key = `${row.effectiveRegon}|${name}|${person}`;
      duplicate = seenByRegonAndName.has(key);
      seenByRegonAndName.add(key);
    }
    const nip = normalizeNip(row.nipRaw).normalized;
    if (!duplicate && nip) {
      const key = `${nip}|${name}|${person}`;
      const priorRegons = seenByNipAndName.get(key);
      if (priorRegons?.has(row.effectiveRegon)) duplicate = true;
      else {
        const regons = priorRegons ?? new Set<string | null>();
        regons.add(row.effectiveRegon);
        seenByNipAndName.set(key, regons);
      }
    }
    if (duplicate) row.issues.push("DUPLICATE_SOURCE_ROW");
  }
  return rows;
}

export async function parseTransportWorkbook(buffer: Buffer): Promise<SourceRow[]> {
  return withWorkbookParserCapacity(() => parseTransportWorkbookUnsafe(buffer));
}
