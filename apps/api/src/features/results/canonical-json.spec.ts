import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJsonStringify } from "./canonical-json";

test("kanoniczny JSON ignoruje kolejność kluczy obiektu, lecz zachowuje kolejność polis", () => {
  const original = {
    companyFields: { schemaVersion: 2, companyName: "Firma", mobile: "501123456" },
    policies: [
      { sourceOrdinal: 0, vehicleRegistration: "WA12345" },
      { sourceOrdinal: 1, vehicleRegistration: "KR12345" },
    ],
  };
  const jsonbRoundTrip = {
    policies: [
      { vehicleRegistration: "WA12345", sourceOrdinal: 0 },
      { vehicleRegistration: "KR12345", sourceOrdinal: 1 },
    ],
    companyFields: { mobile: "501123456", companyName: "Firma", schemaVersion: 2 },
  };
  assert.equal(canonicalJsonStringify(original), canonicalJsonStringify(jsonbRoundTrip));
  assert.notEqual(
    canonicalJsonStringify(original),
    canonicalJsonStringify({
      ...original,
      policies: [...original.policies].reverse(),
    }),
  );
});
