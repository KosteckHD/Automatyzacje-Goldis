import ExcelJS from "exceljs";
import { sanitizePublicFileName, sanitizePublicText } from "../../infrastructure/http";

export type PreparationExportStatus =
  | "ready"
  | "review"
  | "skipped_no_identifiers"
  | "duplicate"
  | "waiting_registry"
  | "excluded";
export type PreparationExportRow = Readonly<{
  rowNumber: number;
  expectedRowVersion: number;
  sourceSnapshot: unknown;
  status: PreparationExportStatus;
  reasonCode: string | null;
  representativeRowNumber: number | null;
  normalizedNip: string | null;
  effectiveRegon: string | null;
  regonProvenance: "none" | "import" | "approved_correction" | "registry";
}>;

export type PreparationExportInput = Readonly<{
  fileName: string;
  revision: number;
  rulesVersion: string;
  sourceFingerprint: string;
  sealedAt: Date | string;
  counts: Readonly<{
    ready: number;
    review: number;
    skippedNoIdentifiers: number;
    duplicates: number;
    waitingRegistry: number;
  }>;
  rows: readonly PreparationExportRow[];
}>;

type SourceSnapshot = Readonly<{
  companyName: string;
  decisionMakerName: string | null;
  mobile?: string;
  phone?: string;
  email?: string;
  nipRaw: string;
  address: string;
  postalCode: string;
  city: string;
  regonRaw: string;
  issues: readonly string[];
}>;

const statusLabels: Readonly<Record<PreparationExportStatus, string>> = {
  ready: "Gotowy — w zestawie roboczym",
  review: "Do kontroli — pominięty",
  skipped_no_identifiers: "Brak NIP i REGON — pominięty",
  duplicate: "Duplikat — pominięty",
  waiting_registry: "Oczekuje na REGON — pominięty",
  excluded: "Wyłączony — pominięty",
};

const reasonLabels: Readonly<Record<string, string>> = {
  NO_NIP_OR_REGON: "Brak NIP-u i REGON-u; rekord nie trafi do automatyzacji.",
  REGON_LOOKUP_REQUIRED: "Poprawny NIP; wymagane ustalenie REGON-u w rejestrze.",
  DUPLICATE_SOURCE_ROW: "Powtórzona tożsamość; użyj wskazanego wiersza reprezentanta.",
  IDENTITY_CONFLICT: "Identyfikatory wskazują sprzeczne dane firmy.",
  DECISION_MAKER_AMBIGUOUS: "Nie można jednoznacznie ustalić osoby kontaktowej.",
  CORRECTION_PENDING: "Korekta REGON oczekuje na zatwierdzenie.",
  GROUPING_CONFLICT: "Przypisanie firmy oczekuje na rozstrzygnięcie konfliktu.",
  REGON_CHECKSUM_INVALID: "REGON ma nieprawidłową sumę kontrolną.",
  NIP_CHECKSUM_INVALID: "NIP ma nieprawidłową sumę kontrolną.",
  NAME_EMPTY: "Brak nazwy firmy.",
  REGON_FORMULA_NOT_ALLOWED: "REGON pochodzi z formuły i wymaga ręcznej kontroli.",
  PERSON_REQUIRED:
    "Brak osoby decyzyjnej. Wiersz zostanie pominięty w automatyzacji; uzupełnij Excel i zaimportuj go ponownie.",
};

const provenanceLabels = {
  none: "Brak",
  import: "Import",
  approved_correction: "Zatwierdzona korekta",
  registry: "Rejestr",
} as const;

function parseSourceSnapshot(value: unknown): SourceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PREPARATION_EXPORT_SOURCE_INVALID");
  const snapshot = value as Record<string, unknown>;
  const stringFields = ["companyName", "nipRaw", "address", "postalCode", "city", "regonRaw"] as const;
  if (
    stringFields.some((field) => typeof snapshot[field] !== "string") ||
    !(snapshot.decisionMakerName === null || typeof snapshot.decisionMakerName === "string") ||
    !Array.isArray(snapshot.issues) ||
    snapshot.issues.some((issue) => typeof issue !== "string")
  ) {
    throw new Error("PREPARATION_EXPORT_SOURCE_INVALID");
  }
  return snapshot as unknown as SourceSnapshot;
}

function cellText(value: string | null | undefined): string {
  let safe = sanitizePublicText(value ?? "").slice(0, 32_767);
  if (/^[=+\-@]/.test(safe)) safe = `'${safe}`;
  return safe;
}

function configureSheet(
  sheet: ExcelJS.Worksheet,
  columns: readonly Readonly<{ header: string; key: string; width: number }>[],
) {
  sheet.columns = columns.map((column) => ({ ...column, style: { numFmt: "@" } }));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF183A36" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function addFullSheetFilter(sheet: ExcelJS.Worksheet) {
  let column = sheet.columnCount;
  let columnName = "";
  while (column > 0) {
    const digit = (column - 1) % 26;
    columnName = String.fromCharCode(65 + digit) + columnName;
    column = Math.floor((column - 1) / 26);
  }
  sheet.autoFilter = { from: "A1", to: `${columnName}${Math.max(1, sheet.rowCount)}` };
}

/** Creates a workbook from one sealed preparation revision, never from mutable source rows. */
export async function buildPreparationWorkbook(input: PreparationExportInput): Promise<{
  fileName: string;
  bytes: Buffer;
  rowCount: number;
  includedCount: number;
}> {
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !/^[0-9a-f]{64}$/.test(input.sourceFingerprint) ||
    !Number.isFinite(new Date(input.sealedAt).getTime()) ||
    input.rows.length < 1 ||
    input.rows.length > 10_000 ||
    input.rows.some(
      (row) =>
        !Number.isSafeInteger(row.rowNumber) ||
        row.rowNumber < 2 ||
        !Number.isSafeInteger(row.expectedRowVersion) ||
        row.expectedRowVersion < 1 ||
        !Object.hasOwn(statusLabels, row.status) ||
        (row.status === "duplicate"
          ? typeof row.representativeRowNumber !== "number" ||
            !Number.isSafeInteger(row.representativeRowNumber) ||
            row.representativeRowNumber < 2
          : row.representativeRowNumber !== null) ||
        (row.normalizedNip !== null && !/^\d{10}$/.test(row.normalizedNip)) ||
        (row.effectiveRegon !== null && !/^\d{9}(?:\d{5})?$/.test(row.effectiveRegon)) ||
        !Object.hasOwn(provenanceLabels, row.regonProvenance),
    )
  ) {
    throw new Error("PREPARATION_EXPORT_INPUT_INVALID");
  }
  const orderedRows = [...input.rows].sort((left, right) => left.rowNumber - right.rowNumber);
  if (new Set(orderedRows.map((row) => row.rowNumber)).size !== orderedRows.length) {
    throw new Error("PREPARATION_EXPORT_DUPLICATE_ROW");
  }
  const actualCounts = {
    ready: orderedRows.filter((row) => row.status === "ready").length,
    review: orderedRows.filter((row) => row.status === "review").length,
    skippedNoIdentifiers: orderedRows.filter((row) => row.status === "skipped_no_identifiers").length,
    duplicates: orderedRows.filter((row) => row.status === "duplicate").length,
    waitingRegistry: orderedRows.filter((row) => row.status === "waiting_registry").length,
  };
  if (Object.entries(actualCounts).some(([key, count]) => input.counts[key as keyof typeof actualCounts] !== count)) {
    throw new Error("PREPARATION_EXPORT_COUNTS_MISMATCH");
  }
  const snapshots = orderedRows.map((row) => ({ row, source: parseSourceSnapshot(row.sourceSnapshot) }));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Goldis Ubezpieczenia";
  workbook.subject = `Oczyszczony zestaw — rewizja ${input.revision}`;
  workbook.created = new Date(input.sealedAt);

  const workingSet = workbook.addWorksheet("Zestaw roboczy");
  configureSheet(workingSet, [
    { header: "Wiersz źródłowy", key: "rowNumber", width: 16 },
    { header: "Rewizja wiersza", key: "rowVersion", width: 16 },
    { header: "Firma", key: "companyName", width: 38 },
    { header: "Osoba decyzyjna", key: "decisionMakerName", width: 28 },
    { header: "Komórka", key: "mobile", width: 18 },
    { header: "Telefon", key: "phone", width: 18 },
    { header: "Email", key: "email", width: 30 },
    { header: "NIP", key: "nip", width: 16 },
    { header: "REGON użyty", key: "regon", width: 16 },
    { header: "Źródło REGON", key: "regonProvenance", width: 24 },
    { header: "Adres", key: "address", width: 32 },
    { header: "Kod pocztowy", key: "postalCode", width: 16 },
    { header: "Miasto", key: "city", width: 24 },
  ]);
  for (const { row, source } of snapshots.filter(({ row }) => row.status === "ready")) {
    workingSet.addRow({
      rowNumber: row.rowNumber,
      rowVersion: row.expectedRowVersion,
      companyName: cellText(source.companyName),
      decisionMakerName: cellText(source.decisionMakerName),
      nip: cellText(row.normalizedNip ?? source.nipRaw),
      mobile: cellText(source.mobile),
      phone: cellText(source.phone),
      email: cellText(source.email),
      regon: cellText(row.effectiveRegon ?? ""),
      regonProvenance: provenanceLabels[row.regonProvenance],
      address: cellText(source.address),
      postalCode: cellText(source.postalCode),
      city: cellText(source.city),
    });
  }
  addFullSheetFilter(workingSet);

  const decisionMap = workbook.addWorksheet("Mapa i uwagi");
  configureSheet(decisionMap, [
    { header: "Wiersz źródłowy", key: "rowNumber", width: 16 },
    { header: "Rewizja wiersza", key: "rowVersion", width: 16 },
    { header: "Status", key: "status", width: 32 },
    { header: "Powód", key: "reason", width: 28 },
    { header: "Kod powodu", key: "reasonCode", width: 28 },
    { header: "Reprezentant — wiersz", key: "representative", width: 24 },
    { header: "W zestawie roboczym", key: "included", width: 22 },
    { header: "Firma", key: "companyName", width: 38 },
    { header: "Osoba decyzyjna", key: "decisionMakerName", width: 28 },
    { header: "Komórka", key: "mobile", width: 18 },
    { header: "Telefon", key: "phone", width: 18 },
    { header: "Email", key: "email", width: 30 },
    { header: "NIP z importu", key: "nipRaw", width: 18 },
    { header: "NIP znormalizowany", key: "normalizedNip", width: 22 },
    { header: "REGON z importu", key: "regonRaw", width: 18 },
    { header: "REGON użyty", key: "regon", width: 16 },
    { header: "Źródło REGON", key: "regonProvenance", width: 24 },
    { header: "Adres", key: "address", width: 32 },
    { header: "Kod pocztowy", key: "postalCode", width: 16 },
    { header: "Miasto", key: "city", width: 24 },
    { header: "Uwagi źródłowe", key: "issues", width: 38 },
  ]);
  for (const { row, source } of snapshots) {
    decisionMap.addRow({
      rowNumber: row.rowNumber,
      rowVersion: row.expectedRowVersion,
      status: statusLabels[row.status],
      reason: cellText(
        row.reasonCode
          ? (reasonLabels[row.reasonCode] ?? "Wymaga dodatkowej kontroli.")
          : "Dane przechodzą kontrolę przygotowania.",
      ),
      reasonCode: cellText(row.reasonCode),
      representative: row.representativeRowNumber ?? "",
      included: row.status === "ready" ? "Tak" : "Nie",
      companyName: cellText(source.companyName),
      decisionMakerName: cellText(source.decisionMakerName),
      nipRaw: cellText(source.nipRaw),
      mobile: cellText(source.mobile),
      phone: cellText(source.phone),
      email: cellText(source.email),
      normalizedNip: cellText(row.normalizedNip),
      regonRaw: cellText(source.regonRaw),
      regon: cellText(row.effectiveRegon),
      regonProvenance: provenanceLabels[row.regonProvenance],
      address: cellText(source.address),
      postalCode: cellText(source.postalCode),
      city: cellText(source.city),
      issues: cellText(source.issues.join(", ")),
    });
  }
  addFullSheetFilter(decisionMap);

  const summary = workbook.addWorksheet("Informacje");
  summary.columns = [{ width: 30 }, { width: 64 }];
  summary.addRows([
    ["Pole", "Wartość"],
    ["Plik źródłowy", cellText(input.fileName)],
    ["Rewizja przygotowania", input.revision],
    ["Wersja reguł", cellText(input.rulesVersion)],
    ["Odcisk migawki źródła", input.sourceFingerprint],
    ["Zamknięto", new Date(input.sealedAt).toISOString()],
    ["Wszystkie wiersze", orderedRows.length],
    ["W zestawie roboczym", actualCounts.ready],
    ["Do kontroli", actualCounts.review],
    ["Duplikaty pominięte", actualCounts.duplicates],
    ["Bez NIP i REGON — pominięte", actualCounts.skippedNoIdentifiers],
    ["Oczekujące na REGON — pominięte", actualCounts.waitingRegistry],
    ["Wyłączone — pominięte", orderedRows.filter((row) => row.status === "excluded").length],
  ]);
  summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summary.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF183A36" } };
  summary.views = [{ state: "frozen", ySplit: 1 }];

  const baseName = input.fileName.replace(/\.xlsx$/i, "");
  const fileName = sanitizePublicFileName(
    `${baseName}_oczyszczony_r${input.revision}.xlsx`,
    `zestaw_r${input.revision}.xlsx`,
  );
  return {
    fileName,
    bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
    rowCount: orderedRows.length,
    includedCount: actualCounts.ready,
  };
}
