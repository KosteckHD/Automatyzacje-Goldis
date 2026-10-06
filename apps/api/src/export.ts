import ExcelJS from "exceljs";
import { exportFileName, parsePolishDate, policyMatchesDate, type OcPolicy } from "@goldis/core";

export type ExportInput = {
  regon: string;
  companyName: string;
  decisionMakerName?: string | null;
  pesel: string;
  referenceDate: string;
  policies: OcPolicy[];
};

function literal(value: string | null): string {
  const text = value ?? "";
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export async function exportOcWorkbook(input: ExportInput): Promise<{ fileName: string; bytes: Buffer; policyCount: number } | null> {
  const selected = input.policies.filter((policy) => policyMatchesDate(policy, input.referenceDate));
  if (selected.length === 0) return null;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Goldis Ubezpieczenia";
  const sheet = workbook.addWorksheet("Polisy OC");
  sheet.columns = [
    { header: "REGON", key: "regon", width: 18 },
    { header: "Nazwa działalności", key: "company", width: 40 },
    { header: "PESEL", key: "pesel", width: 18 },
    { header: "L.p.", key: "ordinal", width: 8 },
    { header: "Ubezpieczony", key: "insured", width: 30 },
    { header: "Typ i nr polisy", key: "policy", width: 28 },
    { header: "Rodzaj umowy", key: "contract", width: 18 },
    { header: "Liczba szkód Ubezpieczonego", key: "claims", width: 20 },
    { header: "Nr rejestracyjny", key: "registration", width: 19 },
    { header: "Grupa pojazdu", key: "group", width: 20 },
    { header: "Marka", key: "make", width: 18 },
    { header: "Model", key: "model", width: 18 },
    { header: "ZU", key: "insurer", width: 20 },
    { header: "Okres ub. od", key: "from", width: 18 },
    { header: "Okres ub. do", key: "to", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const policy of selected) {
    const coverageFrom = policy.coverageFrom ? parsePolishDate(policy.coverageFrom) : null;
    if (policy.coverageFrom && !coverageFrom) throw new Error("COVERAGE_FROM_INVALID");
    const coverageTo = parsePolishDate(policy.coverageTo);
    if (!coverageTo) throw new Error("COVERAGE_TO_INVALID");
    const row = sheet.addRow({
      regon: literal(input.regon), company: literal(input.companyName), pesel: literal(input.pesel),
      ordinal: policy.sourceOrdinal, insured: literal(policy.insuredName), policy: literal(policy.policyTypeAndNumber),
      contract: literal(policy.contractType), claims: policy.insuredClaimCount,
      registration: literal(policy.vehicleRegistration), group: literal(policy.vehicleGroup),
      make: literal(policy.vehicleMake), model: literal(policy.vehicleModel), insurer: literal(policy.insurer),
      from: coverageFrom ?? "",
      to: coverageTo,
    });
    for (const key of ["regon", "company", "pesel", "insured", "policy", "contract", "registration", "group", "make", "model", "insurer"] as const) {
      row.getCell(key).numFmt = "@";
    }
    row.getCell("from").numFmt = "@";
    row.getCell("to").numFmt = "@";
  }
  sheet.autoFilter = { from: "A1", to: `O${sheet.rowCount}` };
  const bytes = await workbook.xlsx.writeBuffer();
  return { fileName: exportFileName(input.regon, input.companyName, input.decisionMakerName), bytes: Buffer.from(bytes), policyCount: selected.length };
}
