import { exportFileName, type OcPolicy, parsePolishDate, policyMatchesDate } from "@goldis/core";
import ExcelJS from "exceljs";

export type ExportInput = {
  regon: string;
  companyName: string;
  decisionMakerName: string | null;
  mobile: string;
  phone: string;
  email: string;
  pesel: string;
  referenceDate: string;
  policies: OcPolicy[];
};

function literal(value: string | null | undefined): string {
  const text = value ?? "";
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function setText(cell: ExcelJS.Cell, value: string | null | undefined) {
  cell.value = literal(value);
  cell.numFmt = "@";
}

export async function exportOcWorkbook(
  input: ExportInput,
): Promise<{ fileName: string; bytes: Buffer; policyCount: number } | null> {
  const selected = input.policies.filter((policy) => policyMatchesDate(policy, input.referenceDate));
  if (selected.length === 0) return null;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Goldis Ubezpieczenia";
  const sheet = workbook.addWorksheet("Wynik OC");
  sheet.columns = [
    { width: 36 },
    { width: 18 },
    { width: 28 },
    { width: 20 },
    { width: 20 },
    { width: 34 },
    { width: 18 },
    { width: 8 },
    { width: 30 },
    { width: 28 },
    { width: 18 },
    { width: 22 },
    { width: 19 },
    { width: 20 },
    { width: 18 },
    { width: 18 },
    { width: 20 },
    { width: 18 },
    { width: 18 },
  ];
  const companyHeaders = ["Nazwa", "REGON", "Osoba Decyzyjna", "Komórka", "Telefon", "Email", "PESEL"];
  const companyValues = [
    input.companyName,
    input.regon,
    input.decisionMakerName,
    input.mobile,
    input.phone,
    input.email,
    input.pesel,
  ];
  sheet.addRow(companyHeaders);
  const companyRow = sheet.addRow(companyValues.map(literal));
  for (let column = 1; column <= companyValues.length; column += 1) {
    companyRow.getCell(column).numFmt = "@";
  }
  sheet.getRow(1).font = { bold: true };
  sheet.addRow([]);
  sheet.getCell("A4").value = "Znalezione pojazdy i polisy OC";
  sheet.getCell("A4").font = { bold: true, size: 12 };
  const vehicleHeaders = [
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
  ];
  sheet.addRow(vehicleHeaders);
  sheet.getRow(5).font = { bold: true };
  for (const [index, policy] of selected.entries()) {
    const coverageFrom = policy.coverageFrom ? parsePolishDate(policy.coverageFrom) : null;
    if (policy.coverageFrom && !coverageFrom) throw new Error("COVERAGE_FROM_INVALID");
    const coverageTo = parsePolishDate(policy.coverageTo);
    if (!coverageTo) throw new Error("COVERAGE_TO_INVALID");
    const row = sheet.addRow([
      index + 1,
      literal(policy.insuredName),
      literal(policy.policyTypeAndNumber),
      literal(policy.contractType),
      policy.insuredClaimCount,
      literal(policy.vehicleRegistration),
      literal(policy.vehicleGroup),
      literal(policy.vehicleMake),
      literal(policy.vehicleModel),
      literal(policy.insurer),
      coverageFrom ?? "",
      coverageTo,
    ]);
    for (const column of [2, 3, 4, 6, 7, 8, 9, 10, 11, 12])
      setText(row.getCell(column), String(row.getCell(column).value ?? ""));
  }
  sheet.views = [{ state: "frozen", ySplit: 5 }];
  sheet.autoFilter = { from: "A5", to: `L${sheet.rowCount}` };
  const bytes = await workbook.xlsx.writeBuffer();
  return {
    fileName: exportFileName(input.regon, input.companyName),
    bytes: Buffer.from(bytes),
    policyCount: selected.length,
  };
}
