import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

const maxSelection = 500;

export type RunSubmissionSelection = Readonly<{ rowNumbers: readonly number[] }>;
export type SelectionInput = Readonly<{ rowNumbers?: unknown; fromRow?: unknown; toRow?: unknown }>;

export function digestSubmissionValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function parseRunSubmissionSelection(value: SelectionInput): RunSubmissionSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Nieprawidłowy wybór wierszy");
  const keys = Object.keys(value);
  const hasRows = Object.hasOwn(value, "rowNumbers");
  const hasRange = Object.hasOwn(value, "fromRow") || Object.hasOwn(value, "toRow");
  if (keys.some((key) => !["rowNumbers", "fromRow", "toRow"].includes(key)) || hasRows === hasRange) {
    throw new BadRequestException("Wybierz listę wierszy albo jeden zakres");
  }
  let rowNumbers: number[];
  if (hasRows) {
    if (
      !Array.isArray(value.rowNumbers) ||
      value.rowNumbers.length < 1 ||
      value.rowNumbers.length > maxSelection ||
      value.rowNumbers.some((item) => !Number.isSafeInteger(item) || Number(item) < 2)
    ) {
      throw new BadRequestException("Lista musi zawierać od 1 do 500 poprawnych numerów wiersza");
    }
    rowNumbers = value.rowNumbers as number[];
    if (new Set(rowNumbers).size !== rowNumbers.length)
      throw new BadRequestException("Lista wierszy zawiera duplikaty");
  } else {
    const from = value.fromRow;
    const to = value.toRow;
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      Number(from) < 2 ||
      Number(to) < Number(from) ||
      Number(to) - Number(from) + 1 > maxSelection
    ) {
      throw new BadRequestException("Zakres musi obejmować od 1 do 500 wierszy Excela");
    }
    rowNumbers = Array.from({ length: Number(to) - Number(from) + 1 }, (_, index) => Number(from) + index);
  }
  return { rowNumbers: rowNumbers.sort((a, b) => a - b) };
}

export function runSubmissionRequestHash(batchId: string, selection: RunSubmissionSelection): string {
  return digestSubmissionValue({ batchId, rowNumbers: selection.rowNumbers });
}
