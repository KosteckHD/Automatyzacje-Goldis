import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOcRows, selectCurrentPolicies, type OcTableRow } from "./oc";
import { policyMatchesDate } from "@goldis/core";

function row(ordinal: number, end: string, registration: string): OcTableRow {
  return [String(ordinal), "Osoba", `OC ${ordinal}`, "Nowa", "0", registration,
    "Samochód", "Marka", "Model", "ZU", "2026-01-01", end, ""];
}

test("cała tabela OC jest odczytana; numer wejściowy nie filtruje polis", () => {
  const source = Array.from({ length: 49 }, (_, i) => row(i + 1, i < 46 ? "2026-09-28" : "2026-09-29", `INNY${i + 1}`));
  const policies = parseOcRows(source, 49);
  const current = selectCurrentPolicies(policies, "2026-09-29");
  assert.equal(policies.length, 49);
  assert.equal(current.length, 3);
  assert.deepEqual(current.map((policy) => policy.sourceOrdinal), [47, 48, 49]);
  assert.equal(current.every((policy) => policy.vehicleRegistration?.startsWith("INNY")), true);
  assert.equal(policies[0].insuredClaimCount, 0);
});

test("niepełna tabela, zła data i zdublowana pozycja blokują wynik", () => {
  assert.throws(() => parseOcRows([row(1, "2026-09-29", "ABC")], 2), /UFG_INCOMPLETE/);
  assert.throws(() => parseOcRows([row(1, "brak", "ABC")], 1), /COVERAGE_TO_INVALID/);
  assert.throws(() => parseOcRows([row(1, "2026-09-29", "ABC"), row(1, "2026-09-29", "XYZ")], 2), /UFG_ORDINAL_INVALID/);
});

test("OC parser rejects impossible dates, unsafe numbers, missing policy numbers and wrong schemas", () => {
  const good = row(1, "2026-10-09", "SYNTH");
  for (const [column, value, error] of [
    [0, "9007199254740992", /UFG_ORDINAL_INVALID/], [0, "0", /UFG_ORDINAL_INVALID/],
    [2, " ", /UFG_POLICY_NUMBER_MISSING/], [4, "9007199254740992", /UFG_CLAIMS_INVALID/],
    [4, "-1", /UFG_CLAIMS_INVALID/], [10, "29.02.2026", /COVERAGE_FROM_INVALID/],
    [11, "31.04.2026", /COVERAGE_TO_INVALID/],
  ] as const) {
    const invalid = [...good]; invalid[column] = value;
    assert.throws(() => parseOcRows([invalid], 1), error);
  }
  assert.throws(() => parseOcRows([good.slice(0, 12)], 1), /UFG_SCHEMA_CHANGED/);
  assert.throws(() => parseOcRows([], Number.MAX_SAFE_INTEGER + 1), /UFG_COUNT_INVALID/);
  assert.deepEqual(parseOcRows([], 0), []);
});

test("confirmed end-date rule includes the boundary and future starts, with normalized and validated dates", () => {
  const policies = parseOcRows([
    row(1, "2026-10-08", "EXPIRED"), row(2, "09.10.2026", "BOUNDARY"),
    row(3, "2026-10-10", "FUTURE"), row(4, "2028-02-29", "LEAP"),
  ], 4);
  policies[2].coverageFrom = "2026-10-10";
  assert.deepEqual(selectCurrentPolicies(policies, "2026-10-09").map(policy => policy.sourceOrdinal), [2, 3, 4]);
  assert.deepEqual(selectCurrentPolicies(policies, "09.10.2026").map(policy => policy.sourceOrdinal), [2, 3, 4]);
  assert.equal(policyMatchesDate(policies[3], "29.02.2028"), true);
  assert.equal(policyMatchesDate(policies[3], "2028-03-01"), false);
  assert.throws(() => policyMatchesDate(policies[1], "2026-02-29"), /REFERENCE_DATE_INVALID/);
  assert.throws(() => policyMatchesDate({ ...policies[1], coverageTo: "2026-02-29" }, "2026-10-09"), /COVERAGE_TO_INVALID/);
});
