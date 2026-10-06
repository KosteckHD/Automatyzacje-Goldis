import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOcRows, selectCurrentPolicies, type OcTableRow } from "./oc";

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
