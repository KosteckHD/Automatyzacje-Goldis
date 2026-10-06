import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryProviderResult } from "./registry-provider";
import { assessRegistryResult } from "./registry-result";

const nip = "0000000000";
const companyName = "Fikcyjny Podmiot Łódź";

function providerResult(candidates: readonly Readonly<Record<string, unknown>>[]): RegistryProviderResult {
  return {
    providerName: "synthetic-registry",
    providerVersion: "fixture-1",
    dataVersion: "fixture-data-1",
    fetchedAt: new Date("2026-01-15T12:00:00.000Z"),
    candidates,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return { nip, regon: "012345678", name: companyName, ...overrides };
}

test("T-REG-04: zero wyników oznacza not_found i nie proponuje REGON-u", () => {
  assert.deepEqual(assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([]),
  }), { status: "not_found", reasonCode: "NO_RESULTS" });
});

test("pojedynczy zgodny rekord dopuszcza REGON 9 lub 14 cyfr i zachowuje zera", () => {
  const nineDigits = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: "  FIKCYJNY   PODMIOT-ŁÓDŹ ",
    result: providerResult([candidate()]),
  });
  assert.deepEqual(nineDigits, {
    status: "matched", nipNormalized: nip, regon: "012345678", registryName: companyName,
  });

  const fourteenDigits = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([candidate({ regon: "00123456789012" })]),
  });
  assert.deepEqual(fourteenDigits, {
    status: "matched", nipNormalized: nip, regon: "00123456789012", registryName: companyName,
  });
});

test("T-REG-05: wiele wyników lub jawna jednostka lokalna trafia do przeglądu bez wyboru", () => {
  const multiple = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([candidate(), candidate({ regon: "00123456789012", unitType: "LOCAL" })]),
  });
  assert.deepEqual(multiple, { status: "ambiguous", reasonCode: "MULTIPLE_CANDIDATES", candidateCount: 2 });

  const local = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([candidate({ isLocalUnit: true, parentRegon: "123456789" })]),
  });
  assert.deepEqual(local, { status: "ambiguous", reasonCode: "LOCAL_UNIT", candidateCount: 1 });
});

test("T-REG-06: niezgodny NIP lub nazwa to konflikt do przeglądu, bez wyboru REGON-u", () => {
  const nipConflict = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([candidate({ nip: "0000000017" })]),
  });
  assert.equal(nipConflict.status, "manual_review");
  assert.equal(nipConflict.reasonCode, "RESULT_NIP_MISMATCH");

  const nameConflict = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([candidate({ name: "Inny Fikcyjny Podmiot" })]),
  });
  assert.equal(nameConflict.status, "manual_review");
  assert.equal(nameConflict.reasonCode, "RESULT_NAME_MISMATCH");
});

test("wadliwy NIP, nazwa lub REGON wymaga kontroli i nie normalizuje błędnych danych na siłę", () => {
  const invalidNip = assessRegistryResult({
    expectedNip: nip, expectedCompanyName: companyName,
    result: providerResult([candidate({ nip: "123" })]),
  });
  assert.equal(invalidNip.status, "manual_review");
  assert.equal(invalidNip.reasonCode, "RESULT_NIP_INVALID");

  const missingName = assessRegistryResult({
    expectedNip: nip, expectedCompanyName: companyName,
    result: providerResult([candidate({ name: " " })]),
  });
  assert.equal(missingName.status, "manual_review");
  assert.equal(missingName.reasonCode, "RESULT_NAME_INVALID");

  for (const regon of ["12345678", "1234567890123", 123456789]) {
    const invalidRegon = assessRegistryResult({
      expectedNip: nip, expectedCompanyName: companyName,
      result: providerResult([candidate({ regon })]),
    });
    assert.equal(invalidRegon.status, "manual_review");
    assert.equal(invalidRegon.reasonCode, "RESULT_REGON_INVALID");
  }
});

test("niepoprawny input i uszkodzony rekord nie tworzą automatycznego wyniku", () => {
  const invalidInput = assessRegistryResult({
    expectedNip: "123",
    expectedCompanyName: companyName,
    result: providerResult([candidate()]),
  });
  assert.equal(invalidInput.status, "manual_review");
  assert.equal(invalidInput.reasonCode, "INPUT_NIP_INVALID");

  const malformed = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([null as unknown as Record<string, unknown>]),
  });
  assert.equal(malformed.status, "manual_review");
  assert.equal(malformed.reasonCode, "RESULT_SHAPE_INVALID");

  const invalidUnitMetadata = assessRegistryResult({
    expectedNip: nip,
    expectedCompanyName: companyName,
    result: providerResult([candidate({ unitType: false })]),
  });
  assert.equal(invalidUnitMetadata.status, "manual_review");
  assert.equal(invalidUnitMetadata.reasonCode, "RESULT_SHAPE_INVALID");
});
