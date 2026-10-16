import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePreparationRows, type PreparationSourceRow } from "./preparation-analysis";

function sourceRow(rowNumber: number, values: Partial<PreparationSourceRow> = {}): PreparationSourceRow {
  const serial = String(rowNumber).padStart(12, "0");
  return {
    sourceRowId: `00000000-0000-4000-8000-${serial}`,
    rowNumber,
    rowVersion: 1,
    companyName: "FIRMA TESTOWA",
    decisionMakerName: "Jan Kowalski",
    nipRaw: "",
    address: "",
    postalCode: "",
    city: "",
    regonRaw: "",
    regon: null,
    effectiveRegon: null,
    issues: [],
    ...values,
  };
}

test("preparation przypisuje każdemu wierszowi jedną kategorię i nie wysyła bezidentyfikatorowego do lookupu", () => {
  const result = analyzePreparationRows([
    sourceRow(2, { companyName: "", issues: ["NAME_EMPTY", "REGON_EMPTY"] }),
    sourceRow(3, { nipRaw: "123-456-32-18" }),
    sourceRow(4, { regonRaw: "001234567", regon: "001234567", effectiveRegon: "001234567" }),
    sourceRow(5, { nipRaw: "1234563219" }),
    sourceRow(6, { regonRaw: "12345678", nipRaw: "0123456789" }),
  ]);
  assert.deepEqual(
    result.map((row) => [row.rowNumber, row.status, row.reasonCode]),
    [
      [2, "skipped_no_identifiers", "NO_NIP_OR_REGON"],
      [3, "waiting_registry", "REGON_LOOKUP_REQUIRED"],
      [4, "ready", null],
      [5, "review", "NIP_CHECKSUM_INVALID"],
      [6, "review", "REGON_POSSIBLE_LOST_LEADING_ZERO"],
    ],
  );
  assert.equal(result.length, 5);
  assert.equal(new Set(result.map((row) => row.sourceRowId)).size, 5);
});

test("preparation deduplikuje identyczną tożsamość wybierając pełniejszego reprezentanta", () => {
  const result = analyzePreparationRows([
    sourceRow(2, { nipRaw: "1234563218" }),
    sourceRow(3, {
      nipRaw: "1234563218",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: "Jan Kowalski",
      address: "Testowa 1",
      postalCode: "00-001",
      city: "Warszawa",
    }),
    sourceRow(4, { nipRaw: "1234563218", regonRaw: "001234567", regon: "001234567", effectiveRegon: "001234567" }),
  ]);
  assert.deepEqual(
    result.map((row) => [row.rowNumber, row.status, row.reasonCode, row.representativeRowNumber]),
    [
      [2, "duplicate", "DUPLICATE_SOURCE_ROW", 3],
      [3, "ready", null, null],
      [4, "duplicate", "DUPLICATE_SOURCE_ROW", 3],
    ],
  );
});

test("remis duplikatu rozstrzyga deterministycznie najniższy numer wiersza", () => {
  const result = analyzePreparationRows([
    sourceRow(8, { companyName: "Firma Łódź", regonRaw: "001234567", regon: "001234567", effectiveRegon: "001234567" }),
    sourceRow(2, { companyName: "Firma Łódź", regonRaw: "001234567", regon: "001234567", effectiveRegon: "001234567" }),
  ]);
  assert.deepEqual(
    result.map((row) => [row.rowNumber, row.status, row.representativeRowNumber]),
    [
      [2, "ready", null],
      [8, "duplicate", 2],
    ],
  );
});

test("preparation zatrzymuje kolizje identyfikatorów firmy", () => {
  const result = analyzePreparationRows([
    sourceRow(2, { nipRaw: "1234563218", companyName: "Firma A" }),
    sourceRow(3, { nipRaw: "1234563218", companyName: "Firma B" }),
    sourceRow(4, { regonRaw: "987654321", regon: "987654321", effectiveRegon: "987654321", nipRaw: "0123456789" }),
    sourceRow(5, { regonRaw: "987654321", regon: "987654321", effectiveRegon: "987654321", nipRaw: "1234563218" }),
  ]);
  assert.deepEqual(
    result.map((row) => [row.rowNumber, row.status, row.reasonCode]),
    [
      [2, "review", "IDENTITY_CONFLICT"],
      [3, "review", "IDENTITY_CONFLICT"],
      [4, "review", "IDENTITY_CONFLICT"],
      [5, "review", "IDENTITY_CONFLICT"],
    ],
  );
});

test("preparation zachowuje różne osoby kontaktowe, a deduplikuje powtórkę tej samej osoby", () => {
  const result = analyzePreparationRows([
    sourceRow(2, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: "Anna Nowak",
    }),
    sourceRow(3, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: "Jan Kowalski",
    }),
    sourceRow(4, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: " anna   nowak ",
    }),
  ]);
  assert.deepEqual(
    result.map((row) => [row.rowNumber, row.status, row.reasonCode, row.representativeRowNumber]),
    [
      [2, "ready", null, null],
      [3, "ready", null, null],
      [4, "duplicate", "DUPLICATE_SOURCE_ROW", 2],
    ],
  );
});

test("wiersz bez osoby nie jest automatycznie przypisywany do jednej z kilku osób", () => {
  const result = analyzePreparationRows([
    sourceRow(2, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: "Anna Nowak",
    }),
    sourceRow(3, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: "Jan Kowalski",
    }),
    sourceRow(4, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: null,
    }),
  ]);
  assert.deepEqual(
    result.map((row) => [row.rowNumber, row.status, row.reasonCode]),
    [
      [2, "ready", null],
      [3, "ready", null],
      [4, "ready", null],
    ],
  );
});

test("brak osoby kontaktowej nie blokuje poprawnej firmy i nie dołącza jej do nazwanej osoby", () => {
  const result = analyzePreparationRows([
    sourceRow(2, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: "Anna Nowak",
    }),
    sourceRow(3, {
      nipRaw: "0123456789",
      regonRaw: "001234567",
      regon: "001234567",
      effectiveRegon: "001234567",
      decisionMakerName: null,
    }),
  ]);
  assert.deepEqual(
    result.map(({ status, reasonCode }) => [status, reasonCode]),
    [
      ["ready", null],
      ["ready", null],
    ],
  );
});

test("wiersz bez identyfikatorów jest pomijany także wtedy, gdy nie podano osoby", () => {
  const [row] = analyzePreparationRows([
    sourceRow(2, { companyName: "", decisionMakerName: null, issues: ["NAME_EMPTY", "REGON_EMPTY"] }),
  ]);
  assert.deepEqual([row.status, row.reasonCode], ["skipped_no_identifiers", "NO_NIP_OR_REGON"]);
});

test("preparation zachowuje rewizję wiersza i odrzuca powtórne klucze wejściowe", () => {
  const single = analyzePreparationRows([sourceRow(2, { rowVersion: 7, nipRaw: "1234563218" })]);
  assert.equal(single[0].expectedRowVersion, 7);
  assert.throws(
    () => analyzePreparationRows([sourceRow(2), sourceRow(2, { sourceRowId: "00000000-0000-4000-8000-000000000099" })]),
    /PREPARATION_SOURCE_ROWS_NOT_UNIQUE/,
  );
  assert.throws(
    () => analyzePreparationRows([sourceRow(2), sourceRow(3, { sourceRowId: sourceRow(2).sourceRowId })]),
    /PREPARATION_SOURCE_ROWS_NOT_UNIQUE/,
  );
});

test("preparation nie zgaduje wyniku z komórki REGON zawierającej formułę", () => {
  const [row] = analyzePreparationRows([sourceRow(2, { nipRaw: "1234563218", issues: ["REGON_FORMULA_NOT_ALLOWED"] })]);
  assert.equal(row.status, "review");
  assert.equal(row.reasonCode, "REGON_FORMULA_NOT_ALLOWED");
});
