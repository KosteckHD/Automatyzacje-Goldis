import { normalizeNip, normalizeRegon, type SourceRow } from "@goldis/core";
import { normalizeBusinessName } from "../../contracts/registry-result";

export type PreparationRowStatus = "ready" | "review" | "skipped_no_identifiers" | "duplicate" | "waiting_registry";

export type PreparationSourceRow = SourceRow &
  Readonly<{
    sourceRowId: string;
    rowVersion: number;
  }>;

export type PreparationRowAnalysis = Readonly<{
  sourceRowId: string;
  rowNumber: number;
  expectedRowVersion: number;
  status: PreparationRowStatus;
  reasonCode: string | null;
  representativeRowNumber: number | null;
  normalizedName: string | null;
  normalizedNip: string | null;
  effectiveRegon: string | null;
  completeness: number;
}>;

type NormalizedRow = Readonly<{
  source: PreparationSourceRow;
  name: string | null;
  nip: string | null;
  regon: string | null;
  regonRawPresent: boolean;
  nipRawPresent: boolean;
  baseStatus: PreparationRowStatus;
  baseReason: string | null;
  completeness: number;
}>;

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedPerson(value: string | null): string | null {
  if (!value?.trim()) return null;
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("pl-PL")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function baseAnalysis(source: PreparationSourceRow): NormalizedRow {
  if (
    !Number.isSafeInteger(source.rowNumber) ||
    source.rowNumber < 2 ||
    !Number.isSafeInteger(source.rowVersion) ||
    source.rowVersion < 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.sourceRowId)
  ) {
    throw new Error("PREPARATION_SOURCE_ROW_INVALID");
  }
  const name = normalizeBusinessName(source.companyName);
  const nipRawPresent = nonEmpty(source.nipRaw);
  const nip = normalizeNip(source.nipRaw).normalized;
  const rawRegon = nonEmpty(source.effectiveRegon) ? source.effectiveRegon : source.regonRaw;
  const regonRawPresent = nonEmpty(rawRegon);
  const regon = normalizeRegon(rawRegon).normalized;
  const hasIdentifier = Boolean(nip || regon || nipRawPresent || regonRawPresent);
  const formulaIssue = source.issues.includes("REGON_FORMULA_NOT_ALLOWED");
  const otherBlockingIssue = source.issues.find((issue) => !["REGON_EMPTY", "DUPLICATE_SOURCE_ROW"].includes(issue));

  let baseStatus: PreparationRowStatus;
  let baseReason: string | null;
  if (!hasIdentifier) {
    baseStatus = "skipped_no_identifiers";
    baseReason = "NO_NIP_OR_REGON";
  } else if (formulaIssue) {
    baseStatus = "review";
    baseReason = "REGON_FORMULA_NOT_ALLOWED";
  } else if (regonRawPresent && !regon) {
    baseStatus = "review";
    baseReason = normalizeRegon(rawRegon).issues[0] ?? "REGON_INVALID";
  } else if (nipRawPresent && !nip) {
    baseStatus = "review";
    baseReason = normalizeNip(source.nipRaw).issues[0] ?? "NIP_INVALID";
  } else if (!name) {
    baseStatus = "review";
    baseReason = "NAME_EMPTY";
  } else if (otherBlockingIssue) {
    baseStatus = "review";
    baseReason = otherBlockingIssue;
  } else if (regon) {
    baseStatus = "ready";
    baseReason = null;
  } else if (nip) {
    baseStatus = "waiting_registry";
    baseReason = "REGON_LOOKUP_REQUIRED";
  } else {
    baseStatus = "review";
    baseReason = "IDENTIFIER_INVALID";
  }

  const completeness =
    Number(Boolean(regon)) * 64 +
    Number(Boolean(nip)) * 32 +
    Number(Boolean(name)) * 16 +
    Number(nonEmpty(source.decisionMakerName)) * 8 +
    Number(nonEmpty(source.address)) * 4 +
    Number(nonEmpty(source.postalCode)) * 2 +
    Number(nonEmpty(source.city));
  return { source, name, nip, regon, regonRawPresent, nipRawPresent, baseStatus, baseReason, completeness };
}

function addToIndex(index: Map<string, NormalizedRow[]>, key: string | null, row: NormalizedRow): void {
  if (!key) return;
  const values = index.get(key) ?? [];
  values.push(row);
  index.set(key, values);
}

function distinct(values: Array<string | null>): Set<string> {
  return new Set(values.filter((value): value is string => value !== null));
}

function representative(rows: readonly NormalizedRow[]): NormalizedRow {
  return [...rows].sort(
    (left, right) =>
      right.completeness - left.completeness ||
      left.source.rowNumber - right.source.rowNumber ||
      left.source.sourceRowId.localeCompare(right.source.sourceRowId),
  )[0];
}

/**
 * Computes a deterministic first/second-pass view of every source row without
 * modifying the import. Persistence/sealing and registry execution belong to
 * ImportPreparationService, which consumes this pure result.
 */
export function analyzePreparationRows(sourceRows: readonly PreparationSourceRow[]): PreparationRowAnalysis[] {
  const rows = sourceRows.map(baseAnalysis).sort((left, right) => left.source.rowNumber - right.source.rowNumber);
  if (
    new Set(rows.map((row) => row.source.rowNumber)).size !== rows.length ||
    new Set(rows.map((row) => row.source.sourceRowId)).size !== rows.length
  ) {
    throw new Error("PREPARATION_SOURCE_ROWS_NOT_UNIQUE");
  }

  const nipIndex = new Map<string, NormalizedRow[]>();
  const regonIndex = new Map<string, NormalizedRow[]>();
  const identityGroups = new Map<string, NormalizedRow[]>();
  for (const row of rows) {
    addToIndex(nipIndex, row.nip, row);
    addToIndex(regonIndex, row.regon, row);
    if (row.name && row.nip) addToIndex(identityGroups, `NIP:${row.nip}|${row.name}`, row);
    if (row.name && row.regon) addToIndex(identityGroups, `REGON:${row.regon}|${row.name}`, row);
  }

  const conflicts = new Map<string, string>();
  const markIdentityConflicts = (index: Map<string, NormalizedRow[]>, kind: "NIP" | "REGON") => {
    for (const group of index.values()) {
      if (group.length < 2) continue;
      const names = distinct(group.map((row) => row.name));
      const identifiers =
        kind === "NIP" ? distinct(group.map((row) => row.regon)) : distinct(group.map((row) => row.nip));
      const conflict = names.size > 1 || identifiers.size > 1;
      if (conflict) for (const row of group) conflicts.set(row.source.sourceRowId, "IDENTITY_CONFLICT");
    }
  };
  markIdentityConflicts(nipIndex, "NIP");
  markIdentityConflicts(regonIndex, "REGON");

  const outputById = new Map<string, PreparationRowAnalysis>();
  const visited = new Set<string>();
  for (const row of rows) {
    if (visited.has(row.source.sourceRowId)) continue;
    const group = new Map<string, NormalizedRow>();
    const pending = [row];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      if (group.has(current.source.sourceRowId)) continue;
      group.set(current.source.sourceRowId, current);
      visited.add(current.source.sourceRowId);
      const keys = [
        current.name && current.nip ? `NIP:${current.nip}|${current.name}` : null,
        current.name && current.regon ? `REGON:${current.regon}|${current.name}` : null,
      ].filter((key): key is string => key !== null);
      for (const key of keys)
        for (const sibling of identityGroups.get(key) ?? []) {
          if (!group.has(sibling.source.sourceRowId)) pending.push(sibling);
        }
    }
    const members = [...group.values()].sort((left, right) => left.source.rowNumber - right.source.rowNumber);
    const groupHasConflict = members.some((item) => conflicts.has(item.source.sourceRowId));
    if (groupHasConflict) {
      for (const item of members) {
        outputById.set(item.source.sourceRowId, {
          sourceRowId: item.source.sourceRowId,
          rowNumber: item.source.rowNumber,
          expectedRowVersion: item.source.rowVersion,
          status: "review",
          reasonCode: "IDENTITY_CONFLICT",
          representativeRowNumber: null,
          normalizedName: item.name,
          normalizedNip: item.nip,
          effectiveRegon: item.regon,
          completeness: item.completeness,
        });
      }
      continue;
    }
    const people = new Map<string, NormalizedRow[]>();
    const unnamedPeople: NormalizedRow[] = [];
    for (const item of members) {
      const person = normalizedPerson(item.source.decisionMakerName);
      if (!person) unnamedPeople.push(item);
      else addToIndex(people, person, item);
    }
    const cohorts = [...people.values()];
    // Missing contacts form their own cohort; never attach them to a named person.
    if (unnamedPeople.length) cohorts.push(unnamedPeople);
    for (const cohort of cohorts) {
      const chosen = cohort.length > 1 ? representative(cohort) : cohort[0];
      for (const item of cohort) {
        const isDuplicate = item.source.sourceRowId !== chosen.source.sourceRowId;
        outputById.set(item.source.sourceRowId, {
          sourceRowId: item.source.sourceRowId,
          rowNumber: item.source.rowNumber,
          expectedRowVersion: item.source.rowVersion,
          status: isDuplicate ? "duplicate" : item.baseStatus,
          reasonCode: isDuplicate ? "DUPLICATE_SOURCE_ROW" : item.baseReason,
          representativeRowNumber: isDuplicate ? chosen.source.rowNumber : null,
          normalizedName: item.name,
          normalizedNip: item.nip,
          effectiveRegon: item.regon,
          completeness: item.completeness,
        });
      }
    }
  }
  return rows.map((row) => {
    const analysis = outputById.get(row.source.sourceRowId);
    if (!analysis) throw new Error("PREPARATION_ANALYSIS_ROW_MISSING");
    return analysis;
  });
}
