import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportFileName,
  assessRegonEnrichmentEligibility,
  canTransitionRunStatus,
  deriveEffectiveRegon,
  isTerminalRunStatus,
  isValidPesel,
  normalizeNip,
  normalizeRegon,
  parsePolishDate,
  policyMatchesDate,
  todayInWarsaw,
  validateIdentityMatchV1,
  validateOcSnapshotV1,
  validateRunInputV1,
  validateRunResultV1,
  transitionRunStatus,
  type IdentityMatchV1,
  type OcPolicy,
  type RunInputV1,
  type RunStatus,
} from "./index";

test("REGON zachowuje zero wiodące, a ośmiocyfrowy wymaga przeglądu", () => {
  assert.deepEqual(normalizeRegon("012345678"), { raw: "012345678", normalized: "012345678", issues: [] });
  assert.deepEqual(normalizeRegon(12345678).issues, ["REGON_POSSIBLE_LOST_LEADING_ZERO"]);
  assert.deepEqual(normalizeRegon(null).issues, ["REGON_EMPTY"]);
  assert.deepEqual(normalizeRegon("  ").issues, ["REGON_EMPTY"]);
});

test("effectiveRegon pochodzi z importu lub zatwierdzonej korekty i nie zmienia raw", () => {
  assert.deepEqual(deriveEffectiveRegon({ regonRaw: "012345678", importedRegon: "012345678" }), {
    regonRaw: "012345678", effectiveRegon: "012345678", source: "import",
  });
  assert.deepEqual(deriveEffectiveRegon({
    regonRaw: "12345678", importedRegon: null, approvedCorrection: "012345678",
  }), { regonRaw: "12345678", effectiveRegon: "012345678", source: "approved_correction" });
  assert.deepEqual(deriveEffectiveRegon({ regonRaw: "12345678", importedRegon: null }), {
    regonRaw: "12345678", effectiveRegon: null, source: "none",
  });
  assert.throws(() => deriveEffectiveRegon({ regonRaw: "x", importedRegon: null, approvedCorrection: "12345678" }), /EFFECTIVE_REGON_CORRECTION_INVALID/);
});

test("NIP zachowuje zera, dopuszcza separatory i odrzuca błędną sumę kontrolną", () => {
  assert.equal(normalizeNip("123-456-32-18").normalized, "1234563218");
  assert.deepEqual(normalizeNip("1234563219").issues, ["NIP_CHECKSUM_INVALID"]);
  assert.deepEqual(normalizeNip("123456321").issues, ["NIP_INVALID_FORMAT"]);
  assert.equal(normalizeNip("0123456789").raw, "0123456789");
});

test("NIP→REGON dopuszcza wyłącznie pusty REGON i poprawny NIP bez utraty zera", () => {
  assert.deepEqual(assessRegonEnrichmentEligibility({ regonRaw: "", effectiveRegon: null, nipRaw: "0123456789" }), {
    eligible: true, nipNormalized: "0123456789",
  });
  assert.deepEqual(assessRegonEnrichmentEligibility({ regonRaw: "  ", effectiveRegon: null, nipRaw: "123-456-32-18" }), {
    eligible: true, nipNormalized: "1234563218",
  });
  assert.deepEqual(assessRegonEnrichmentEligibility({ regonRaw: "", effectiveRegon: null, nipRaw: "" }), {
    eligible: false, reasonCode: "NIP_INVALID", issueCode: "NIP_EMPTY",
  });
  assert.deepEqual(assessRegonEnrichmentEligibility({ regonRaw: "", effectiveRegon: null, nipRaw: "1234563219" }), {
    eligible: false, reasonCode: "NIP_INVALID", issueCode: "NIP_CHECKSUM_INVALID",
  });
  assert.deepEqual(assessRegonEnrichmentEligibility({ regonRaw: "12345678", effectiveRegon: null, nipRaw: "0123456789" }), {
    eligible: false, reasonCode: "REGON_REQUIRES_REVIEW", issueCode: "REGON_POSSIBLE_LOST_LEADING_ZERO",
  });
  assert.deepEqual(assessRegonEnrichmentEligibility({ regonRaw: "012345678", effectiveRegon: "012345678", nipRaw: "0123456789" }), {
    eligible: false, reasonCode: "REGON_PRESENT", issueCode: null,
  });
});

test("daty ochrony są porównywane włącznie z dniem granicznym", () => {
  const policy = { coverageTo: "29.09.2026" } as OcPolicy;
  assert.equal(policyMatchesDate(policy, "2026-09-29"), true);
  assert.equal(policyMatchesDate(policy, "2026-09-30"), false);
  assert.equal(parsePolishDate("29.02.2024"), "2024-02-29");
  assert.equal(parsePolishDate("29.02.2025"), null);
});

test("data w Warszawie jest niezależna od strefy serwera", () => {
  assert.equal(todayInWarsaw(new Date("2026-09-28T22:30:00Z")), "2026-09-29");
});

test("nazwa eksportu zawiera osobę decyzyjną i usuwa znaki niedozwolone", () => {
  assert.equal(exportFileName("012345678", "Firma / Transport: A", "Jan / Kowalski"), "012345678_Firma _ Transport_ A_Jan _ Kowalski.xlsx");
  assert.equal(exportFileName("012345678", "Firma", "  "), "012345678_Firma.xlsx");
  assert.equal(exportFileName("012345678", "Firma", null), "012345678_Firma.xlsx");
  assert.equal(exportFileName("012345678", "Firma", "Jan 12345678901 Kowalski"), "012345678_Firma_Jan ukryto Kowalski.xlsx");
  assert.throws(() => exportFileName("012345678", " ", "Jan Kowalski"), /EXPORT_NAME_INCOMPLETE/);
});

test("RunInputV1 odrzuca nieprawidłowe UUID, wersję i datę przed wejściem do workera", () => {
  const input: RunInputV1 = {
    schemaVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    sourceRowId: "22222222-2222-4222-8222-222222222222",
    batchId: "33333333-3333-4333-8333-333333333333",
    referenceDate: "2026-09-29",
    toolId: "oc-policy-verification",
  };
  assert.deepEqual(validateRunInputV1(input), input);
  assert.throws(() => validateRunInputV1({ ...input, runId: "bad-id" }), /CONTRACT_RUN_INPUT_INVALID/);
  assert.throws(() => validateRunInputV1({ ...input, referenceDate: "29.09.2026" }), /CONTRACT_RUN_INPUT_INVALID/);
  assert.throws(() => validateRunInputV1({ ...input, schemaVersion: 2 }), /CONTRACT_RUN_INPUT_INVALID/);
});

test("PESEL requires checksum and a real birth date in every encoded century", () => {
  const complete = (prefix: string) => {
    const sum = [...prefix].reduce((total, digit, index) => total + Number(digit) * [1, 3, 7, 9, 1, 3, 7, 9, 1, 3][index], 0);
    return `${prefix}${(10 - sum % 10) % 10}`;
  };
  for (const prefix of ["9081010001", "9001010001", "9021010001", "9041010001", "9061010001", "0022290001"]) {
    assert.equal(isValidPesel(complete(prefix)), true);
  }
  for (const prefix of ["9000010001", "9013010001", "9001000001", "9002310001", "0122290001", "0042290001"]) {
    assert.equal(isValidPesel(complete(prefix)), false);
  }
  for (const value of [null, 90010100016, "00000000000", "90010100015", "9001010001", "900101000160"]) assert.equal(isValidPesel(value), false);
});

test("IdentityMatchV1 wymaga identyfikatorów firmy i pełnego formatu PESEL", () => {
  const identity: IdentityMatchV1 = {
    schemaVersion: 1,
    sourceRowId: "22222222-2222-4222-8222-222222222222",
    regon: "012345678",
    companyName: "Fikcyjny Transport Testowy",
    firstName: "Jan",
    lastName: "Testowy",
    pesel: "90010100016",
    matchMethod: "unique_business_identity",
    adapterVersion: "fixture-1",
  };
  assert.deepEqual(validateIdentityMatchV1(identity), identity);
  assert.throws(() => validateIdentityMatchV1({ ...identity, regon: "12345678" }), /CONTRACT_IDENTITY_MATCH_INVALID/);
  assert.throws(() => validateIdentityMatchV1({ ...identity, pesel: "12345" }), /CONTRACT_IDENTITY_MATCH_INVALID/);
});

test("OcSnapshotV1 wymaga zgodnej liczby wierszy, unikalnych pozycji i poprawnej daty końca", () => {
  const policy: OcPolicy = {
    sourceOrdinal: 1,
    insuredName: "Fikcyjna Osoba",
    policyTypeAndNumber: "OC TEST-1",
    contractType: "OC",
    insuredClaimCount: 0,
    vehicleRegistration: "TEST001",
    vehicleGroup: "Test",
    vehicleMake: "Fikcyjna",
    vehicleModel: "Model",
    insurer: "Test ZU",
    coverageFrom: "2025-09-29",
    coverageTo: "2026-09-29",
  };
  const snapshot = {
    schemaVersion: 1 as const,
    totalCount: 1,
    policies: [policy],
    capturedAt: "2026-09-29T12:00:00.000Z",
    parserVersion: "fixture-1",
  };
  assert.deepEqual(validateOcSnapshotV1(snapshot), snapshot);
  assert.throws(() => validateOcSnapshotV1({ ...snapshot, totalCount: 2 }), /CONTRACT_OC_SNAPSHOT_INVALID/);
  assert.throws(() => validateOcSnapshotV1({ ...snapshot, policies: [policy, policy], totalCount: 2 }), /CONTRACT_OC_SNAPSHOT_DUPLICATE_POSITION/);
  assert.throws(() => validateOcSnapshotV1({ ...snapshot, policies: [{ ...policy, coverageTo: "31.02.2026" }] }), /CONTRACT_OC_SNAPSHOT_INVALID/);
});

test("RunResultV1 nie pozwala ukończyć runu bez pliku ani zgłosić pustego wyniku z polisą", () => {
  const base = {
    schemaVersion: 1 as const,
    runId: "11111111-1111-4111-8111-111111111111",
    referenceDate: "2026-09-29",
    totalOcCount: 49,
  };
  assert.equal(validateRunResultV1({ ...base, outcome: "completed", currentOcCount: 3, artifactId: "44444444-4444-4444-8444-444444444444" }).outcome, "completed");
  assert.equal(validateRunResultV1({ ...base, outcome: "no_matching_policies", currentOcCount: 0, artifactId: null }).outcome, "no_matching_policies");
  assert.throws(() => validateRunResultV1({ ...base, outcome: "completed", currentOcCount: 3, artifactId: null }), /CONTRACT_RUN_RESULT_INVALID/);
  assert.throws(() => validateRunResultV1({ ...base, outcome: "no_matching_policies", currentOcCount: 1, artifactId: null }), /CONTRACT_RUN_RESULT_INVALID/);
});

test("przejścia runu blokują cofnięcie i stany terminalne", () => {
  const allowed: [RunStatus, RunStatus][] = [
    ["queued", "validating"],
    ["pzu_login", "waiting_for_sms"],
    ["waiting_for_sms", "compensa_login"],
    ["reading_oc", "no_matching_policies"],
    ["export_ready", "completed"],
  ];
  for (const [from, to] of allowed) assert.equal(canTransitionRunStatus(from, to), true, `${from} -> ${to}`);
  assert.equal(canTransitionRunStatus("queued", "completed"), false);
  assert.equal(canTransitionRunStatus("completed", "queued"), false);
  assert.equal(canTransitionRunStatus("failed", "validating"), false);
  assert.equal(isTerminalRunStatus("no_matching_policies"), true);
  assert.equal(isTerminalRunStatus("waiting_for_sms"), false);
  assert.equal(transitionRunStatus("queued", "validating"), "validating");
  assert.equal(transitionRunStatus("export_ready", "completed", { artifactId: "44444444-4444-4444-8444-444444444444" }), "completed");
  assert.throws(() => transitionRunStatus("queued", "completed"), /RUN_STATUS_TRANSITION_INVALID/);
  assert.throws(() => transitionRunStatus("export_ready", "completed"), /RUN_COMPLETED_ARTIFACT_REQUIRED/);
});
