import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptIdentityPesel, encryptIdentityForPersistence, validateIdentityMatchV1 } from "./index";

const sourceRowId = "22222222-2222-4222-8222-222222222222";
const runId = "11111111-1111-4111-8111-111111111111";
const base = { schemaVersion: 1, sourceRowId, regon: "012345678", companyName: "Synthetic Company", firstName: "", lastName: "", pesel: "", adapterVersion: "fixture-v3" };
test("a company uses REGON, has no invented PESEL, and rejects mixed person facts", () => {
  const company = validateIdentityMatchV1({ ...base, matchMethod: "regon_company" });
  const encrypted = encryptIdentityForPersistence(company, runId, {});
  assert.equal(encrypted.peselCiphertext, null); assert.equal(encrypted.peselKeyVersion, null);
  assert.equal(decryptIdentityPesel(encrypted, { runId, sourceRowId }, {}), "");
  assert.throws(() => validateIdentityMatchV1({ ...company, pesel: company.regon }), /CONTRACT_IDENTITY/);
  assert.throws(() => validateIdentityMatchV1({ ...company, firstName: "Invented" }), /CONTRACT_IDENTITY/);
  assert.throws(() => decryptIdentityPesel({ ...encrypted, matchMethod: "unique_business_identity" }, { runId, sourceRowId }, {}), /PESEL_CIPHERTEXT/);
});
test("a pending person needs a valid PESEL and both names are confirmed together", () => {
  const pending = { ...base, pesel: "90010100016", matchMethod: "regon_unique_pesel" };
  assert.equal(validateIdentityMatchV1(pending).matchMethod, "regon_unique_pesel");
  assert.throws(() => validateIdentityMatchV1({ ...pending, pesel: "012345678" }), /CONTRACT_IDENTITY/);
  assert.throws(() => validateIdentityMatchV1({ ...pending, firstName: "Partial" }), /CONTRACT_IDENTITY/);
  assert.throws(() => validateIdentityMatchV1({ ...pending, matchMethod: "unique_business_identity" }), /CONTRACT_IDENTITY/);
});
